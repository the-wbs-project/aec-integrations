/**
 * Review seeder — DEV/DEMO ONLY (Node CLI; not a migration, not Worker runtime).
 *
 * Inserts ~150–200 realistic, AEC-flavored reviews across the EXISTING products
 * so an operator can preview a "fully going" catalog: rating summaries, the
 * 5-review averages threshold, pagination, and a realistic mix of busy vs. quiet
 * products. Every seeded review is ANONYMOUS (`reviewer_id = NULL`) and APPROVED,
 * so no Supabase auth / profiles seeding is needed and the public review cards
 * (which render no reviewer name) look identical to real ones.
 *
 * The deterministic PLAN + SQL generation now lives in `@aeci/shared/seed-reviews`
 * (so the `apps/datatool` Worker can reuse it against a D1 binding); this file is
 * the Node CLI shell around it — arg parsing, the `wrangler d1 execute` I/O, and
 * the `.sql` artifact. The same `--seed` produces byte-identical reviews here and
 * in the Worker because both call the shared `buildPlan`.
 *
 * Stack: the app database is Cloudflare D1 (SQLite) + Drizzle (ADR 0016). This is
 * a Node CLI that does NOT touch the Worker — it works the same way the committed
 * seed files do (`seed/taxonomy.sql`, `seed/catalog.sql`, `seed/phase2-fixtures.sql`):
 * it reads the catalog from, and writes the reviews to, the LOCAL D1 via the
 * Wrangler CLI. It is NOT wired into `db:seed:local` on purpose — 150–200 random
 * reviews would move the Lighthouse/e2e fixtures and review-count assertions; this
 * is an on-demand preview tool, run by hand.
 *
 * Target defaults to the LOCAL D1 (`aeci-app-preview`, the `--local` SQLite under
 * .wrangler/). A remote env (`--remote --env staging`) is also supported, for
 * populating a deployed catalog with realistic reviews against its REAL products:
 * reviews are user content, NOT Airtable-promoted data, so they neither come from
 * nor conflict with the `POST /api/promote` refresh. Remote runs need
 * CLOUDFLARE_API_TOKEN (Account→D1→Edit) + CLOUDFLARE_ACCOUNT_ID; production is
 * guarded behind an explicit `--allow-production`. Run
 * `pnpm --filter @aeci/api db:setup:local` first if the LOCAL DB is empty.
 *
 * What it does:
 *   1. reads products (+ their category slugs) from the target D1,
 *   2. builds a deterministic plan (seeded PRNG → stable output per `--seed`),
 *   3. emits an idempotent SQL file (`seed/reviews.sql`, gitignored): a
 *      `DELETE … WHERE id LIKE 'aeceed00-%'` header, the review `INSERT`s, then an
 *      `UPDATE products` recompute of `review_count` + both rating averages,
 *   4. on `--apply`, runs the file through `wrangler d1 execute`.
 *
 * Idempotent + reversible: every seeded row gets a recognizable id prefix
 * (`aeceed00-…`). The file delete-then-inserts that block, so re-running never
 * duplicates, and `--teardown` removes exactly the seeded rows and recomputes.
 *
 * Usage (from repo root or apps/api):
 *   pnpm --filter @aeci/api db:seed-reviews                       # dry-run: plan + write seed/reviews.sql
 *   pnpm --filter @aeci/api db:seed-reviews -- --apply            # write + execute against local D1
 *   pnpm --filter @aeci/api db:seed-reviews -- --teardown --apply # remove seeded rows + recompute
 *   pnpm --filter @aeci/api db:seed-reviews -- --seed=42 --apply  # a different deterministic set
 *
 *   # against a deployed env — reads THAT env's real catalog, then writes to it:
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… \
 *     pnpm --filter @aeci/api db:seed-reviews -- --remote --env staging            # dry-run
 *     pnpm --filter @aeci/api db:seed-reviews -- --remote --env staging --apply    # write
 *     pnpm --filter @aeci/api db:seed-reviews -- --remote --env staging --teardown --apply
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import {
  DISTRIBUTION,
  ID_MARKER,
  Rng,
  buildPlan,
  buildSeedSql,
  buildTeardownSql,
  mulberry32,
  PRODUCTS_QUERY,
  type Plan,
  type ProductInput,
} from '@aeci/shared/seed-reviews';

/** Local D1 database name (the `--local` SQLite). Matches apps/api/wrangler.jsonc
 * + the `db:seed:*:local` scripts. */
const DEFAULT_DB = 'aeci-app-preview';
/** Generated, gitignored SQL artifact. */
const OUT_FILE = 'seed/reviews.sql';

// ─── Args ──────────────────────────────────────────────────────────────────────

