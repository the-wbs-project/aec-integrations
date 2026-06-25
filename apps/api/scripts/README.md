# `apps/api/scripts/`

Maintenance scripts run from the developer machine (or CI) against the API
package's database. Not deployed to the Worker.

## `export-catalog-to-d1.ts` — one-time Supabase→D1 catalog backfill (ADR 0016)

After the app DB moved to **Cloudflare D1**, a staging/production deploy seeds
only the **schema + `seed/taxonomy.sql`** reference data — it does **not** load
the catalog (vendors/products/integrations). A freshly-cut D1 therefore renders
an empty site. The steady-state catalog path is `POST /api/promote` (review app
→ D1); this script is the **one-time backfill** for the catalog that already
lives in the old **Supabase Postgres** app DB.

It is **read-only** against Postgres and **writes nothing remote**: it shells out
to `psql`, pulls each table as JSON, and emits an idempotent
(`INSERT OR IGNORE`) SQLite file you review, then load with `wrangler`.

Why backfill instead of re-promote: it **preserves the existing ids/slugs**, so
the site is populated immediately *and* the review app's stored `supabase_*_id`
mappings stay valid — a later "Promote" edit lands as a real `UPDATE`. (Pushing
old ids into an **empty** D1 via `/api/promote` would silently no-op — the
handler's `UPDATE … WHERE id = ?` matches zero rows; see
`src/routes/promote.ts:420`.)

### Prerequisites

- **`psql`** on `PATH` (Postgres 17 client — same dep as
  `scripts/seed-from-staging.sh`; `brew install libpq && brew link --force libpq`).
- **`SOURCE_DATABASE_URL`** — a **DIRECT** `postgresql://` URL for the Supabase
  project that holds the catalog (the script also accepts `DIRECT_URL_STAGING` /
  `DIRECT_URL`). **Not** a `prisma://` Accelerate URL. Use the Supabase
  **session-mode pooler** (`docs` note): `postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
- To **load**: `wrangler` auth — `CLOUDFLARE_API_TOKEN` (with **D1: Edit**) +
  `CLOUDFLARE_ACCOUNT_ID`, or `wrangler login`.

### Runbook (staging)

```bash
cd apps/api

# 1. Generate the SQL (read-only against Postgres). Writes apps/api/staging-catalog-export.sql.
export SOURCE_DATABASE_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres'
pnpm db:export:catalog            # prints per-table row counts

# 2. Review it. (gitignored — never commit; it carries real catalog rows.)
less staging-catalog-export.sql

# 3. Load into the remote staging D1 (needs the CF token with D1: Edit).
pnpm exec wrangler d1 execute aeci-app-staging --env staging --remote \
  --file=staging-catalog-export.sql

# 4. Verify the counts landed.
pnpm exec wrangler d1 execute aeci-app-staging --env staging --remote \
  --command "SELECT (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM vendors) AS vendors, (SELECT count(*) FROM integrations) AS integrations"
```

Then reload the staging site — projects should render. **Search (Algolia) is
separate** from D1 rendering; if staging search lags the catalog, run a reindex
(`pnpm algolia:bulk-sync -- --env staging`) or wait for the nightly cron.

For **production**, repeat with the production source URL and
`aeci-app-production --env production`.

### Notes

- **Order & FK safety:** taxonomy + entities are emitted before join tables, and
  full tables are exported (no promotion filter) so every integration FK target
  exists. The site renders only `promoted` rows regardless.
- **Taxonomy ids:** emitted `INSERT OR IGNORE`, so the CI-seeded `taxonomy.sql`
  ids win on slug collisions; join tables resolve the taxonomy id **by slug**
  (subquery), so the file is independent of which id won — same trick as
  `seed/catalog.sql`.
- **Idempotent:** re-running the load is a no-op (`INSERT OR IGNORE`).
- **Type coercion:** Postgres→SQLite — `boolean`→`0/1`, `jsonb`→JSON text,
  `timestamptz`→ISO-8601 text. Column set is drift-tolerant (intersects the D1
  target columns in `src/db/schema.ts` with the live source columns).

## `backfill-slugs.ts` — AECI-53 / Phase 2 §6.4

> **Removed in the D1 migration (PR #359).** Both this script and its integration
> spec (`apps/api/src/integration/backfill-slugs.spec.ts`) were deleted when the
> app DB moved to Cloudflare D1 (ADR 0016); slugs are now generated inline on the
> `POST /api/promote` write path. The section is retained for historical context
> only — full removal rides with the AECI-256/257 Supabase-Postgres decommission.

Normalizes `products.slug` and `vendors.slug` in Supabase against the canonical
generator in `packages/shared/src/slug.ts`. For every row whose stored `slug`
differs from `slugify(displayName)`, the script rewrites it (resolving
collisions through `disambiguateSlug` — vendor-suffix path, then numeric).
Rows already at the canonical slug are SKIPPED, so the script is **idempotent**:
re-running on a clean DB is a no-op.

> The original Phase 2 §6.4 wording assumed `slug IS NULL` rows. AECI-39
> shipped `slug NOT NULL UNIQUE` in the baseline migration, so no NULL rows
> exist. AECI-53 was reinterpreted with the user as a slug-normalization
> pass — same intent (canonical, unique slugs before Wave 3 SSR routes),
> different starting state.

### Prerequisites

`apps/api/.dev.vars` set with:

- `DATABASE_URL` — Prisma Accelerate URL (`prisma://...`) for the target
  Supabase project. The connection uses the service role and bypasses RLS
  by design (per the AECI-53 Notes section).

