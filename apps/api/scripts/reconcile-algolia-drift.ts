/**
 * reconcile-algolia-drift.ts — operator-invokable Algolia index-drift report +
 * orphan sweep for a DEPLOYED D1 (AECI-266; §23.1 / CICD_PLAN §3.2).
 *
 * The orphan-removal RULE lives once in the DI'd core `src/lib/algolia-orphans.ts`
 * (`sweepAlgoliaOrphans`) — the same core the 09:00 Worker drift cron runs. This
 * script is the CI/CLI CALLER: it builds the authoritative promoted-id SETS from a
 * deployed D1 — which a plain Node process can only reach through
 * `wrangler d1 execute --remote`, not a Worker `env.DB` binding — then browses each
 * Algolia index and deletes the objects with no promoted D1 row (the orphans the
 * watermark sync structurally can't see to delete).
 *
 * Drift (per entity) = promoted-rows(D1) − objects(Algolia). Negative drift =
 * orphans → this removes them. Positive drift = records MISSING from the index →
 * NOT this tool's job (re-run the 08:00 incremental sync); the report surfaces it.
 *
 * Default is a DRY-RUN (report only, delete nothing). `--apply` removes orphans;
 * the core's safety cap refuses an unexpectedly large purge unless `--force`.
 *
 * Usage:
 *   # report-only (dry-run) against a deployed env — needs CLOUDFLARE_API_TOKEN + ALGOLIA_*:
 *   ALGOLIA_APP_ID=… ALGOLIA_ADMIN_KEY=<per-env management key> CLOUDFLARE_API_TOKEN=… \
 *     pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env staging
 *   # remove the orphans (deliberate):
 *   … pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env staging --apply
 *   # large/intended purge that exceeds the safety cap:
 *   … --env staging --apply --force
 *   # production --apply requires the extra guard flag:
 *   … --env production --apply --allow-production
 *   # against the seeded local D1 (no token; for testing the query):
 *   pnpm --filter @aeci/api db:reconcile-algolia-drift -- --local
 *
 * Emits the gauges `aeci.algolia.index_drift` (signed, per entity — the existing
 * §23.1 monitor) and `aeci.algolia.orphans_removed` (per entity) when DD_API_KEY is
 * set, mirroring the Worker `submitGauge` payload (that helper is ctx/Request-bound).
 */

import { spawnSync } from 'node:child_process';

import { DEFAULT_LOCALE, type AlgoliaEnv } from '@aeci/shared/algolia';

import {
  createAlgoliaDeleteClient,
  createAlgoliaObjectIdClient,
  DEFAULT_SAFETY_CAP,
  formatOrphanTable,
  sweepAlgoliaOrphans,
  type OrphanSweepResult,
  type PromotedIdProvider,
} from '../src/lib/algolia-orphans';

// ─── Authoritative promoted-id queries ───────────────────────────────────────
// Plain `SELECT id` — only the membership rule, no transforms (that's what keeps
// the orphan path ADR-0016-safe). The integration query reproduces the
// both-endpoints-promoted filter `algolia-sync` / `drizzleDriftCounter` use.
const PRODUCT_IDS_SQL = `SELECT "id" AS id FROM "products" WHERE "promotion_status" = 'promoted';`;
const VENDOR_IDS_SQL = `SELECT "id" AS id FROM "vendors" WHERE "promotion_status" = 'promoted';`;
const INTEGRATION_IDS_SQL = `SELECT i."id" AS id FROM "integrations" i
  WHERE i."source_product_id" IN (SELECT "id" FROM "products" WHERE "promotion_status" = 'promoted')
    AND i."target_product_id" IN (SELECT "id" FROM "products" WHERE "promotion_status" = 'promoted');`;

// ─── Arg + target resolution ─────────────────────────────────────────────────

function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

