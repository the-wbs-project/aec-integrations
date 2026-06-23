/**
 * export-catalog-to-d1.ts — one-time backfill: existing Supabase Postgres → D1.
 *
 * Context (ADR 0016 / AECI-248→257): the app DB moved to Cloudflare D1. Staging
 * deploys seed only the SCHEMA + `seed/taxonomy.sql` reference data — they do NOT
 * load the catalog (vendors/products/integrations), which is why a freshly-cut
 * staging D1 renders an empty site. The designed steady-state path for the
 * catalog is `POST /api/promote` (review app → D1). This script is the ONE-TIME
 * backfill for the data that already lives in the old Supabase Postgres app DB,
 * so the site is populated immediately AND the review app's stored
 * `supabase_*_id` mappings stay valid (preserving ids means a later "Promote"
 * edit lands as a real UPDATE, not the silent no-op an empty D1 would cause —
 * see apps/api/src/routes/promote.ts:420).
 *
 * It is READ-ONLY against Postgres and writes NOTHING remote: it only emits a
 * SQLite `.sql` file you review, then load with `wrangler d1 execute … --remote`.
 *
 * ─ How it works ────────────────────────────────────────────────────────────
 *   For each table it shells out to `psql` (already a repo prerequisite — see
 *   scripts/seed-from-staging.sh) and pulls the rows as JSON via
 *   `json_agg(row_to_json(...))`, then renders SQLite `INSERT OR IGNORE`
 *   statements with Postgres→SQLite value coercion (bool→0/1, jsonb→json text,
 *   timestamptz→ISO-8601 text).
 *
 *   • Entity ids/slugs are PRESERVED verbatim (D1 catalog starts empty → no
 *     conflicts; re-runs are no-ops thanks to OR IGNORE).
 *   • Taxonomy is emitted `INSERT OR IGNORE` so the CI-seeded taxonomy.sql ids
 *     WIN on slug collisions; any Supabase-only term is added. Join tables
 *     therefore resolve the taxonomy id BY SLUG (subquery), exactly like
 *     seed/catalog.sql — so the file is independent of which taxonomy id won.
 *   • Tables are emitted parent-before-child for FK safety. Full tables are
 *     exported (no promotion filter) so every integration FK target exists; the
 *     site only renders promoted rows anyway.
 *
 * ─ Usage ───────────────────────────────────────────────────────────────────
 *   # A DIRECT postgres URL (NOT a prisma:// Accelerate URL). Supabase: use the
 *   # session-mode pooler — postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres
 *   export SOURCE_DATABASE_URL='postgresql://…'      # or DIRECT_URL_STAGING / DIRECT_URL
 *   pnpm --filter @aeci/api db:export:catalog        # writes apps/api/staging-catalog-export.sql
 *   # optional explicit out path:
 *   pnpm --filter @aeci/api db:export:catalog -- ./tmp/catalog.sql
 *
 * Then load it (see scripts/README.md for the full runbook).
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Source connection ────────────────────────────────────────────────────────
const SOURCE_URL =
  process.env.SOURCE_DATABASE_URL || process.env.DIRECT_URL_STAGING || process.env.DIRECT_URL;

if (!SOURCE_URL) {
  fail(
    'Set SOURCE_DATABASE_URL (or DIRECT_URL_STAGING / DIRECT_URL) to a DIRECT postgres URL.\n' +
      'Supabase: the session-mode pooler, e.g.\n' +
      '  postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres',
  );
}
if (!/^postgres(ql)?:\/\//.test(SOURCE_URL!)) {
  fail(
    `SOURCE url must be a direct postgres:// URL, got "${SOURCE_URL!.split('://')[0]}://…".\n` +
      'psql cannot use a prisma:// Accelerate URL — use the Supabase pooler URL.',
  );
}

// Output path: `OUT_FILE` env, else the first real CLI arg. We skip a bare `--`
// because `pnpm run x -- file.sql` forwards the `--` itself as argv[2] (which
// otherwise writes a file literally named `--`). To be safe pass it with
// `pnpm exec tsx scripts/export-catalog-to-d1.ts file.sql` or `OUT_FILE=…`.
const outArg = process.argv.slice(2).find((a) => a && a !== '--');
const OUT_PATH = resolve(process.env.OUT_FILE ?? outArg ?? 'staging-catalog-export.sql');

// ── Table specs (D1 target columns, in `apps/api/src/db/schema.ts` order) ────
type EntitySpec = { table: string; cols: string[]; jsonCols?: string[] };
type PlainJoinSpec = { table: string; cols: string[] };
type ResolvedJoinSpec = { table: string; cols: string[]; fk: string; ref: string };

// Parent → child. Taxonomy + entities first, then join tables.
const ENTITY_TABLES: EntitySpec[] = [
  { table: 'taxonomy_categories', cols: ['id', 'slug', 'name', 'description', 'display_order', 'created_at', 'updated_at'] }, // prettier-ignore
  { table: 'taxonomy_audiences',  cols: ['id', 'slug', 'name', 'description', 'display_order', 'created_at', 'updated_at'] }, // prettier-ignore
  { table: 'taxonomy_phases',     cols: ['id', 'slug', 'name', 'description', 'display_order', 'created_at', 'updated_at'] }, // prettier-ignore
  {
    table: 'vendors',
    cols: ['id', 'slug', 'company_name', 'description', 'website', 'headquarters', 'founded_year', 'public_private', 'parent_company', 'linkedin_url', 'x_url', 'facebook_url', 'instagram_url', 'youtube_url', 'crunchbase_url', 'wiki_url', 'source_url', 'github_org', 'phone_number', 'contact_email', 'logo_url', 'verified', 'promotion_status', 'admin_notes', 'vqs_credibility', 'vqs_momentum', 'vqs_fit', 'vqs_total', 'vqs_computed_at', 'created_at', 'updated_at'], // prettier-ignore
  },
  {
    table: 'products',
    cols: ['id', 'slug', 'name', 'description', 'website', 'tool_integrations_url', 'api_docs_url', 'has_api_docs', 'tool_integration_check_notes', 'usefulness', 'product_role', 'logo_url', 'integration_count', 'review_count', 'rating_overall_avg', 'rating_onboarding_avg', 'research_status', 'research_notes', 'promotion_status', 'priority_tier', 'priority_score', 'score_computed_at', 'google_trends_index', 'search_volume_monthly', 'search_checked_at', 'reddit_mentions_24mo', 'reddit_checked_at', 'admin_notes', 'created_at', 'updated_at'], // prettier-ignore
    jsonCols: ['usefulness'],
  },
  {
    table: 'integrations',
    cols: ['id', 'name', 'source_product_id', 'target_product_id', 'mechanism_kind', 'mechanism_name', 'direction', 'built_by_vendor_id', 'powered_by_product_id', 'description', 'listing_url', 'docs_url', 'website', 'mechanism_url', 'pricing_model', 'maturity', 'notes', 'created_at', 'updated_at'], // prettier-ignore
  },
];

const PLAIN_JOINS: PlainJoinSpec[] = [
  { table: 'product_vendors', cols: ['product_id', 'vendor_id', 'is_primary', 'created_at'] },
  { table: 'product_extensions', cols: ['product_id', 'host_product_id', 'created_at'] },
];

// `<fk>` is resolved BY SLUG at load time (subquery into `<ref>`), so the file
// does not depend on the taxonomy ids — the CI taxonomy seed's ids are kept.
const RESOLVED_JOINS: ResolvedJoinSpec[] = [
  { table: 'product_categories', cols: ['product_id', 'category_id', 'created_at'], fk: 'category_id', ref: 'taxonomy_categories' }, // prettier-ignore
  { table: 'product_audiences', cols: ['product_id', 'audience_id', 'created_at'], fk: 'audience_id', ref: 'taxonomy_audiences' }, // prettier-ignore
  { table: 'product_phases', cols: ['product_id', 'phase_id', 'created_at'], fk: 'phase_id', ref: 'taxonomy_phases' }, // prettier-ignore
];

// D1 rejects a single SQL statement over ~100 KB ("statement too long:
// SQLITE_TOOBIG"), so multi-row INSERTs are chunked by accumulated BYTE size,
// not row count — long text rows (descriptions, `usefulness` JSON) blow a
// fixed row count past the cap. 50 KB leaves ~2× headroom.
const MAX_STMT_BYTES = 50_000;

// ── psql helpers ─────────────────────────────────────────────────────────────
function psqlJson<T = Record<string, unknown>>(query: string): T[] {
  const out = execFileSync('psql', [SOURCE_URL!, '-tA', '-c', query], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  }).trim();
  return out ? (JSON.parse(out) as T[]) : [];
}

/** Columns that actually exist in the source table (so we tolerate minor drift). */
function sourceColumns(table: string): Set<string> {
  const rows = psqlJson<string>(
    `SELECT coalesce(json_agg(column_name), '[]'::json)::text FROM information_schema.columns ` +
      `WHERE table_schema = 'public' AND table_name = '${table}'`,
  );
  return new Set(rows as unknown as string[]);
}

