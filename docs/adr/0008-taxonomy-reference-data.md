# ADR 0008: Taxonomy is code-managed reference data

**Status:** **Accepted** (2026-06-04)

**Context owner:** Chris Walton

Supersedes — for the taxonomy vocabulary only — the "Airtable owns taxonomy" stance in `docs/DATABASE_SCHEMA.md` §13. Vendors, products, and integrations are unaffected: they remain Airtable-owned content.

---

## Context

The taxonomy facets — `taxonomy_categories`, `taxonomy_disciplines`, `taxonomy_phases` — were originally specced (DATABASE_SCHEMA §13) as curator-managed content living in Airtable (base `appy81IdGJY6Fngf9`), reaching Supabase via a one-way curator-sync job. Two facts made that the wrong model for taxonomy specifically:

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

- The single source of truth is **`supabase/reference-data/taxonomy.sql`** — idempotent `INSERT … ON CONFLICT (slug) DO UPDATE` upserts for categories, disciplines, and phases.
- It is **upsert-only and never deletes** (a delete would cascade to `product_*` join rows). Removals go through an explicit, reviewed migration.
- It writes only the `taxonomy_*` vocabulary tables, never the `product_*` join tables (those links come from the promote flow).
- **Application** is uniform across environments:
  - **Local** — listed in `supabase/config.toml` `[db.seed].sql_paths`; runs on `pnpm db:reset`.
  - **Staging / Prod** — a `psql -v ON_ERROR_STOP=1 "$DIRECT_URL" -f supabase/reference-data/taxonomy.sql` step after `supabase db push` in `deploy.yml`, `refresh-staging.yml`, and `promote-to-prod.yml` (mirrors the existing `seed-staging-users.sql` pattern).
  - **Manual / bootstrap** — `pnpm db:seed-reference [DATABASE_URL]`.

Because the `psql` seed writes `taxonomy_*` directly in Postgres, it bypasses the app's `POST /admin/purge` cache-invalidation path. On prod, `promote-to-prod.yml` follows the seed with a `scripts/purge-cache.sh` step that purges the `taxonomy` and `route:browse` cache tags (a deliberate bulk invalidation per `docs/CACHE_STRATEGY.md` §3/§5); it is `continue-on-error` so a purge hiccup never blocks a release, with the route TTL (≤5 min browse, ≤1 hr nav) as the fallback. Dev (`deploy.yml`) is not purged — the shared dev DB has no zone-cached SSR host (preview Workers are `*.workers.dev`). Staging is not purged either, to avoid a zone-wide tag purge bleeding into prod cache; its taxonomy staleness self-heals at TTL.

This establishes a **third data category** alongside migrations (schema) and `supabase/seed.sql` (local-only fixtures): *version-controlled reference data applied to all environments.*

The data file lives under `supabase/reference-data/`, not in `supabase/migrations/`, deliberately: migrations are immutable once applied, so editing the vocabulary would mean a new migration per change; an idempotent reference file is edited in place and re-applied, giving an "edit one file + merge → every environment" workflow without migration sprawl. It is data-only, so it never affects the Prisma drift check (which runs `--no-seed`).

## Consequences

**Positive**
- The vocabulary is clean, reviewable in PRs, and identical in every environment.
- Adding/relabeling a term is a one-file edit that auto-propagates on the next deploy — no app code, no Airtable round-trip.
- The directory has real, deterministic facets immediately, independent of the unbuilt Airtable→Supabase sync.

**Negative / trade-offs**
- Editing taxonomy now requires a merge (a non-engineer can't self-serve in Airtable). Acceptable: adding a facet is a structural product decision that warrants review.
- One extra `psql` step on each deploy path, including prod. It is additive and idempotent (upsert-only, no deletes), and runs only after the drift + RLS gates pass on prod.
- `DIRECT_URL_STAGING` / `DIRECT_URL_PRODUCTION` must be available to the deploy workflows (they already are — used by the existing psql steps).

**Follow-ups**
- AECI-121 renames the `Discipline` facet to `Audience` and expands it with cross-cutting personas; the reference file's discipline block moves with it.
- Descriptions are seeded `NULL` for now; SEO copy can be added to the file later.
- DATABASE_SCHEMA §13 and `docs/migrations.md` are updated to carve taxonomy out of the Airtable-owned set and document the reference-data category.