interface Target {
  /** Datadog `env:` tag + display label. */
  label: string;
  /** D1 database name (`wrangler.jsonc` `d1_databases[].database_name`). */
  db: string;
  /** Extra wrangler flags selecting local vs remote+env. */
  flags: string[];
  remote: boolean;
  /** The Algolia env whose index set (`<prefix>_<entity>`) is swept. */
  algoliaEnv: AlgoliaEnv;
}

function resolveTarget(argv: string[]): Target {
  if (argv.includes('--local')) {
    return {
      label: 'preview',
      db: 'aeci-app-preview',
      flags: ['--local'],
      remote: false,
      algoliaEnv: 'preview',
    };
  }
  const env = (readValueFlag(argv, '--env') ?? process.env.RECONCILE_ENV ?? '').trim();
  if (env !== 'staging' && env !== 'production') {
    throw new Error(
      `Set --env staging|production (or RECONCILE_ENV), or pass --local for the seeded local D1. Got: ${env || '(unset)'}.`,
    );
  }
  return {
    label: env,
    db: `aeci-app-${env}`,
    flags: ['--env', env, '--remote'],
    remote: true,
    algoliaEnv: env,
  };
}

// ─── Wrangler I/O ────────────────────────────────────────────────────────────

interface D1ExecResult<T> {
  results: T[];
  success: boolean;
}

/** `wrangler d1 execute --json` prints `[{results, success, meta}, …]`; tolerate a
 *  leading banner by parsing from the first `[`. (Mirrors reconcile-product-counts.ts.) */
