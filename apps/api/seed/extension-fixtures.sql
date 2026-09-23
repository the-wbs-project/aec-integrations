-- =============================================================================
-- Extension fixtures for Cloudflare D1 (AECI-710, STAGE_1_5_SPEC.md §13.3b).
--
-- WHY THIS FILE EXISTS
--   `product_extensions` is written only by promote (`extensionOf`), and no other
--   seed file writes it, so locally both §13.3b surfaces rendered nothing. These
--   rows make them developable: Revit's page gets the "Extensions built within
--   Revit" section, and each extension's page gets the "Built within" sidebar
--   card plus the empty Integrations state that names its host.
--
--   ⚠️  TEST FIXTURES — dev / CI only. Never staging or production. Real rows
--   arrive only through POST /api/promote.
--
-- WHAT EACH ROW COVERS
--   * Dynamo      — an extension WITH a vendor (Autodesk): the tile's vendor line.
--   * pyRevit     — an extension with NO vendor: the tile collapses to the name.
--   Both are real Revit add-ins, so the fixture teaches the right relation.
--   Neither has an integration, so both render the host-naming empty state.
--
-- ORDER: runs after catalog.sql (Revit and the Autodesk vendor must exist).
-- Idempotent (INSERT OR IGNORE), so it is safe to re-run on its own.
-- =============================================================================

INSERT OR IGNORE INTO "products" ("id","slug","name","description","website","product_role","has_api_docs","integration_count","review_count","research_status","promotion_status","created_at","updated_at") VALUES
  ('c0000000-0000-4000-8000-000000000710','dynamo-for-revit','Dynamo for Revit','Visual programming for computational design, running inside Revit.','https://dynamobim.org','application',0,0,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('c0000000-0000-4000-8000-000000000711','pyrevit','pyRevit','Rapid add-in prototyping and scripting toolkit for Revit.','https://pyrevitlabs.io','application',0,0,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Dynamo is Autodesk's (seeded in catalog.sql). pyRevit deliberately has no vendor.
INSERT OR IGNORE INTO "product_vendors" ("product_id","vendor_id","is_primary","created_at") VALUES
  ('c0000000-0000-4000-8000-000000000710','a0000000-0000-4000-8000-000000000001',1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- Both are built within Revit (b0000000-…-0001, catalog.sql).
INSERT OR IGNORE INTO "product_extensions" ("product_id","host_product_id","created_at") VALUES
  ('c0000000-0000-4000-8000-000000000710','b0000000-0000-4000-8000-000000000001', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('c0000000-0000-4000-8000-000000000711','b0000000-0000-4000-8000-000000000001', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
