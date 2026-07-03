/**
 * reconcile-product-counts.ts — denormalized product-count drift guard for D1
 * (AECI-104 successor; ADR 0016 / AECI-253). Drizzle/D1 replacement for the
 * Prisma-era script of the same name deleted in the D1 migration (#359).
 *
 * The drift RULE lives once in `src/lib/recompute-counts.ts` (`diffProductCounts`
 * / `findProductCountDrift`). This script is the CI/CLI CALLER: it runs the
 * equivalent aggregation against a DEPLOYED D1 — which a plain Node process can
 * only reach through `wrangler d1 execute --remote`, not a Worker `env.DB`
 * binding — then compares stored vs recomputed and reports.
 *
 * Drift = a product whose stored `integration_count` / `review_count` /
 * `rating_*_avg` disagree with a recompute from the source `integrations` /
 * `reviews` rows — i.e. a write path mutated those without the post-batch
 * `recomputeProductCounts()` landing. Under D1 that recompute is a separate,
 * non-atomic write AFTER the mutating batch commits (recompute-counts.ts header),
 * so a brief lag is expected and this scheduled guard is the backstop.
 *
 * Scheduled daily, report-only, against staging + production by
 * `.github/workflows/reconcile-counts.yml`.
 *
 * Usage:
 *   # report-only (exit 1 on drift) against a deployed env — needs CLOUDFLARE_API_TOKEN:
 *   RECONCILE_ENV=staging CLOUDFLARE_API_TOKEN=… pnpm --filter @aeci/api db:reconcile-counts
 *   # repair in place (deliberate; NEVER in CI):
 *   RECONCILE_ENV=staging CLOUDFLARE_API_TOKEN=… pnpm --filter @aeci/api db:reconcile-counts -- --fix
 *   # against the local seeded D1 (no token; for testing the query):
 *   pnpm --filter @aeci/api db:reconcile-counts -- --local
 *
 * Emits the Datadog gauge `aeci.product_counts.drift` (count of drifted products;
 * 0 on a clean run) when DD_API_KEY is set, mirroring the Worker `submitGauge`
 * payload (packages/shared/src/datadog.ts) since that helper is ctx/Request-bound.
 */

import { spawnSync } from 'node:child_process';

import {
  diffProductCounts,
  type ExpectedProductCounts,
  type ProductCountDrift,
  type StoredProductCounts,
} from '../src/lib/recompute-counts';

// ─── Drift query ─────────────────────────────────────────────────────────────
// Per-product: the STORED aggregates alongside the EXPECTED values recomputed
// from source rows. The comparison (counts exact; averages 2dp/0.005 tolerance,
// null-aware) is done in TS by `diffProductCounts`, NOT in SQL, so the rule stays
// single-sourced and unit-tested. Mirrors `computeExpected` in recompute-counts.ts.
const DRIFT_QUERY = `SELECT
  p."id" AS product_id,
  p."integration_count" AS stored_integration_count,
  (SELECT COUNT(*) FROM "integrations" i
     WHERE i."source_product_id" = p."id" OR i."target_product_id" = p."id") AS expected_integration_count,
  p."review_count" AS stored_review_count,
  (SELECT COUNT(*) FROM "reviews" r
     WHERE r."product_id" = p."id" AND r."status" = 'approved') AS expected_review_count,
  p."rating_overall_avg" AS stored_rating_overall_avg,
  (SELECT ROUND(AVG(r."rating_overall"), 2) FROM "reviews" r
     WHERE r."product_id" = p."id" AND r."status" = 'approved') AS expected_rating_overall_avg,
  p."rating_onboarding_avg" AS stored_rating_onboarding_avg,
  (SELECT ROUND(AVG(r."rating_onboarding"), 2) FROM "reviews" r
     WHERE r."product_id" = p."id" AND r."status" = 'approved') AS expected_rating_onboarding_avg
FROM "products" p;`;