function parseWranglerJson<T>(stdout: string): D1ExecResult<T>[] {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON):\n${stdout}`);
  return JSON.parse(stdout.slice(start)) as D1ExecResult<T>[];
}

function wranglerMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

const WRANGLER_HINT =
  'Run via pnpm so wrangler is on PATH:\n  pnpm --filter @aeci/api db:reconcile-algolia-drift';

function queryIds(target: Target, sql: string): Set<string> {
  const res = spawnSync(
    'wrangler',
    ['d1', 'execute', target.db, ...target.flags, '--json', '--command', sql],
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
      `Could not read promoted ids from D1 "${target.db}" (wrangler exit ${res.status}).\n${hint}\n\n${res.stderr}`,
    );
  }
  const rows = parseWranglerJson<{ id: string }>(res.stdout)[0]?.results ?? [];
  return new Set(rows.map((r) => r.id));
}

/** A `PromotedIdProvider` backed by `wrangler d1 execute` (the deployed-D1 reach a
 *  Node process has, since there's no Worker `env.DB` binding here). */
function wranglerPromotedIds(target: Target): PromotedIdProvider {
  return {
    productIds: async () => queryIds(target, PRODUCT_IDS_SQL),
    vendorIds: async () => queryIds(target, VENDOR_IDS_SQL),
    integrationIds: async () => queryIds(target, INTEGRATION_IDS_SQL),
  };
}

// ─── Datadog ─────────────────────────────────────────────────────────────────

/** POST the per-entity `aeci.algolia.index_drift` (signed `promoted − indexed`,
 *  the existing §23.1 monitor) and `aeci.algolia.orphans_removed` gauges. The
 *  shared `submitGauge` needs a Worker ctx/Request, so the CLI posts directly with
 *  the same v2-series payload. Best-effort: observability never fails the run. */
async function emitGauges(result: OrphanSweepResult, env: string): Promise<void> {
  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) return;
  const site = process.env.DD_SITE || 'us5.datadoghq.com';
  const ts = Math.floor(Date.now() / 1000);
  const baseTags = [
    'app:aeci',
    'service:aeci-api',
    'worker:aeci-api',
    `env:${env}`,
    'source:reconcile',
  ];
  const series = result.entities.flatMap((e) => {
    const tags = [...baseTags, `entity:${e.entity}`, `index:${e.indexName}`];
    return [
      {
        metric: 'aeci.algolia.index_drift',
        type: 3,
        points: [{ timestamp: ts, value: e.promotedCount - e.indexCount }],
        tags,
      },
      {
        metric: 'aeci.algolia.orphans_removed',
        type: 3,
        points: [{ timestamp: ts, value: e.deleted }],
        tags,
      },
    ];
  });
  try {
    const res = await fetch(`https://api.${site}/api/v2/series`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'dd-api-key': apiKey },
      body: JSON.stringify({ series }),
    });
    if (!res.ok) console.warn(`Datadog gauge POST returned ${res.status}.`);
  } catch (err) {
    console.warn(`Datadog gauge POST failed: ${(err as Error).message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
  const locale = readValueFlag(argv, '--locale') ?? DEFAULT_LOCALE;
  const target = resolveTarget(argv);

  const appId = process.env.ALGOLIA_APP_ID;
  const apiKey = process.env.ALGOLIA_ADMIN_KEY;
  if (!appId || !apiKey) {
    // Graceful skip (exit 0) — matches algolia:apply-settings and keeps the
    // report-only CI step non-blocking when ALGOLIA_* are unset.
    console.warn(
      '⚠  ALGOLIA_APP_ID / ALGOLIA_ADMIN_KEY unset — skipping Algolia orphan sweep (no-op).',
    );
    return 0;
  }
  if (target.remote && !process.env.CLOUDFLARE_API_TOKEN) {
    console.warn('⚠  CLOUDFLARE_API_TOKEN is unset — wrangler --remote will fail to authenticate.');
  }
  if (target.label === 'production' && apply && !argv.includes('--allow-production')) {
    console.error(
      'Refusing to --apply against PRODUCTION without --allow-production (live search index). Re-run with both flags if intended.',
    );
    return 1;
  }

  console.log(
    `Algolia orphan sweep on ${target.db} (algolia env ${target.algoliaEnv}, locale ${locale})${
      target.remote ? `, remote --env ${target.label}` : ', local'
    } — ${apply ? (force ? 'APPLY --force' : 'APPLY') : 'dry-run'}…`,
  );

  const result = await sweepAlgoliaOrphans(
    {
      ids: wranglerPromotedIds(target),
      browse: createAlgoliaObjectIdClient(appId, apiKey),
      remove: createAlgoliaDeleteClient({ appId, apiKey }),
    },
    {
      env: target.algoliaEnv,
      locale,
      apply,
      safetyCap: { ...DEFAULT_SAFETY_CAP, override: force },
    },
  );

  console.log(formatOrphanTable(result));
  for (const e of result.entities) {
    if (e.orphanIds.length > 0) {
      console.log(`  ${e.indexName} orphan objectIDs: ${e.orphanIds.join(', ')}`);
    }
  }

  await emitGauges(result, target.label);

  const failed = result.entities.filter((e) => !e.ok);
  const capped = result.entities.filter((e) => e.skippedBySafetyCap);

  if (failed.length > 0) {
    console.error(
      `✗ ${failed.length} index(es) errored: ${failed.map((e) => `${e.indexName} (${e.error})`).join(', ')}`,
    );
    return 1;
  }
  if (capped.length > 0) {
    // Only reachable under --apply: the cap refused a large purge.
    console.error(
      `✗ ${capped.length} index(es) exceeded the safety cap (${capped.map((e) => e.indexName).join(', ')}). Re-run with --force if this purge is intended.`,
    );
    return 1;
  }
  if (result.totalOrphans === 0) {
    console.log('✓ No Algolia orphans — every index object maps to a promoted D1 row.');
    return 0;
  }
  if (apply) {
    console.log(`✓ Removed ${result.totalDeleted} orphan object(s) across ${target.algoliaEnv}.`);
    return 0;
  }
  // Dry-run with orphans: report-only (exit 0 preserves the non-blocking CI
  // contract; the Datadog gauges/monitor are the alert). Re-run with --apply.
  console.log(
    `Found ${result.totalOrphans} orphan object(s) (dry-run). Re-run with --apply to remove them.`,
  );
  return 0;
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
