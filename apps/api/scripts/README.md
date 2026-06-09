# `apps/api/scripts/`

Maintenance scripts run from the developer machine (or CI) against the API
package's database. Not deployed to the Worker.

## `backfill-slugs.ts` — AECI-53 / Phase 2 §6.4

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

This is covered by `apps/api/src/integration/backfill-slugs.spec.ts`.

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