// ── SQLite value rendering ───────────────────────────────────────────────────
function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function lit(value: unknown, col: string, jsonCols: Set<string>): string {
  if (value === null || value === undefined) return 'NULL';
  if (jsonCols.has(col)) return quote(JSON.stringify(value));
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'object') return quote(JSON.stringify(value)); // defensive: stray jsonb
  let s = String(value);
  // `*_at` columns are TEXT ISO-8601 in D1 — normalise Postgres "+00:00" → "…Z".
  if (col.endsWith('_at')) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) s = d.toISOString();
  }
  return quote(s);
}

function rowTuple(
  row: Record<string, unknown>,
  cols: string[],
  jsonCols: Set<string>,
  override?: (col: string, row: Record<string, unknown>) => string | null,
): string {
  const vals = cols.map((c) => override?.(c, row) ?? lit(row[c], c, jsonCols));
  return `  (${vals.join(', ')})`;
}

function emitInserts(table: string, cols: string[], tuples: string[]): string {
  if (tuples.length === 0) return `-- ${table}: 0 rows\n`;
  const colList = cols.map((c) => `"${c}"`).join(', ');
  const prefix = `INSERT OR IGNORE INTO "${table}" (${colList}) VALUES\n`;
  const prefixBytes = Buffer.byteLength(prefix);
  const out: string[] = [`-- ${table}: ${tuples.length} rows`];

  let batch: string[] = [];
  let bytes = prefixBytes;
  const flush = () => {
    if (batch.length) out.push(prefix + batch.join(',\n') + ';');
    batch = [];
    bytes = prefixBytes;
  };
  for (const t of tuples) {
    const tBytes = Buffer.byteLength(t) + 2; // ",\n" separator
    if (batch.length && bytes + tBytes > MAX_STMT_BYTES) flush();
    batch.push(t);
    bytes += tBytes;
  }
  flush();
  return out.join('\n') + '\n';
}