### Invocation

```bash
# Plan only — prints WOULD WRITE lines without touching the DB.
pnpm --filter @aeci/api db:backfill-slugs -- --dry-run

# Apply.
pnpm --filter @aeci/api db:backfill-slugs
```

### Output

One line per row, plus a summary block:

```
[vendor]  <uuid> <companyName> → <slug> (UPDATED | WOULD WRITE | SKIPPED)
[product] <uuid> <name>        → <slug> (UPDATED | WOULD WRITE | SKIPPED)
...
─── Summary ─────────────────────────────────────────
vendors:  scanned=… updated=… skipped=… collisions=… errored=…
products: scanned=… updated=… skipped=… collisions=… errored=…
```

- **`collisions`** counts rows where `disambiguateSlug` had to fall back from
  `slugify(name)` to a vendor-suffixed or numeric variant.
- **`errored`** counts rows whose `name` either slugified to a reserved word
  (e.g. a product literally named "Admin") or to an empty string. The script
  logs and continues; those rows must be renamed manually and re-run. Open a
  Linear issue with the row IDs from the log.

The process exits `0` on a clean run and `2` if any row ERRORED.

### Idempotency

The script reads the current slug, computes the canonical, and only writes
when they differ. Running it twice in a row against the same DB produces:

- Run 1: zero or more `UPDATED`.
- Run 2: every row `SKIPPED`. Zero writes.

This was covered by `apps/api/src/integration/backfill-slugs.spec.ts`, deleted
alongside the script in PR #359 (see the removal note above).

### Ordering

Vendors are processed before products so that when a product needs the
vendor-suffix disambiguation path, the vendor it points at is already on its
final slug.

### Migration

The companion migration
`supabase/migrations/20260524100000_phase_2_slug_unique.sql`
re-asserts the unique indexes on `vendors.slug` and `products.slug` via
`CREATE UNIQUE INDEX IF NOT EXISTS`. The baseline migration already created
both indexes, so this is a no-op against the current schema but documents the
§6.4 contract and protects against a fresh DB build that skipped the baseline
indexes. Apply with:

```bash
pnpm db:push         # remote (linked project)
# — or —
pnpm db:reset        # local stack via supabase start
```

## `algolia-bulk-sync.ts` — AECI-138 / Phase 3.5 (`STAGE_1_SPEC.md` §7.4, §7.6)

One-off, rerunnable **full reindex**. Reads every **promoted** product / vendor /
integration from Supabase, denormalizes each row into its §7.1 Algolia record via
the shared AECI-137 transform (`src/lib/algolia-transforms.ts`), validates it
against the `@aeci/shared/algolia-records` Zod schema, applies the §7.2/§7.3 index
settings, and batch-uploads to one environment's index set. The orchestration is
the unit-tested core `src/lib/algolia-bulk-sync.ts`; this script is the thin
runner. Integrations may be **0 rows** (clean — the index stays empty until
AECI-86 re-enables integration seeding in `POST /api/promote`).

Uploads go through `saveObjects`, which upserts by `objectID` (the Supabase UUID),
so a re-run replaces each record in place. It deliberately does **not** use
`replaceAllObjects` (its temp index is outside the per-env management key's scope,
CICD §7.5), so rows that fall out of `promoted` (retracted) are not pruned here.

### Prerequisites

- `DIRECT_URL` — always required (the source DB to read). Point it at the target
  env's Postgres; the vanilla `@prisma/client` runs over it with the privileged
  role (bypassing RLS), like `reconcile-product-counts.ts`.
- `ALGOLIA_APP_ID` + `ALGOLIA_ADMIN_KEY` — required for a real run.
  `ALGOLIA_ADMIN_KEY` is the per-env **management** key (never the search-only
  key). `--dry-run` needs neither Algolia var.

The operator points `DIRECT_URL` at the env's DB, `ALGOLIA_ADMIN_KEY` at the
matching env's management key, and `--env` at that env's index prefix.

### Invocation

```bash
# Preview the plan — reads + transforms + validates, prints per-entity counts,
# writes nothing. Needs only DIRECT_URL.
pnpm --filter @aeci/api db:algolia-bulk-sync -- --env preview --dry-run

# Real reindex against an env's indexes (needs the management key).
pnpm --filter @aeci/api db:algolia-bulk-sync -- --env staging
# or from the repo root:
pnpm algolia:bulk-sync -- --env staging
```

Flags: `--env <preview|staging|production>` (required; `development` folds onto
`preview`), `--locale <code>` (default `en-US`; other locales target the
`<prefix>_<entity>_<locale>` set per §7.6), `--dry-run`, `--skip-settings`.

Covered by `apps/api/src/lib/algolia-bulk-sync.spec.ts`.
