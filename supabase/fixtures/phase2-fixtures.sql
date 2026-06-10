-- =============================================================================
-- Phase 2 CI fixtures (AECI-65) — deterministic seed data for the axe +
-- Lighthouse harness so every Phase 2 detail/browse page type has real content
-- to render against.
--
-- ⚠️  TEST FIXTURES — dev / CI ONLY. NEVER apply to production.
--   This file seeds curator-style content (products / vendors / integrations)
--   that in production arrives ONLY through the Airtable promote flow. It exists
--   purely so CI's axe (zero AA violations) and Lighthouse (perf budgets) checks
--   have a stable, representative page to measure. No prod deploy path
--   (`promote-to-prod.yml`) references `supabase/fixtures/` — keep it that way.
--
-- WHY psql (not supabase/seed.sql)
--   The running app — local `pnpm dev:bound` AND every CI e2e job — reads the
--   SHARED `aeci-development` Supabase DB via Prisma Accelerate, never local
--   Postgres, so `supabase/seed.sql` is never served. Fixtures must land in that
--   shared DB. Applied the same way as the taxonomy reference data:
--   `psql -f supabase/fixtures/phase2-fixtures.sql` against DIRECT_URL_STAGING in
--   `.github/workflows/deploy.yml` (db-migrate-dev), and locally via the
--   `DIRECT_URL` in apps/api/.dev.vars.
--
-- CONTRACT
--   * Idempotent UPSERTs: products/vendors key on `slug`, the integration keys on
--     its pinned `id`, join rows `ON CONFLICT DO NOTHING`. Safe to re-run; each
--     run reconciles the row back to this file. Concurrency-safe (read-only
--     tests never mutate fixtures).
--   * promotion_status is set to 'promoted' EXPLICITLY (schema default is
--     'pending'). The Worker's Prisma/Accelerate connection bypasses RLS so a
--     'pending' row would still render, but seeding 'promoted' keeps the fixtures
--     honest against the documented public-visibility contract and future-proofs
--     them if a promotion_status WHERE filter is ever added to the handlers.
--   * Taxonomy links reference the EXISTING code-owned reference vocabulary
--     (supabase/reference-data/taxonomy.sql) by slug. The `INSERT ... SELECT`
--     form no-ops (no error) if a referenced taxonomy term is absent.
--   * A valid integration needs two DISTINCT products (DB CHECK
--     source_product_id <> target_product_id), so two products are seeded: a
--     primary application + a connector that serves as the integration's target.
--   * Logo URLs are intentionally NULL so CI stays hermetic (no external image
--     fetch distorting LCP); the logo component renders the initial-letter
--     fallback (AECI-152). Real-logo perf is a separate concern.
--
-- STABLE IDENTITIES (referenced by .lighthouserc.cjs + e2e/phase2-a11y.spec.ts)
--   product slug   fixture-procore                 (primary, application)
--   product slug   fixture-acme-connector          (integration target, connector)
--   vendor slug    fixture-procore-technologies
--   integration id 00000000-0000-4000-8000-000000000065   (detail URL key)
--   taxonomy       project-management / general-contracting / construction
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Vendor (1) — promoted, verified.
-- -----------------------------------------------------------------------------
INSERT INTO "vendors" ("id", "slug", "company_name", "description", "website",
                       "headquarters", "founded_year", "verified", "promotion_status")
VALUES (
  '00000000-0000-4000-8000-000000000061',
  'fixture-procore-technologies',
  'Fixture Procore Technologies',
  'Fixture vendor used by the AECI-65 axe + Lighthouse CI harness. Represents a '
    || 'mid-sized construction-software company with a verified profile, a short '
    || 'company description, and a handful of products and integrations so the '
    || 'vendor detail page renders a realistic amount of content.',
  'https://example.com/fixture-procore-technologies',
  'Carpinteria, CA',
  2002,
  true,
  'promoted'
)
ON CONFLICT ("slug") DO UPDATE
  SET "company_name"      = EXCLUDED."company_name",
      "description"       = EXCLUDED."description",
      "website"           = EXCLUDED."website",
      "headquarters"      = EXCLUDED."headquarters",
      "founded_year"      = EXCLUDED."founded_year",
      "verified"          = EXCLUDED."verified",
      "promotion_status"  = EXCLUDED."promotion_status",
      "updated_at"        = now();

-- -----------------------------------------------------------------------------
-- Products (2) — a primary application + a connector for the integration target.
-- integration_count = 1 (each participates in the single fixture integration).
-- -----------------------------------------------------------------------------
-- The primary product carries a `usefulness` blob (AECI-173) so the product detail
-- page's "How teams use it" section renders live in the e2e populated-state test.
-- Slug-based groups key off the SAME taxonomy terms this product is tagged with
-- below (audience general-contracting / phase construction); names mirror
-- supabase/reference-data/taxonomy.sql. The connector keeps NULL usefulness so it
-- stays a real null-path page. Shape: API_CONTRACTS §5.1 / DATABASE_SCHEMA §4.2.
INSERT INTO "products" ("id", "slug", "name", "description", "website",
                        "product_role", "integration_count", "promotion_status",
                        "usefulness")