// `--fix` repair: recompute ALL four aggregates in place for the drifted ids.
// Same aggregation as DRIFT_QUERY's expected columns + the seed-reviews
// RECOMPUTE_PRODUCTS block. `__IDS__` is replaced with a quoted id list.
const RECOMPUTE_SQL = `UPDATE "products" SET
  "integration_count" = (SELECT COUNT(*) FROM "integrations" i
     WHERE i."source_product_id" = "products"."id" OR i."target_product_id" = "products"."id"),
  "review_count" = (SELECT COUNT(*) FROM "reviews" r
     WHERE r."product_id" = "products"."id" AND r."status" = 'approved'),
  "rating_overall_avg" = (SELECT ROUND(AVG(r."rating_overall"), 2) FROM "reviews" r
     WHERE r."product_id" = "products"."id" AND r."status" = 'approved'),
  "rating_onboarding_avg" = (SELECT ROUND(AVG(r."rating_onboarding"), 2) FROM "reviews" r
     WHERE r."product_id" = "products"."id" AND r."status" = 'approved')
WHERE "id" IN (__IDS__);`;

interface RawDriftRow {
  product_id: string;
  stored_integration_count: number;
  expected_integration_count: number;
  stored_review_count: number;
  expected_review_count: number;
  stored_rating_overall_avg: number | null;
  expected_rating_overall_avg: number | null;
  stored_rating_onboarding_avg: number | null;
  expected_rating_onboarding_avg: number | null;
}

/** Map raw D1 rows → the shared `diffProductCounts` rule. Exported for tests. */
export function evaluateDrift(rows: RawDriftRow[]): ProductCountDrift[] {
  const drift: ProductCountDrift[] = [];
  for (const r of rows) {
    const stored: StoredProductCounts = {
      integrationCount: r.stored_integration_count,
      reviewCount: r.stored_review_count,
      ratingOverallAvg: r.stored_rating_overall_avg,
      ratingOnboardingAvg: r.stored_rating_onboarding_avg,
    };
    const expected: ExpectedProductCounts = {
      integrationCount: r.expected_integration_count,
      reviewCount: r.expected_review_count,
      ratingOverallAvg: r.expected_rating_overall_avg,
      ratingOnboardingAvg: r.expected_rating_onboarding_avg,
    };
    drift.push(...diffProductCounts(r.product_id, stored, expected));
  }
  return drift;
}

// ─── Target resolution ───────────────────────────────────────────────────────

interface Target {
  /** Datadog `env:` tag + display label. */
  label: string;
  /** D1 database name (`wrangler.jsonc` `d1_databases[].database_name`). */
  db: string;
  /** Extra wrangler flags selecting local vs remote+env. */
  flags: string[];
  remote: boolean;
}

function resolveTarget(argv: string[]): Target {
  if (argv.includes('--local')) {
    return {
      label: process.env.DD_ENV ?? 'preview',
      db: 'aeci-app-preview',
      flags: ['--local'],
      remote: false,
    };
  }
  const env = (process.env.RECONCILE_ENV ?? '').trim();
  if (env !== 'staging' && env !== 'production') {
    throw new Error(
      `Set RECONCILE_ENV=staging|production (or pass --local for the seeded local D1). Got: ${env || '(unset)'}.`,
    );
  }
  return { label: env, db: `aeci-app-${env}`, flags: ['--env', env, '--remote'], remote: true };
}

// ─── Wrangler I/O ────────────────────────────────────────────────────────────

interface D1ExecResult<T> {
  results: T[];
  success: boolean;
}

/** `wrangler d1 execute --json` prints `[{results, success, meta}, …]` to stdout;
 * tolerate any leading banner by parsing from the first `[`. (Mirrors the helper
 * in seed-reviews.ts.) */
function parseWranglerJson<T>(stdout: string): D1ExecResult<T>[] {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON):\n${stdout}`);
  return JSON.parse(stdout.slice(start)) as D1ExecResult<T>[];
}

function wranglerMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

const WRANGLER_HINT =
  'Run via pnpm so wrangler is on PATH:\n  pnpm --filter @aeci/api db:reconcile-counts';

function runQuery(target: Target): RawDriftRow[] {
  const res = spawnSync(
    'wrangler',
    ['d1', 'execute', target.db, ...target.flags, '--json', '--command', DRIFT_QUERY],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (res.error) {
    if (wranglerMissing(res.error)) throw new Error(`\`wrangler\` not found. ${WRANGLER_HINT}`);
    throw res.error;
  }
  if (res.status !== 0) {
    const hint = target.remote
      ? `Check CLOUDFLARE_API_TOKEN (Account→D1→Read) + CLOUDFLARE_ACCOUNT_ID, and that "${target.db}" exists for --env ${target.label}.`
      : 'Set up the local D1 first:  pnpm --filter @aeci/api db:setup:local';
    throw new Error(
      `Could not read product counts from D1 "${target.db}" (wrangler exit ${res.status}).\n${hint}\n\n${res.stderr}`,
    );
  }
  return parseWranglerJson<RawDriftRow>(res.stdout)[0]?.results ?? [];
}

