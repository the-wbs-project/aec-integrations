/**
 * Review seeder — DEV/DEMO ONLY (not a migration, not Worker runtime).
 *
 * Inserts ~150–200 realistic, AEC-flavored reviews across the EXISTING products
 * so an operator can preview a "fully going" catalog: rating summaries, the
 * 5-review averages threshold, pagination, and a realistic mix of busy vs. quiet
 * products. Every seeded review is ANONYMOUS (`reviewer_id = NULL`) and APPROVED,
 * so no Supabase auth / profiles seeding is needed and the public review cards
 * (which render no reviewer name) look identical to real ones.
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
 *   1. reads products (+ their category slugs) from the local D1,
 *   2. builds a deterministic plan (seeded PRNG → stable output per `--seed`),
 *   3. emits an idempotent SQL file (`seed/reviews.sql`, gitignored): a
 *      `DELETE … WHERE id LIKE 'aeceed00-%'` header, the review `INSERT`s, then an
 *      `UPDATE products` recompute of `review_count` + both rating averages (the
 *      SQL equivalent of `lib/recompute-counts.ts`),
 *   4. on `--apply`, runs the file through `wrangler d1 execute --local`.
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
 *
 * After applying, the product detail pages on `pnpm dev:agent` show the seeded
 * ratings. (The Worker's own `findProductCountDrift` is the runtime backstop; the
 * recompute baked into the file keeps the denormalized aggregates correct.)
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

import {
  DISTRIBUTION,
  MAX_AGE_DAYS,
  REVIEW_FRAGMENTS,
  ROLES,
  SENTIMENT_MIX,
  VERIFIED_WORK_EMAIL_RATE,
  type ReviewFragment,
  type Sentiment,
} from './seed-reviews.data';

/** Recognizable marker that opens every seeded review id — used to delete/teardown
 * the seeded block. Matching on the marker (not the full prefix) catches rows from
 * any past seed run, so a format change still cleans up the old ids. */
const ID_MARKER = 'aeceed00-';
/** Full id prefix for GENERATION: marker + a valid RFC-4122 version/variant
 * (`-4000-8000-`, i.e. version 4 + variant 8, matching the repo's deterministic-UUID
 * convention in seed/*.sql). The `-4xxx-[89ab]xxx-` shape is REQUIRED — the API's
 * review contract validates `id` with a strict `z.uuid()`, which rejects a 0 version
 * or variant nibble (the original `…-0000-0000-…` ids 400'd every detail page). */
const ID_PREFIX = `${ID_MARKER}0000-4000-8000-`;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

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

// ─── Seeded PRNG (mulberry32) + helpers ──────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(private readonly next: () => number) {}
  /** float [0,1) */
  float(): number {
    return this.next();
  }
  /** integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
  /** Weighted pick over {item, weight}. Weights need not be normalized. */
  weighted<T>(entries: ReadonlyArray<{ item: T; weight: number }>): T {
    const total = entries.reduce((s, e) => s + e.weight, 0);
    let r = this.next() * total;
    for (const e of entries) {
      r -= e.weight;
      if (r < 0) return e.item;
    }
    return entries[entries.length - 1].item;
  }
}

// ─── Plan model ──────────────────────────────────────────────────────────────────

export interface ProductInput {
  id: string;
  slug: string;
  name: string;
  categorySlugs: string[];
}

interface PlannedReview {
  id: string;
  productId: string;
  reviewerId: null;
  ratingOverall: number;
  ratingOnboarding: number;
  title: string;
  body: string;
  roleAtCompany: string | null;
  yearsUsing: number | null;
  wouldRecommend: string | null;
  status: 'approved';
  moderatedAt: Date;
  verifiedWorkEmail: boolean;
  locale: 'en-US';
  createdAt: Date;
}

interface Plan {
  reviews: PlannedReview[];
  /** product id → planned review count (includes 0-count products). */
  perProduct: Map<string, number>;
}

const YEARS_POOL = [0, 1, 1, 2, 2, 3, 3, 4, 5, 6, 7, 8, 10, 12, 15] as const;