function fail(msg: string): never {
  console.error(`\n✘ ${msg}\n`);
  process.exit(1);
}

// ── Run ──────────────────────────────────────────────────────────────────────
console.error(`→ Exporting catalog from ${SOURCE_URL!.replace(/:[^:@/]+@/, ':****@')}`);
console.error(`→ Writing to ${OUT_PATH}`);

const parts: string[] = [
  '-- Generated by apps/api/scripts/export-catalog-to-d1.ts — one-time Supabase→D1 backfill.',
  '-- DO NOT COMMIT. Load with: wrangler d1 execute aeci-app-staging --env staging --remote --file=<this file>',
  '-- Idempotent (INSERT OR IGNORE); ids/slugs preserved; taxonomy ids resolved by slug.',
  '',
];
const counts: Record<string, number> = {};

// Entity + taxonomy tables (verbatim columns, drift-tolerant).
for (const spec of ENTITY_TABLES) {
  const have = sourceColumns(spec.table);
  if (have.size === 0) fail(`source table "${spec.table}" not found in public schema`);
  const cols = spec.cols.filter((c) => have.has(c));
  const missing = spec.cols.filter((c) => !have.has(c));
  if (missing.length) console.error(`  ⚠ ${spec.table}: source missing [${missing.join(', ')}] — D1 defaults apply`); // prettier-ignore
  const jsonCols = new Set(spec.jsonCols ?? []);
  const selectList = cols.map((c) => `"${c}"`).join(', ');
  const rows = psqlJson<Record<string, unknown>>(
    `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)::text FROM (SELECT ${selectList} FROM "public"."${spec.table}") t`,
  );
  counts[spec.table] = rows.length;
  parts.push(
    emitInserts(
      spec.table,
      cols,
      rows.map((r) => rowTuple(r, cols, jsonCols)),
    ),
  );
}