function applyFix(target: Target, productIds: string[]): void {
  if (productIds.length === 0) return;
  const inList = productIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(', ');
  const sql = RECOMPUTE_SQL.replace('__IDS__', inList);
  const res = spawnSync(
    'wrangler',
    ['d1', 'execute', target.db, ...target.flags, '--command', sql],
    {
      stdio: 'inherit',
    },
  );
  if (res.error) {
    if (wranglerMissing(res.error)) throw new Error(`\`wrangler\` not found. ${WRANGLER_HINT}`);
    throw res.error;
  }
  if (res.status !== 0) throw new Error(`--fix recompute failed (wrangler exit ${res.status}).`);
}

// ─── Datadog ─────────────────────────────────────────────────────────────────

/** POST the `aeci.product_counts.drift` gauge (count of drifted products). The
 * shared `submitGauge` (packages/shared/src/datadog.ts) needs a Worker
 * ctx/Request, so the CLI posts directly with the same v2-series payload shape.
 * Best-effort: observability never fails the reconcile. */
async function emitDriftGauge(value: number, env: string): Promise<void> {
  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) return;
  const site = process.env.DD_SITE || 'us5.datadoghq.com';
  const payload = {
    series: [
      {
        metric: 'aeci.product_counts.drift',
        type: 3, // gauge — DD_METRIC_TYPE_GAUGE in packages/shared/src/datadog.ts
        points: [{ timestamp: Math.floor(Date.now() / 1000), value }],
        tags: [
          'app:aeci',
          'service:aeci-api',
          'worker:aeci-api',
          'locale:en-US',
          `env:${env}`,
          'source:reconcile',
        ],
      },
    ],
  };
  try {
    const res = await fetch(`https://api.${site}/api/v2/series`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'dd-api-key': apiKey },
      body: JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`Datadog gauge POST returned ${res.status}.`);
  } catch (err) {
    console.warn(`Datadog gauge POST failed: ${(err as Error).message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function fmt(v: number | null): string {
  return v === null ? 'NULL' : String(v);
}

export async function main(argv: string[]): Promise<number> {
  const fix = argv.includes('--fix');
  const target = resolveTarget(argv);

  if (target.remote && !process.env.CLOUDFLARE_API_TOKEN) {
    console.warn('⚠  CLOUDFLARE_API_TOKEN is unset — wrangler --remote will fail to authenticate.');
  }
  if (target.label === 'production' && fix && !argv.includes('--allow-production')) {
    console.error(
      'Refusing to --fix PRODUCTION without --allow-production (real user content). Re-run with both flags if intended.',
    );
    return 1;
  }

  console.log(
    `Reconciling product counts on ${target.db}${target.remote ? ` (--env ${target.label}, remote)` : ' (local)'}…`,
  );
  let drift = evaluateDrift(runQuery(target));

  if (drift.length > 0 && fix) {
    const ids = [...new Set(drift.map((d) => d.productId))];
    console.log(`Repairing ${ids.length} product(s) with --fix…`);
    applyFix(target, ids);
    drift = evaluateDrift(runQuery(target)); // re-check after repair
  }

  const driftedProducts = new Set(drift.map((d) => d.productId)).size;
  await emitDriftGauge(driftedProducts, target.label);

  if (drift.length === 0) {
    console.log('✓ No product-count drift.');
    return 0;
  }

  console.error(
    `✗ Product-count drift on ${driftedProducts} product(s) (${drift.length} field(s)):`,
  );
  for (const d of drift) {
    console.error(
      `  ${d.productId}  ${d.field}: stored=${fmt(d.stored)} expected=${fmt(d.expected)}`,
    );
  }
  if (!fix) {
    console.error('\nRepair (deliberate; never in CI) against the affected env:');
    console.error(
      `  RECONCILE_ENV=${target.label} CLOUDFLARE_API_TOKEN=… pnpm --filter @aeci/api db:reconcile-counts -- --fix`,
    );
    console.error('See docs/DATABASE_SCHEMA.md §11.2 and apps/api/src/lib/recompute-counts.ts.');
  }
  return 1;
}

// Entrypoint guard — importing this module (e.g. in tests) must not run main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
