# ADR 0008: Taxonomy is code-managed reference data

**Status:** **Accepted** (2026-06-04)

**Context owner:** Chris Walton

Supersedes — for the taxonomy vocabulary only — the "Airtable owns taxonomy" stance in `docs/DATABASE_SCHEMA.md` §13. Vendors, products, and integrations are unaffected: they remain Airtable-owned content.

> **Amendment (AECI-248→257 D1 migration + AECI-256 prod-promote cleanup).** The taxonomy vocabulary now lives in **Cloudflare D1** (the app DB; ADR 0016), not Supabase Postgres. The canonical seed for the running app is **`apps/api/seed/taxonomy.sql`**, applied via `wrangler d1 execute … --file=seed/taxonomy.sql` right after `wrangler d1 migrations apply` in `deploy.yml` (staging), `promote-to-prod.yml` (production), and `promote-to-demo.yml` (demo). The Postgres `psql … supabase/reference-data/taxonomy.sql` step described in **Decision** below now survives only on the legacy-Postgres paths (`deploy.yml` db-migrate-dev, `refresh-staging.yml`); it was **removed from `promote-to-prod.yml`**, which no longer touches Postgres and no longer needs `DIRECT_URL_PRODUCTION` or the drift/RLS gates. The post-seed cache purge still runs in the prod promote, now following the **D1** seed. The decision itself — taxonomy is code-managed, idempotent, byte-identical reference data — is unchanged.

---

## Context

The taxonomy facets — `taxonomy_categories`, `taxonomy_audiences`, `taxonomy_phases` — were originally specced (DATABASE_SCHEMA §13) as curator-managed content living in Airtable (base `appy81IdGJY6Fngf9`), reaching Supabase via a one-way curator-sync job. Two facts made that the wrong model for taxonomy specifically:

1. **The sync was never built**, and the Supabase taxonomy tables were empty. Nothing populated them, so the directory had no facets to render.
2. **The live Airtable taxonomy had already drifted.** Pulling it (`AECi_Review.list_taxonomy`) returned 3 corrupt category rows whose `name` was a record ID — broken self-referential linked-record entries. An uncontrolled, hand-edited vocabulary degrades over time.

More fundamentally, taxonomy is not *content*; it is **structure**:

- Slugs become **permanent public URLs** (`/categories/bim-authoring`) and SEO landing pages.
- It drives **faceted navigation** and has a deliberate `display_order`.
- It must be **byte-identical across every environment** (a slug must resolve the same in preview, staging, and prod).
- It is **small** (~58 rows) and **changes rarely** — adding a category is a product decision, not data entry.

Airtable is the right tool for the high-volume, frequently-edited *content* (vendors/products/integrations — hundreds/thousands of curator-maintained rows). It is the wrong tool for the small structural skeleton, where what matters is version control, review, and cross-environment determinism.

## Decision

Manage the taxonomy vocabulary as **code-managed reference data**, not Airtable content.

> The file path and application mechanism below describe the original Postgres implementation. After the D1 migration (see the **Amendment** at the top of this ADR), the seed lives at **`apps/api/seed/taxonomy.sql`** and is applied to D1 via `wrangler d1 execute … --file=seed/taxonomy.sql`. The decision — code-managed, idempotent, byte-identical reference data — is unchanged.

- The single source of truth is **`apps/api/seed/taxonomy.sql`** (formerly `supabase/reference-data/taxonomy.sql`) — idempotent upserts for categories, audiences, and phases.
- It is **upsert-only and never deletes** (a delete would cascade to `product_*` join rows). Removals go through an explicit, reviewed migration.
- It writes only the `taxonomy_*` vocabulary tables, never the `product_*` join tables (those links come from the promote flow).
- **Application** is uniform across environments:
  - **Local** — `pnpm db:seed:taxonomy:local` (`wrangler d1 execute … --local --file=seed/taxonomy.sql`); `pnpm db:setup:local` runs it as part of the local migrate+seed loop.
  - **Staging / Prod** — a `wrangler d1 execute … --file=seed/taxonomy.sql` step right after `wrangler d1 migrations apply` in `deploy.yml` (staging) and `promote-to-prod.yml` (production).
  - **Manual / bootstrap** — `wrangler d1 execute <db> --remote --file=apps/api/seed/taxonomy.sql`.

Because the seed writes `taxonomy_*` directly into D1 (`wrangler d1 execute`), it bypasses the app's `POST /admin/purge` cache-invalidation path. On prod, `promote-to-prod.yml` follows the seed with a `scripts/purge-cache.sh` step that purges the `taxonomy` and `route:browse` cache tags (a deliberate bulk invalidation per `docs/CACHE_STRATEGY.md` §3/§5); it is `continue-on-error` so a purge hiccup never blocks a release, with the route TTL (≤5 min browse, ≤1 hr nav) as the fallback. Staging is not purged, to avoid a zone-wide tag purge bleeding into prod cache; its taxonomy staleness self-heals at TTL.

This establishes a **third data category** alongside migrations (schema) and `supabase/seed.sql` (local-only fixtures): *version-controlled reference data applied to all environments.*

The data file lives under `apps/api/seed/`, not in `apps/api/migrations/`, deliberately: migrations are immutable once applied, so editing the vocabulary would mean a new migration per change; an idempotent reference file is edited in place and re-applied, giving an "edit one file + merge → every environment" workflow without migration sprawl. It is data-only, so it stays outside the drizzle-kit schema-drift gate (`.github/workflows/drift-check.yml`, AECI-264), which only compares `apps/api/src/db/schema.ts` against the generated migrations.

## Consequences

**Positive**
- The vocabulary is clean, reviewable in PRs, and identical in every environment.
- Adding/relabeling a term is a one-file edit that auto-propagates on the next deploy — no app code, no Airtable round-trip.
- The directory has real, deterministic facets immediately, independent of the unbuilt Airtable→Supabase sync.

**Negative / trade-offs**
- Editing taxonomy now requires a merge (a non-engineer can't self-serve in Airtable). Acceptable: adding a facet is a structural product decision that warrants review.
- One extra `wrangler d1 execute` step on each deploy path, including prod. It is additive and idempotent (upsert-only, no deletes), and runs right after `wrangler d1 migrations apply`.
- The deploy workflows need a `CLOUDFLARE_API_TOKEN` with D1-edit scope to run `wrangler d1 execute` (they already use it for `wrangler d1 migrations apply`).

**Follow-ups**
- AECI-121 renamed the `Discipline` facet to `Audience` and expanded it with cross-cutting personas; the reference file's discipline block moved with it.
- Descriptions are seeded `NULL` for now; SEO copy can be added to the file later.
- DATABASE_SCHEMA §13 and `docs/migrations.md` are updated to carve taxonomy out of the Airtable-owned set and document the reference-data category.
