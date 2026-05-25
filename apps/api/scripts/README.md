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