interface Args {
  apply: boolean;
  teardown: boolean;
  remote: boolean;
  env: string | undefined;
  allowProduction: boolean;
  db: string;
  out: string;
  seed: number;
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes('--apply');
  const teardown = argv.includes('--teardown');
  const remote = argv.includes('--remote');
  const allowProduction = argv.includes('--allow-production');

  const seedFlag = readValueFlag(argv, '--seed');
  const dbFlag = readValueFlag(argv, '--db');
  const outFlag = readValueFlag(argv, '--out');
  const env = readValueFlag(argv, '--env');

  const seed = seedFlag !== undefined ? Number.parseInt(seedFlag, 10) : 0x5eed;

  // Default DB name follows the env when remote (aeci-app-<env>), else the local DB.
  const db = dbFlag ?? (env ? `aeci-app-${env}` : DEFAULT_DB);

  return { apply, teardown, remote, env, allowProduction, db, out: outFlag ?? OUT_FILE, seed };
}

/** Wrangler flags selecting the target DB: the local SQLite, or a remote env. */
function targetFlags(args: Args): string[] {
  return args.remote ? ['--env', args.env as string, '--remote'] : ['--local'];
}

/** Reads `--name=value` or `--name value`. Returns undefined if absent. */
function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

// ─── Reporting ───────────────────────────────────────────────────────────────────

function printPlanSummary(plan: Plan, products: ProductInput[]): void {
  const counts = [...plan.perProduct.values()];
  const total = plan.reviews.length;
  const bucketsHit = DISTRIBUTION.map((b) => ({
    label: b.label,
    n: counts.filter((c) => c >= b.min && c <= b.max).length,
  }));
  const atZero = counts.filter((c) => c === 0).length;
  const atLeastFive = counts.filter((c) => c >= 5).length;

  console.log(`\nProducts: ${products.length}   Planned reviews: ${total}`);
  console.log('Per-product distribution:');
  for (const b of bucketsHit) console.log(`  ${b.label.padEnd(14)} ${b.n} products`);
  console.log(`  → ${atLeastFive} products reach the ≥5 averages threshold; ${atZero} stay at 0`);

  const ratingHist = [1, 2, 3, 4, 5].map((r) => ({
    r,
    n: plan.reviews.filter((rv) => rv.ratingOverall === r).length,
  }));
  console.log('Overall-rating histogram:');
  for (const h of ratingHist) {
    const bar = '█'.repeat(Math.round((h.n / Math.max(1, total)) * 40));
    console.log(`  ${h.r}★ ${String(h.n).padStart(4)} ${bar}`);
  }
  const verified = plan.reviews.filter((r) => r.verifiedWorkEmail).length;
  console.log(`Verified-work-email badge on ${verified}/${total} reviews.`);

  // A few samples so the operator can eyeball realism.
  const byName = new Map(products.map((p) => [p.id, p.name]));
  console.log('\nSample reviews:');
  for (const rv of plan.reviews.slice(0, 3)) {
    const badge = rv.verifiedWorkEmail ? ' ✓verified' : '';
    console.log(
      `  [${byName.get(rv.productId)}] ${rv.ratingOverall}★/${rv.ratingOnboarding}★${badge} — "${rv.title}"`,
    );
    console.log(`     ${rv.body.slice(0, 96)}${rv.body.length > 96 ? '…' : ''}`);
  }
}

// ─── Local D1 I/O (via Wrangler) ──────────────────────────────────────────────────

interface RawProductRow {
  id: string;
  slug: string;
  name: string;
  category_slugs: string | null;
}

interface D1ExecResult<T> {
  results: T[];
  success: boolean;
}

/** `wrangler d1 execute --json` prints `[{results, success, meta}, …]` to stdout;
 * tolerate any leading banner by parsing from the first `[`. */
function parseWranglerJson<T>(stdout: string): D1ExecResult<T>[] {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON):\n${stdout}`);
  return JSON.parse(stdout.slice(start)) as D1ExecResult<T>[];
}

function wranglerMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

const WRANGLER_HINT =
  'Run it through pnpm so wrangler is on PATH:\n  pnpm --filter @aeci/api db:seed-reviews';

/** Read the catalog from the target D1 (local or `--remote --env`). Throws with a
 * helpful hint if wrangler is missing, the DB is empty/unmigrated, or auth fails. */
function readProductsFromD1(args: Args): ProductInput[] {
  const res = spawnSync(
    'wrangler',
    ['d1', 'execute', args.db, ...targetFlags(args), '--json', '--command', PRODUCTS_QUERY],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.error) {
    if (wranglerMissing(res.error)) throw new Error(`\`wrangler\` not found. ${WRANGLER_HINT}`);
    throw res.error;
  }
  if (res.status !== 0) {
    const hint = args.remote
      ? `Check CLOUDFLARE_API_TOKEN (Account→D1→Edit) + CLOUDFLARE_ACCOUNT_ID, and that "${args.db}" exists for --env ${args.env}.`
      : `Set the local DB up first:  pnpm --filter @aeci/api db:setup:local`;
    throw new Error(
      `Could not read products from D1 "${args.db}" (wrangler exit ${res.status}).\n${hint}\n\n${res.stderr}`,
    );
  }
  const parsed = parseWranglerJson<RawProductRow>(res.stdout);
  const rows = parsed[0]?.results ?? [];
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    categorySlugs: r.category_slugs ? r.category_slugs.split(',') : [],
  }));
}