/** Derive a 1–5 overall/onboarding pair consistent with a sentiment tier.
 * Onboarding is drawn at or below overall — the "great product, rough setup"
 * story that motivates the dual rating. */
function ratingsFor(sentiment: Sentiment, rng: Rng): { overall: number; onboarding: number } {
  if (sentiment === 'positive') {
    const overall = rng.chance(0.6) ? 5 : 4;
    const onboarding = clamp(overall - rng.pick([0, 1, 1, 2]), 3, 5);
    return { overall, onboarding };
  }
  if (sentiment === 'mixed') {
    const overall = rng.chance(0.7) ? 3 : 4;
    const onboarding = clamp(overall - rng.pick([0, 1, 1, 2]), 2, overall);
    return { overall, onboarding };
  }
  // critical
  const overall = rng.chance(0.6) ? 2 : 1;
  const onboarding = clamp(overall + rng.pick([-1, 0, 0, 1]), 1, 3);
  return { overall, onboarding };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function recommendFor(sentiment: Sentiment, rng: Rng): string | null {
  if (rng.chance(0.12)) return null;
  if (sentiment === 'positive')
    return rng.weighted([
      { item: 'yes', weight: 0.85 },
      { item: 'maybe', weight: 0.15 },
    ]);
  if (sentiment === 'mixed')
    return rng.weighted([
      { item: 'maybe', weight: 0.6 },
      { item: 'yes', weight: 0.25 },
      { item: 'no', weight: 0.15 },
    ]);
  return rng.weighted([
    { item: 'no', weight: 0.65 },
    { item: 'maybe', weight: 0.35 },
  ]);
}

function tagMatchesProduct(fragment: ReviewFragment, product: ProductInput): boolean {
  if (!fragment.tags?.length) return false;
  return fragment.tags.some((tag) => product.categorySlugs.some((slug) => slug.includes(tag)));
}

/** Pick a fragment for `product`, preferring the desired sentiment + a category
 * match, falling back gracefully. Returns the fragment AND its effective
 * sentiment (ratings are derived from this so text never contradicts the stars). */
function pickFragment(
  product: ProductInput,
  desired: Sentiment,
  usedTitles: Set<string>,
  rng: Rng,
): { fragment: ReviewFragment; sentiment: Sentiment } {
  const unusedSameSentiment = REVIEW_FRAGMENTS.filter(
    (f) => f.sentiment === desired && !usedTitles.has(f.title),
  );
  const catMatched = unusedSameSentiment.filter((f) => tagMatchesProduct(f, product));
  if (catMatched.length) return { fragment: rng.pick(catMatched), sentiment: desired };
  if (unusedSameSentiment.length)
    return { fragment: rng.pick(unusedSameSentiment), sentiment: desired };

  // Desired-sentiment pool exhausted for this product → any unused fragment,
  // adopting its sentiment so ratings stay consistent.
  const anyUnused = REVIEW_FRAGMENTS.filter((f) => !usedTitles.has(f.title));
  if (anyUnused.length) {
    const f = rng.pick(anyUnused);
    return { fragment: f, sentiment: f.sentiment };
  }
  // Everything used (product wants more reviews than the whole bank) → reuse.
  const f = rng.pick(REVIEW_FRAGMENTS.filter((x) => x.sentiment === desired));
  return { fragment: f ?? rng.pick(REVIEW_FRAGMENTS), sentiment: desired };
}

function render(text: string, product: ProductInput): string {
  return text.replaceAll('{product}', product.name);
}

function toUuid(counter: number): string {
  return ID_PREFIX + counter.toString(16).padStart(12, '0');
}

export function buildPlan(products: ProductInput[], rng: Rng, now: number): Plan {
  const sorted = [...products].sort((a, b) => a.slug.localeCompare(b.slug));
  const buckets = DISTRIBUTION.map((b) => ({ item: b, weight: b.weight }));
  const sentimentEntries: ReadonlyArray<{ item: Sentiment; weight: number }> = [
    { item: 'positive', weight: SENTIMENT_MIX.positive },
    { item: 'mixed', weight: SENTIMENT_MIX.mixed },
    { item: 'critical', weight: SENTIMENT_MIX.critical },
  ];

  const reviews: PlannedReview[] = [];
  const perProduct = new Map<string, number>();
  let counter = 1;

  for (const product of sorted) {
    const bucket = rng.weighted(buckets);
    const count = rng.int(bucket.min, bucket.max);
    perProduct.set(product.id, count);

    const usedTitles = new Set<string>();
    for (let i = 0; i < count; i++) {
      const desired = rng.weighted(sentimentEntries);
      const { fragment, sentiment } = pickFragment(product, desired, usedTitles, rng);
      usedTitles.add(fragment.title);

      const { overall, onboarding } = ratingsFor(sentiment, rng);
      const ageDays = rng.int(1, MAX_AGE_DAYS);
      const createdAt = new Date(now - ageDays * DAY_MS - rng.int(0, 23) * HOUR_MS);
      const moderatedAt = new Date(Math.min(now, createdAt.getTime() + rng.int(1, 72) * HOUR_MS));

      reviews.push({
        id: toUuid(counter++),
        productId: product.id,
        reviewerId: null,
        ratingOverall: overall,
        ratingOnboarding: onboarding,
        title: render(fragment.title, product),
        body: render(fragment.body, product),
        roleAtCompany: rng.chance(0.15) ? null : rng.pick(ROLES),
        yearsUsing: rng.chance(0.15) ? null : rng.pick(YEARS_POOL),
        wouldRecommend: recommendFor(sentiment, rng),
        status: 'approved',
        moderatedAt,
        verifiedWorkEmail: rng.chance(VERIFIED_WORK_EMAIL_RATE),
        locale: 'en-US',
        createdAt,
      });
    }
  }

  return { reviews, perProduct };
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

// ─── SQL generation ───────────────────────────────────────────────────────────────

/** SQLite string literal — single-quote escaped. */
function sqlText(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function sqlTextOrNull(s: string | null): string {
  return s === null ? 'NULL' : sqlText(s);
}

function sqlIntOrNull(n: number | null): string {
  return n === null ? 'NULL' : String(n);
}

const REVIEW_COLUMNS = [
  'id',
  'product_id',
  'reviewer_id',
  'rating_overall',
  'rating_onboarding',
  'title',
  'body',
  'role_at_company',
  'years_using',
  'would_recommend',
  'status',
  'moderated_at',
  'verified_work_email',
  'locale',
  'created_at',
  'updated_at',
] as const;

function reviewValuesRow(rv: PlannedReview): string {
  const createdIso = rv.createdAt.toISOString();
  const moderatedIso = rv.moderatedAt.toISOString();
  const cells = [
    sqlText(rv.id),
    sqlText(rv.productId),
    'NULL', // reviewer_id — anonymous
    String(rv.ratingOverall),
    String(rv.ratingOnboarding),
    sqlText(rv.title),
    sqlText(rv.body),
    sqlTextOrNull(rv.roleAtCompany),
    sqlIntOrNull(rv.yearsUsing),
    sqlTextOrNull(rv.wouldRecommend),
    sqlText(rv.status),
    sqlText(moderatedIso),
    rv.verifiedWorkEmail ? '1' : '0',
    sqlText(rv.locale),
    sqlText(createdIso),
    sqlText(moderatedIso), // updated_at — last touched at moderation
  ];
  return `  (${cells.join(',')})`;
}

const DELETE_SEEDED = `DELETE FROM "reviews" WHERE "id" LIKE '${ID_MARKER}%';`;

/** Recompute the denormalized product aggregates for EVERY product — the SQL
 * equivalent of `recomputeProductCounts` (lib/recompute-counts.ts): approved-only
 * counts/averages, NULL averages when there are zero approved reviews. Cheap over
 * the small dev catalog and correct whether reviews were added or torn down. */
const RECOMPUTE_PRODUCTS = `UPDATE "products" SET
  "review_count" = (SELECT COUNT(*) FROM "reviews" r WHERE r."product_id" = "products"."id" AND r."status" = 'approved'),
  "rating_overall_avg" = (SELECT ROUND(AVG(r."rating_overall"), 2) FROM "reviews" r WHERE r."product_id" = "products"."id" AND r."status" = 'approved'),
  "rating_onboarding_avg" = (SELECT ROUND(AVG(r."rating_onboarding"), 2) FROM "reviews" r WHERE r."product_id" = "products"."id" AND r."status" = 'approved');`;

/** Bump `updated_at` to the run time on the products that carry seeded reviews. The
 * app bumps `updated_at` on every review approval (Drizzle `$onUpdate`); this mirrors
 * that so the daily Algolia incremental-sync cron — which only resyncs rows whose
 * `updated_at` moved into its watermark window — picks these products up and refreshes
 * their `review_count` / rating in search. Scoped to affected products so it never
 * disturbs "recently updated" ordering for the rest of the catalog. */
function touchSeededProducts(nowIso: string): string {
  return `UPDATE "products" SET "updated_at" = ${sqlText(nowIso)}
  WHERE "id" IN (SELECT DISTINCT "product_id" FROM "reviews" WHERE "id" LIKE '${ID_MARKER}%');`;
}

function fileHeader(
  args: Args,
  kind: 'seed' | 'teardown',
  reviewCount: number,
  stamp: string,
): string {
  return [
    '-- ===========================================================================',
    `-- GENERATED by apps/api/scripts/seed-reviews.ts — DO NOT EDIT BY HAND.`,
    `-- ${kind === 'teardown' ? 'Teardown' : 'Seed'} for the LOCAL D1 (${args.db}). Dev/demo only.`,
    `-- seed=${args.seed}  reviews=${reviewCount}  generated=${stamp}`,
    `-- Re-run: pnpm --filter @aeci/api db:seed-reviews -- --apply`,
    '-- ===========================================================================',
    '',
  ].join('\n');
}

/** Idempotent seed file: clear the seeded block, insert the plan in chunks, then
 * recompute every product's aggregates. */
function buildSeedSql(plan: Plan, args: Args): string {
  const nowIso = new Date().toISOString();
  const parts: string[] = [
    fileHeader(args, 'seed', plan.reviews.length, nowIso),
    DELETE_SEEDED,
    '',
  ];

  const insertHeader = `INSERT INTO "reviews" (${REVIEW_COLUMNS.map((c) => `"${c}"`).join(',')}) VALUES`;
  const CHUNK = 25;
  for (let i = 0; i < plan.reviews.length; i += CHUNK) {
    const rows = plan.reviews.slice(i, i + CHUNK).map(reviewValuesRow);
    parts.push(`${insertHeader}\n${rows.join(',\n')};`, '');
  }

  // Recompute aggregates, then touch updated_at (after the inserts exist) so the
  // daily Algolia sync cron resyncs the affected products' review_count/rating.
  parts.push(RECOMPUTE_PRODUCTS, '', touchSeededProducts(nowIso), '');
  return parts.join('\n');
}

/** Teardown file: remove the seeded block + recompute. */
function buildTeardownSql(args: Args): string {
  const nowIso = new Date().toISOString();
  // Touch updated_at BEFORE the delete (while the seeded reviews still identify
  // their products) so the next Algolia sync resyncs them back to review_count=0.
  return [
    fileHeader(args, 'teardown', 0, nowIso),
    touchSeededProducts(nowIso),
    '',
    DELETE_SEEDED,
    '',
    RECOMPUTE_PRODUCTS,
    '',
  ].join('\n');
}

// ─── Local D1 I/O (via Wrangler) ──────────────────────────────────────────────────

const PRODUCTS_QUERY = `SELECT p.id, p.slug, p.name, (SELECT group_concat(tc.slug, ',') FROM product_categories pc JOIN taxonomy_categories tc ON tc.id = pc.category_id WHERE pc.product_id = p.id) AS category_slugs FROM products p`;

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
    writeFileSync(args.out, buildTeardownSql(args));
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

  writeFileSync(args.out, buildSeedSql(plan, args));
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