// Plain join tables (direct id columns).
for (const spec of PLAIN_JOINS) {
  const have = sourceColumns(spec.table);
  if (have.size === 0) fail(`source table "${spec.table}" not found in public schema`);
  const cols = spec.cols.filter((c) => have.has(c));
  const selectList = cols.map((c) => `"${c}"`).join(', ');
  const rows = psqlJson<Record<string, unknown>>(
    `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)::text FROM (SELECT ${selectList} FROM "public"."${spec.table}") t`,
  );
  counts[spec.table] = rows.length;
  const empty = new Set<string>();
  parts.push(
    emitInserts(
      spec.table,
      cols,
      rows.map((r) => rowTuple(r, cols, empty)),
    ),
  );
}

// Resolved join tables (taxonomy id resolved BY SLUG via subquery).
for (const spec of RESOLVED_JOINS) {
  const have = sourceColumns(spec.table);
  if (have.size === 0) fail(`source table "${spec.table}" not found in public schema`);
  const SLUG = '__ref_slug';
  // SELECT product_id, <ref>.slug AS __ref_slug, created_at  (drop created_at if absent)
  const passthrough = spec.cols.filter((c) => c !== spec.fk && have.has(c));
  const selectList = [...passthrough.map((c) => `j."${c}"`), `r."slug" AS "${SLUG}"`].join(', ');
  const rows = psqlJson<Record<string, unknown>>(
    `SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)::text FROM ` +
      `(SELECT ${selectList} FROM "public"."${spec.table}" j ` +
      `JOIN "public"."${spec.ref}" r ON r."id" = j."${spec.fk}") t`,
  );
  const empty = new Set<string>();
  const tuples: string[] = [];
  let orphans = 0;
  for (const r of rows) {
    const slug = r[SLUG];
    if (slug == null) {
      orphans++;
      continue;
    }
    tuples.push(
      rowTuple(r, spec.cols, empty, (col) =>
        col === spec.fk ? `(SELECT id FROM ${spec.ref} WHERE slug = ${quote(String(slug))})` : null,
      ),
    );
  }
  if (orphans) console.error(`  ⚠ ${spec.table}: ${orphans} rows had an unresolvable ${spec.fk} — skipped`); // prettier-ignore
  counts[spec.table] = tuples.length;
  parts.push(emitInserts(spec.table, spec.cols, tuples));
}

writeFileSync(OUT_PATH, parts.join('\n'));

console.error('\n→ Row counts:');
for (const [t, n] of Object.entries(counts)) console.error(`    ${t.padEnd(22)} ${n}`);
console.error(`\n✅ Wrote ${OUT_PATH}`);
console.error('\nNext: load into staging D1 (review the SQL first):');
console.error(
  '  cd apps/api && pnpm exec wrangler d1 execute aeci-app-staging --env staging --remote \\\n' +
    `    --file=${OUT_PATH}`,
);
