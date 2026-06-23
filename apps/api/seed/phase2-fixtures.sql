-- =============================================================================
-- Phase 2 CI fixtures for Cloudflare D1 (AECI-65 harness) — the SQLite port of
-- supabase/fixtures/phase2-fixtures.sql, carried over in the D1 cutover
-- (ADR 0016 / AECI-248→257). Deterministic detail/browse content so the axe +
-- Lighthouse harness has stable, indexable pages to measure.
--
-- WHY a separate file (not catalog.sql)
--   catalog.sql is a small REPRESENTATIVE local catalog. These are SYNTHETIC CI
--   fixtures with STABLE identities pinned by .lighthouserc.cjs and
--   apps/web/e2e/phase2-a11y.spec.ts — keeping them apart means catalog churn
--   never moves a Lighthouse/e2e target, and the harness fixtures stay obvious.
--   Seeded after catalog.sql via `db:seed:local`, so local dev + every CI job
--   that boots `dev:bound` (Lighthouse, e2e) gets them on the LOCAL D1.
--
--   ⚠️  TEST FIXTURES — dev / CI ONLY. Like catalog.sql, this never runs in
--   staging/production (those re-promote from Airtable via POST /api/promote).
--
-- CONTRACT (mirrors the Supabase original)
--   * Idempotent: vendors/products upsert on slug, integration + join rows
--     no-op on conflict — same posture as catalog.sql.
--   * promotion_status = 'promoted' EXPLICITLY (publicly visible).
--   * A valid integration needs two DISTINCT products (DB CHECK
--     source_product_id <> target_product_id) → a primary application +
--     a connector target.
--   * Logo URLs left NULL so CI stays hermetic (no external image fetch
--     distorting LCP); the logo component renders the initial-letter fallback.
--   * Taxonomy links resolve term ids by slug (independent of taxonomy.sql ids).
--
-- STABLE IDENTITIES (referenced by .lighthouserc.cjs + e2e/phase2-a11y.spec.ts)
--   product slug   fixture-procore                          (primary, application)
--   product slug   fixture-acme-connector                   (integration target)
--   vendor slug    fixture-procore-technologies
--   integration id 00000000-0000-4000-8000-000000000065     (detail URL key)
--   taxonomy       project-management / general-contracting / construction
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Vendor (1) — promoted, verified.
-- ---------------------------------------------------------------------------
INSERT INTO "vendors" ("id","slug","company_name","description","website","headquarters","founded_year","verified","promotion_status","created_at","updated_at") VALUES
  ('00000000-0000-4000-8000-000000000061','fixture-procore-technologies','Fixture Procore Technologies','Fixture vendor used by the AECI-65 axe + Lighthouse CI harness. A mid-sized construction-software company with a verified profile and a handful of products and integrations so the vendor detail page renders a realistic amount of content.','https://example.com/fixture-procore-technologies','Carpinteria, CA',2002,1,'promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "company_name" = excluded."company_name",
  "description" = excluded."description",
  "website" = excluded."website",
  "headquarters" = excluded."headquarters",
  "founded_year" = excluded."founded_year",
  "verified" = excluded."verified",
  "promotion_status" = excluded."promotion_status",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

-- ---------------------------------------------------------------------------
-- Products (2) — a primary application + a connector for the integration target.
-- integration_count = 1 (each participates in the single fixture integration).
-- The primary product carries a `usefulness` blob (AECI-173) so the detail page's
-- "How teams use it" section renders live in the e2e populated-state test; the
-- connector keeps NULL usefulness so it stays a real null-path page.
-- ---------------------------------------------------------------------------
INSERT INTO "products" ("id","slug","name","description","website","product_role","has_api_docs","integration_count","review_count","research_status","promotion_status","usefulness","created_at","updated_at") VALUES
  ('00000000-0000-4000-8000-000000000062','fixture-procore','Fixture Procore','Fixture product used by the AECI-65 axe + Lighthouse CI harness. A construction-management application with a description, vendor, taxonomy tags (category / audience / phase), and one integration — enough content for the product detail page to be a meaningful accessibility and performance target without being unrealistically large.','https://example.com/fixture-procore','application',0,1,0,'done','promoted','{"audiences":[{"slug":"general-contracting","name":"General Contracting","points":["Track RFIs and submittals across every job so nothing slips between trades.","Give superintendents one daily-log workflow instead of paper and spreadsheets."]}],"phases":[{"slug":"construction","name":"Construction","points":["Keep field and office on one schedule of record during active construction."]}]}', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('00000000-0000-4000-8000-000000000063','fixture-acme-connector','Fixture Acme Connector','Fixture connector product used as the target endpoint of the AECI-65 fixture integration, so the integration detail page has a valid distinct source → target pair to render.','https://example.com/fixture-acme-connector','connector',0,1,0,'done','promoted',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "website" = excluded."website",
  "product_role" = excluded."product_role",
  "integration_count" = excluded."integration_count",
  "research_status" = excluded."research_status",
  "promotion_status" = excluded."promotion_status",
  "usefulness" = excluded."usefulness",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

-- ---------------------------------------------------------------------------
-- Primary product → vendor link (is_primary).
-- ---------------------------------------------------------------------------
INSERT INTO "product_vendors" ("product_id","vendor_id","is_primary","created_at") VALUES
  ('00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000061',1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Taxonomy links — primary product tagged with one existing term per facet, so
-- the category / audience / phase BROWSE pages each render a product card. The
-- SELECT form no-ops if a referenced term is missing (taxonomy not yet seeded).
-- ---------------------------------------------------------------------------
INSERT INTO "product_categories" ("product_id","category_id","created_at")
  SELECT '00000000-0000-4000-8000-000000000062', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_categories" WHERE "slug" = 'project-management'
ON CONFLICT DO NOTHING;

INSERT INTO "product_audiences" ("product_id","audience_id","created_at")
  SELECT '00000000-0000-4000-8000-000000000062', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_audiences" WHERE "slug" = 'general-contracting'
ON CONFLICT DO NOTHING;

INSERT INTO "product_phases" ("product_id","phase_id","created_at")
  SELECT '00000000-0000-4000-8000-000000000062', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_phases" WHERE "slug" = 'construction'
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Integration (1) — pinned id (the detail-page URL key). Both endpoints are
-- promoted; built_by resolves to the fixture vendor. Fixed FK ids (seeded above).
-- ---------------------------------------------------------------------------
INSERT INTO "integrations" ("id","name","source_product_id","target_product_id","mechanism_kind","mechanism_name","direction","built_by_vendor_id","description","listing_url","docs_url","created_at","updated_at") VALUES
  ('00000000-0000-4000-8000-000000000065','Fixture Procore ↔ Acme Connector','00000000-0000-4000-8000-000000000062','00000000-0000-4000-8000-000000000063','native','Native integration','bidirectional','00000000-0000-4000-8000-000000000061','Fixture integration used by the AECI-65 axe + Lighthouse CI harness. A native, bidirectional integration between two fixture products with a built-by vendor, mechanism, and description, so the integration detail page renders a realistic amount of content.','https://example.com/fixture-integration/listing','https://example.com/fixture-integration/docs', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("id") DO NOTHING;