/** Execute a generated `.sql` file against the target D1 (local or `--remote --env`). */
function applySqlFile(args: Args, file: string): void {
  const res = spawnSync(
    'wrangler',
    ['d1', 'execute', args.db, ...targetFlags(args), `--file=${file}`],
    {
      stdio: 'inherit',
    },
  );
  if (res.error) {
    if (wranglerMissing(res.error)) throw new Error(`\`wrangler\` not found. ${WRANGLER_HINT}`);
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`wrangler d1 execute --file=${file} failed (exit ${res.status}).`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────────

export async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.remote && !args.env) {
    console.error('--remote requires --env <preview|staging|production> (the wrangler.jsonc env).');
    return 1;
  }
  const targetingProd = args.remote && (args.env === 'production' || /prod/i.test(args.db));
  if (targetingProd && !args.allowProduction) {
    console.error(
      'Refusing to seed PRODUCTION. These are synthetic reviews and production carries real\n' +
        'user content. Pass --allow-production only if you are absolutely certain.',
    );
    return 1;
  }

  const mode = args.teardown ? 'TEARDOWN' : args.apply ? 'APPLY' : 'DRY RUN';
  const target = args.remote ? `${args.db} (REMOTE --env ${args.env})` : `${args.db} (local D1)`;
  console.log('── seed-reviews ───────────────────────────────────────────');
  console.log(`Mode:   ${mode}`);
  console.log(`Target: ${target}`);
  console.log(`Seed:   ${args.seed}`);
  console.log(`Out:    ${args.out}`);

  const products = readProductsFromD1(args);
  if (products.length === 0) {
    console.error(
      args.remote
        ? `\nNo products found in "${args.db}" (--env ${args.env}). Has the catalog been promoted there?`
        : '\nNo products found in the local D1 — seed the catalog first:\n' +
            '  pnpm --filter @aeci/api db:setup:local',
    );
    return 1;
  }

  // ── Teardown: remove the seeded block + recompute ─────────────────────────────
  if (args.teardown) {
    writeFileSync(args.out, buildTeardownSql({ db: args.db, seed: args.seed }));
    console.log(`\nWrote teardown SQL → ${args.out}`);
    if (!args.apply) {
      console.log(
        `DRY RUN: would delete reviews with id LIKE '${ID_MARKER}%' and recompute ` +
          `${products.length} products. Re-run with --apply to execute.`,
      );
      return 0;
    }
    applySqlFile(args, args.out);
    console.log('\nRemoved seeded reviews and recomputed product aggregates.');
    return 0;
  }

  // ── Plan + emit ───────────────────────────────────────────────────────────────
  const rng = new Rng(mulberry32(args.seed));
  const plan = buildPlan(products, rng, Date.now());
  printPlanSummary(plan, products);

  writeFileSync(args.out, buildSeedSql(plan, { db: args.db, seed: args.seed }));
  console.log(`\nWrote ${plan.reviews.length} review(s) → ${args.out}`);

  if (!args.apply) {
    const how = args.remote ? `--remote --env ${args.env} --apply` : '--apply';
    console.log(`DRY RUN — nothing executed. Re-run with ${how} to write to ${args.db}.`);
    return 0;
  }

  applySqlFile(args, args.out);
  console.log(
    `\nApplied ${plan.reviews.length} approved review(s) to ${args.db}` +
      `${args.remote ? ` (--env ${args.env})` : ' (local)'}.`,
  );
  if (args.remote) {
    console.log(
      'Edge cache: detail pages are s-maxage=900 (15-min TTL) — purge product cache tags\n' +
        '(POST /admin/purge, see docs/CACHE_STRATEGY.md) or wait it out for rating summaries.\n' +
        'Search: affected products were touched (updated_at), so the daily Algolia sync cron\n' +
        '(08:00 UTC) refreshes review_count/rating in search results on its next run.',
    );
  } else {
    console.log('Product rating summaries are recomputed. View them on `pnpm dev:agent`.');
  }
  return 0;
}

const invokedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  process.argv[1].endsWith('seed-reviews.ts');

if (invokedDirectly) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error('seed-reviews: fatal', err);
      process.exitCode = 1;
    });
}