VALUES
  (
    '00000000-0000-4000-8000-000000000062',
    'fixture-procore',
    'Fixture Procore',
    'Fixture product used by the AECI-65 axe + Lighthouse CI harness. A '
      || 'construction-management application with a description, vendor, taxonomy '
      || 'tags (category / audience / phase), and one integration — enough content '
      || 'for the product detail page to be a meaningful target for accessibility '
      || 'and performance measurement without being unrealistically large.',
    'https://example.com/fixture-procore',
    'application',
    1,
    'promoted',
    '{
       "audiences": [
         {
           "slug": "general-contracting",
           "name": "General Contracting",
           "points": [
             "Track RFIs and submittals across every job so nothing slips between trades.",
             "Give superintendents one daily-log workflow instead of paper and spreadsheets."
           ]
         }
       ],
       "phases": [
         {
           "slug": "construction",
           "name": "Construction",
           "points": [
             "Keep field and office on one schedule of record during active construction."
           ]
         }
       ]
     }'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000000063',
    'fixture-acme-connector',
    'Fixture Acme Connector',
    'Fixture connector product used as the target endpoint of the AECI-65 fixture '
      || 'integration, so the integration detail page has a valid distinct '
      || 'source → target pair to render.',
    'https://example.com/fixture-acme-connector',
    'connector',
    1,
    'promoted',
    NULL
  )
ON CONFLICT ("slug") DO UPDATE
  SET "name"              = EXCLUDED."name",
      "description"       = EXCLUDED."description",
      "website"           = EXCLUDED."website",
      "product_role"      = EXCLUDED."product_role",
      "integration_count" = EXCLUDED."integration_count",
      "promotion_status"  = EXCLUDED."promotion_status",
      "usefulness"        = EXCLUDED."usefulness",
      "updated_at"        = now();

-- -----------------------------------------------------------------------------
-- Primary product → vendor link (is_primary). Resolves both ids by slug so the
-- link is correct regardless of how the rows above were upserted.
-- -----------------------------------------------------------------------------
INSERT INTO "product_vendors" ("product_id", "vendor_id", "is_primary")
SELECT p."id", v."id", true
FROM "products" p, "vendors" v
WHERE p."slug" = 'fixture-procore'
  AND v."slug" = 'fixture-procore-technologies'
ON CONFLICT ("product_id", "vendor_id") DO UPDATE
  SET "is_primary" = EXCLUDED."is_primary";

-- -----------------------------------------------------------------------------
-- Taxonomy links — primary product tagged with one existing term per facet, so
-- the category / audience / phase BROWSE pages each render a product card. The
-- SELECT form no-ops if a referenced term is missing (taxonomy not yet seeded).
-- -----------------------------------------------------------------------------
INSERT INTO "product_categories" ("product_id", "category_id")
SELECT p."id", c."id"
FROM "products" p, "taxonomy_categories" c
WHERE p."slug" = 'fixture-procore' AND c."slug" = 'project-management'
ON CONFLICT DO NOTHING;

INSERT INTO "product_audiences" ("product_id", "audience_id")
SELECT p."id", a."id"
FROM "products" p, "taxonomy_audiences" a
WHERE p."slug" = 'fixture-procore' AND a."slug" = 'general-contracting'
ON CONFLICT DO NOTHING;

INSERT INTO "product_phases" ("product_id", "phase_id")
SELECT p."id", ph."id"
FROM "products" p, "taxonomy_phases" ph
WHERE p."slug" = 'fixture-procore' AND ph."slug" = 'construction'
ON CONFLICT DO NOTHING;

-- -----------------------------------------------------------------------------
-- Integration (1) — pinned id (the detail-page URL key). source/target/built_by
-- resolved by slug so the FKs are always valid. Both endpoints are promoted.
-- -----------------------------------------------------------------------------
INSERT INTO "integrations" ("id", "name", "source_product_id", "target_product_id",
                            "mechanism_kind", "mechanism_name", "direction",
                            "built_by_vendor_id", "description", "listing_url", "docs_url")
SELECT
  '00000000-0000-4000-8000-000000000065'::uuid,
  'Fixture Procore ↔ Acme Connector',
  sp."id",
  tp."id",
  'native',
  'Native integration',
  'bidirectional',
  v."id",
  'Fixture integration used by the AECI-65 axe + Lighthouse CI harness. A native, '
    || 'bidirectional integration between two fixture products with a built-by '
    || 'vendor, mechanism, and description, so the integration detail page renders '
    || 'a realistic amount of content.',
  'https://example.com/fixture-integration/listing',
  'https://example.com/fixture-integration/docs'
FROM "products" sp, "products" tp, "vendors" v
WHERE sp."slug" = 'fixture-procore'
  AND tp."slug" = 'fixture-acme-connector'
  AND v."slug"  = 'fixture-procore-technologies'
ON CONFLICT ("id") DO UPDATE
  SET "name"               = EXCLUDED."name",
      "source_product_id"  = EXCLUDED."source_product_id",
      "target_product_id"  = EXCLUDED."target_product_id",
      "mechanism_kind"     = EXCLUDED."mechanism_kind",
      "mechanism_name"     = EXCLUDED."mechanism_name",
      "direction"          = EXCLUDED."direction",
      "built_by_vendor_id" = EXCLUDED."built_by_vendor_id",
      "description"        = EXCLUDED."description",
      "listing_url"        = EXCLUDED."listing_url",
      "docs_url"           = EXCLUDED."docs_url",
      "updated_at"         = now();
