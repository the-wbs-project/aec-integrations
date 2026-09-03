-- Local-dev catalog fixture for Cloudflare D1 (ADR 0016 / AECI-252, AECI-256).
-- A small PROMOTED catalog so the local app renders non-empty browse/detail/home
-- without a remote DB. NOT used in staging/production (those re-promote from
-- Airtable via POST /api/promote). Idempotent: vendors/products upsert on slug,
-- integrations + join rows no-op on conflict. Taxonomy links resolve category/
-- audience/phase/trade ids by slug, so this file is independent of the
-- taxonomy.sql / trades.sql ids.
--
-- Fixed UUIDs (valid v4 shape) keep integrations/joins referentially stable.

-- ---------------------------------------------------------------------------
-- Vendors (promoted)
-- ---------------------------------------------------------------------------
INSERT INTO "vendors" ("id","slug","company_name","description","website","headquarters","verified","promotion_status","created_at","updated_at") VALUES
  ('a0000000-0000-4000-8000-000000000001','autodesk','Autodesk','Design and make software for AEC, manufacturing, and media.','https://www.autodesk.com','San Francisco, CA, USA',1,'promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('a0000000-0000-4000-8000-000000000002','procore','Procore Technologies','Cloud-based construction management platform.','https://www.procore.com','Carpinteria, CA, USA',1,'promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- bluebeam is deliberately verified = 0: it carries the `revoked` entitlement row
  -- below, and `verified` is a MIRROR of an `active` row (AECI-609 / §2.1). Seeding it
  -- as 1 would make `entitlement_mirror_drift` flag the local DB on the first cron run.
  ('a0000000-0000-4000-8000-000000000003','bluebeam','Bluebeam','PDF markup and collaboration for design and construction.','https://www.bluebeam.com','Pasadena, CA, USA',0,'promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Trade-specific vendors (AECI-544). Needed so the local catalog exercises the
  -- fourth facet at all: none of the five products above may carry a trade tag.
  -- trimble is verified = 1, so AECI-609's mirror invariant requires it to carry an
  -- `active` entitlement row below — otherwise `entitlement_mirror_drift` flags it.
  ('a0000000-0000-4000-8000-000000000004','trimble','Trimble','Estimating, fabrication, and field software for specialty contractors.','https://www.trimble.com','Westminster, CO, USA',1,'promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('a0000000-0000-4000-8000-000000000005','mccormick-systems','McCormick Systems','Estimating software for electrical and plumbing contractors.','https://www.mccormicksys.com','Chandler, AZ, USA',0,'promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('a0000000-0000-4000-8000-000000000006','conest','ConEst Software Systems','Electrical estimating and project management software.','https://www.conest.com','Manchester, NH, USA',0,'promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "company_name" = excluded."company_name",
  "description" = excluded."description",
  -- `verified` MUST be refreshed here (AECI-609). Without it, re-seeding an existing
  -- local D1 leaves bluebeam at its old `verified = 1` while the entitlement upsert
  -- below sets `revoked` — mirror drift that only reproduces for developers with a
  -- pre-existing DB, and surfaces as an unrelated-looking data-quality error.
  "verified" = excluded."verified",
  "promotion_status" = excluded."promotion_status",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

-- ---------------------------------------------------------------------------
-- Vendor entitlements (AECI-609 / STAGE_2_PAID_TIERS_SPEC.md §2.4)
-- ---------------------------------------------------------------------------
-- `vendors.verified` is a MIRROR of an `active` row here, so these MUST agree with the
-- `verified` values above or `entitlement_mirror_drift` flags the local DB. Three
-- deliberate states are seeded across the seed set so every downstream AECI-515 issue
-- has something local to work against:
--   * near-expiry active — autodesk (+20d), so the §7 expiry cron has a local bite
--   * far-future active  — procore, trimble (and the …061 fixture vendor in
--                          phase2-fixtures). trimble is here because AECI-544 seeded it
--                          verified = 1 for the trades facet; every verified vendor needs
--                          a backing row or the mirror check flags it.
--   * revoked            — bluebeam, so §8's downgraded read-only dashboard is
--                          demoable without hand-editing D1. Its vendor is verified = 0.
-- `granted_by` is NULL in every row: db:seed:local runs catalog.sql BEFORE
-- auth-fixtures.sql, so no `profiles` row exists yet and a non-null FK would fail.
-- Idempotent on the unique index `vendor_entitlements_vendor_key`.
INSERT INTO "vendor_entitlements"
  ("id","vendor_id","tier","status","period_start","period_end","payer","amount","terms","arranged_by","invoice_ref","notes","granted_by","granted_at","ended_at","created_at","updated_at") VALUES
  ('e0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','verified','active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-345 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+20 days'),'Autodesk AP','USD 5,000 / yr','Annual, net 30','Local Seed','SEED-0001','Local seed: NEAR-EXPIRY active term, so the AECI-613 expiry cron has something to warn on locally.',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('e0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000002','verified','active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 years'),'Procore AP','USD 5,000 / yr','Annual, net 30','Local Seed','SEED-0002','Local seed: far-future active term — the quiet steady state.',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('e0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000003','verified','revoked', strftime('%Y-%m-%dT%H:%M:%fZ','now','-400 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-35 days'),'Bluebeam AP','USD 5,000 / yr','Annual, net 30','Local Seed','SEED-0003','Local seed: REVOKED, so the AECI-614 downgraded read-only dashboard is demoable. Its vendor is verified = 0 — that is the mirror invariant, not a data error.',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now','-400 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now','-35 days'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('e0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000004','verified','active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now','+10 years'),'Trimble AP','USD 5,000 / yr','Annual, net 30','Local Seed','SEED-0004','Local seed: far-future active term backing the AECI-544 trades vendor, whose verified = 1 would otherwise be unmirrored. Also the only verified vendor carrying a trade tag, so the badge is demoable on /trades/:slug.',NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("vendor_id") DO UPDATE SET
  "tier" = excluded."tier",
  "status" = excluded."status",
  "period_start" = excluded."period_start",
  "period_end" = excluded."period_end",
  "payer" = excluded."payer",
  "amount" = excluded."amount",
  "terms" = excluded."terms",
  "arranged_by" = excluded."arranged_by",
  "invoice_ref" = excluded."invoice_ref",
  "notes" = excluded."notes",
  "ended_at" = excluded."ended_at",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

-- ---------------------------------------------------------------------------
-- Products (promoted)
-- ---------------------------------------------------------------------------
INSERT INTO "products" ("id","slug","name","description","website","product_role","has_api_docs","integration_count","review_count","research_status","promotion_status","created_at","updated_at") VALUES
  ('b0000000-0000-4000-8000-000000000001','revit','Revit','BIM authoring for architecture, structure, and MEP.','https://www.autodesk.com/products/revit','application',1,2,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000002','autocad','AutoCAD','2D and 3D CAD drafting and documentation.','https://www.autodesk.com/products/autocad','application',1,0,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000003','navisworks','Navisworks','3D model review and clash detection / coordination.','https://www.autodesk.com/products/navisworks','application',0,1,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000004','procore','Procore','Construction project, quality, and financials management.','https://www.procore.com','application',1,2,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000005','bluebeam-revu','Bluebeam Revu','PDF-based takeoff, markup, and collaboration.','https://www.bluebeam.com/solutions/revu','application',0,1,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- Trade-specific products (AECI-544) — see the product_trades block at the
  -- foot of this file for which trades they carry and why.
  ('b0000000-0000-4000-8000-000000000006','trimble-accubid-classic','Trimble Accubid Classic','Electrical estimating with prebuilt electrical assemblies and live material pricing.','https://www.trimble.com','application',0,0,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000007','mccormick-estimating','McCormick Estimating','Electrical and plumbing estimating with trade-specific assemblies and takeoff.','https://www.mccormicksys.com','application',0,0,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000008','conest-intellibid','ConEst IntelliBid','Electrical estimating and bid management for electrical contractors.','https://www.conest.com','application',0,0,0,'done','promoted', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "integration_count" = excluded."integration_count",
  "promotion_status" = excluded."promotion_status",
  "updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now');

-- ---------------------------------------------------------------------------
-- Product ↔ Vendor (primary)
-- ---------------------------------------------------------------------------
INSERT INTO "product_vendors" ("product_id","vendor_id","is_primary","created_at") VALUES
  ('b0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001',1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000001',1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000003','a0000000-0000-4000-8000-000000000001',1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000002',1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000005','a0000000-0000-4000-8000-000000000003',1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000006','a0000000-0000-4000-8000-000000000004',1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000007','a0000000-0000-4000-8000-000000000005',1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('b0000000-0000-4000-8000-000000000008','a0000000-0000-4000-8000-000000000006',1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Integrations (both endpoints promoted → publicly visible)
-- ---------------------------------------------------------------------------
INSERT INTO "integrations" ("id","name","source_product_id","target_product_id","mechanism_kind","mechanism_name","direction","created_at","updated_at") VALUES
  ('c0000000-0000-4000-8000-000000000001','Revit ↔ Navisworks','b0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000003','native','Model export','bidirectional', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('c0000000-0000-4000-8000-000000000002','Revit → Procore','b0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000004','marketplace-app','Procore + Autodesk Construction Cloud','one-way', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('c0000000-0000-4000-8000-000000000003','Procore ↔ Bluebeam Revu','b0000000-0000-4000-8000-000000000004','b0000000-0000-4000-8000-000000000005','api','REST API','bidirectional', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Product ↔ taxonomy (resolve ids by slug — independent of taxonomy.sql ids)
-- ---------------------------------------------------------------------------
INSERT INTO "product_categories" ("product_id","category_id","created_at")
  SELECT 'b0000000-0000-4000-8000-000000000001', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_categories" WHERE "slug" IN ('bim-authoring','design-visualization')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000002', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_categories" WHERE "slug" IN ('bim-authoring','design-visualization')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000003', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_categories" WHERE "slug" IN ('bim-coordination')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000004', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_categories" WHERE "slug" IN ('construction-management','project-management')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000005', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_categories" WHERE "slug" IN ('document-management','punch-list-qa-qc')
ON CONFLICT DO NOTHING;

-- Trade-specific products (AECI-544) go in their own statements: D1's SQLite
-- caps the number of terms in a compound SELECT, and the chains above are at it.
INSERT INTO "product_categories" ("product_id","category_id","created_at")
  SELECT 'b0000000-0000-4000-8000-000000000006', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_categories" WHERE "slug" IN ('estimating-takeoff')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000007', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_categories" WHERE "slug" IN ('estimating-takeoff')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000008', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_categories" WHERE "slug" IN ('estimating-takeoff','bid-management')
ON CONFLICT DO NOTHING;

INSERT INTO "product_audiences" ("product_id","audience_id","created_at")
  SELECT 'b0000000-0000-4000-8000-000000000001', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_audiences" WHERE "slug" IN ('architecture','structural-engineering','bim-manager')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000003', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_audiences" WHERE "slug" IN ('bim-coordinator','general-contracting')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000004', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_audiences" WHERE "slug" IN ('construction-management','project-manager','general-contracting')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000005', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_audiences" WHERE "slug" IN ('general-contracting','estimator')
ON CONFLICT DO NOTHING;

INSERT INTO "product_audiences" ("product_id","audience_id","created_at")
  SELECT 'b0000000-0000-4000-8000-000000000006', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_audiences" WHERE "slug" IN ('specialty-contracting','estimator')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000007', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_audiences" WHERE "slug" IN ('specialty-contracting','estimator')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000008', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_audiences" WHERE "slug" IN ('specialty-contracting','estimator')
ON CONFLICT DO NOTHING;

INSERT INTO "product_phases" ("product_id","phase_id","created_at")
  SELECT 'b0000000-0000-4000-8000-000000000001', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_phases" WHERE "slug" IN ('design','pre-construction')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000003', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_phases" WHERE "slug" IN ('design','pre-construction')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000004', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_phases" WHERE "slug" IN ('construction','closeout-operations')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000005', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_phases" WHERE "slug" IN ('construction')
ON CONFLICT DO NOTHING;

INSERT INTO "product_phases" ("product_id","phase_id","created_at")
  SELECT 'b0000000-0000-4000-8000-000000000006', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_phases" WHERE "slug" IN ('pre-construction')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000007', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_phases" WHERE "slug" IN ('pre-construction')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000008', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_phases" WHERE "slug" IN ('pre-construction')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Product ↔ trades (AECI-544). The fourth facet is SPARSE BY DESIGN: a product
-- is tagged only when it has trade-specific value — trade assemblies, cost
-- databases, templates, takeoff logic, or integrations (TRADES_VOCABULARY.md
-- §1.1). Horizontal platforms get NO trade tags, which is why Revit, AutoCAD,
-- Navisworks, Procore, and Bluebeam Revu are absent below. Copying this block
-- for a general-purpose tool would be a tagging error, not a fixture shortcut.
--
-- Both tagged terms clear the publication floor (`TRADE_PUBLISH_MIN_PRODUCTS = 1`,
-- §6), and their different depths are what makes the gate testable:
--   electrical → 3 products → PUBLISHED  (listed on /trades, offered in nav)
--   plumbing   → 1 product  → PUBLISHED  — the single-item page the floor of 1
--                                          deliberately admits; do not pad it
-- The UNPUBLISHED side of the gate is any of the other 32 seeded trades, which
-- carry no products at all — that is what `e2e/meta.spec.ts` picks up when it
-- looks for a term below the floor, so it needs no tagged term to stay thin.
-- ---------------------------------------------------------------------------
INSERT INTO "product_trades" ("product_id","trade_id","created_at")
  SELECT 'b0000000-0000-4000-8000-000000000006', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_trades" WHERE "slug" IN ('electrical')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000007', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_trades" WHERE "slug" IN ('electrical','plumbing')
  UNION ALL SELECT 'b0000000-0000-4000-8000-000000000008', id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM "taxonomy_trades" WHERE "slug" IN ('electrical')
ON CONFLICT DO NOTHING;
