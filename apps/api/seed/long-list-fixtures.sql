-- =============================================================================
-- Long-list fixture for Cloudflare D1 (AECI-1783 e2e, AECI-1868).
--
-- WHY THIS FILE EXISTS
--   The product page groups its Integrations section by partner category when the
--   list has 13 rows or more and fewer category groups than half the rows. No
--   other seed product has 13 integrations, so `products-long-list.spec.ts`
--   skipped itself in every fresh local D1 and in CI. This file seeds one product
--   whose list groups, and the e2e asserts against it by slug.
--
--   ⚠️  TEST FIXTURES — dev / CI only. Never staging or production. Only the
--   local `db:seed:local` chain runs this file (`wrangler d1 execute --local`).
--   The remote seed step (`scripts/d1-apply-migrations.sh`) runs taxonomy.sql,
--   data-objects.sql and trades.sql only. Real rows arrive through POST /api/promote.
--
-- WHAT IT SEEDS
--   * fixture-long-list: "Zz Fixture Long List", 14 live integrations, no
--     category, audience or phase of its own.
--   * 14 partners, fixture-long-list-partner-01..14, each in exactly one
--     integration (with the product above). No vendor, no review.
--   * 3 categories only these partners use (display_order 9010..9030):
--       alpha  partners 01-08   (8 cards: longer than the 6-card peek, so "Show more")
--       beta   partners 01, 09-11 (partner 01 sits in two categories)
--       gamma  partners 12-13
--       none   partner 14       (the uncategorised group)
--     4 groups for 14 rows, so the list groups (4 * 2 < 14).
--   * Directions mix both, a_to_b and b_to_a, with the product as source on rows
--     01-09 and as target on rows 10-14. No connector, no powered_by, no Via lane.
--   * AECi-seeded claims name data objects on rows 01, 02, 09, 10 and 14.
--
-- KEPT OUT OF THE WAY OF OTHER TESTS
--   * Every name starts "Zz Fixture", so A to Z lists put these last.
--   * created_at is 2020-01-01, older than every other seed row (they use now),
--     so "Newest" lists keep their top.
--   * The categories are new terms that no other fixture uses. They are inserted
--     here, not in taxonomy.sql, because taxonomy.sql is applied to staging and
--     production. taxonomy_data_objects is not touched.
--
-- ORDER: runs after data-objects.sql (the claims name data objects by id).
-- Idempotent: rows upsert on slug or no-op on their fixed ids.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Categories (3), local only. Each carries a description: a term without one is
-- an error-severity data-quality finding (taxonomy_missing_description).
-- ---------------------------------------------------------------------------
INSERT INTO "taxonomy_categories" ("id","slug","name","description","display_order","created_at","updated_at") VALUES
  ('00000000-0000-4000-8000-000000001820','zz-fixture-long-list-alpha','Zz Fixture Category Alpha','Local test category for the long integration list fixture. Not a real term.',9010,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001821','zz-fixture-long-list-beta','Zz Fixture Category Beta','Local test category for the long integration list fixture. Not a real term.',9020,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001822','zz-fixture-long-list-gamma','Zz Fixture Category Gamma','Local test category for the long integration list fixture. Not a real term.',9030,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "display_order" = excluded."display_order";

-- ---------------------------------------------------------------------------
-- Products (15). integration_count matches the live rows below.
-- ---------------------------------------------------------------------------
INSERT INTO "products" ("id","slug","name","description","website","product_role","integration_count","review_count","research_status","promotion_status","created_at","updated_at") VALUES
  ('00000000-0000-4000-8000-000000001800','fixture-long-list','Zz Fixture Long List','Fixture product with fourteen integrations, so the product page groups its integration list by partner category.','https://example.com/fixture-long-list','application',14,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001801','fixture-long-list-partner-01','Zz Fixture Long List Partner 01','Fixture partner of the long-list product. Listed in two categories.','https://example.com/fixture-long-list-partner-01','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001802','fixture-long-list-partner-02','Zz Fixture Long List Partner 02','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-02','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001803','fixture-long-list-partner-03','Zz Fixture Long List Partner 03','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-03','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001804','fixture-long-list-partner-04','Zz Fixture Long List Partner 04','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-04','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001805','fixture-long-list-partner-05','Zz Fixture Long List Partner 05','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-05','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001806','fixture-long-list-partner-06','Zz Fixture Long List Partner 06','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-06','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001807','fixture-long-list-partner-07','Zz Fixture Long List Partner 07','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-07','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001808','fixture-long-list-partner-08','Zz Fixture Long List Partner 08','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-08','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001809','fixture-long-list-partner-09','Zz Fixture Long List Partner 09','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-09','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001810','fixture-long-list-partner-10','Zz Fixture Long List Partner 10','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-10','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001811','fixture-long-list-partner-11','Zz Fixture Long List Partner 11','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-11','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001812','fixture-long-list-partner-12','Zz Fixture Long List Partner 12','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-12','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001813','fixture-long-list-partner-13','Zz Fixture Long List Partner 13','Fixture partner of the long-list product.','https://example.com/fixture-long-list-partner-13','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001814','fixture-long-list-partner-14','Zz Fixture Long List Partner 14','Fixture partner of the long-list product. No category.','https://example.com/fixture-long-list-partner-14','application',1,0,'done','promoted','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')
ON CONFLICT ("slug") DO UPDATE SET
  "name" = excluded."name",
  "description" = excluded."description",
  "website" = excluded."website",
  "product_role" = excluded."product_role",
  "integration_count" = excluded."integration_count",
  "research_status" = excluded."research_status",
  "promotion_status" = excluded."promotion_status",
  "created_at" = excluded."created_at";

-- ---------------------------------------------------------------------------
-- Partner categories. Resolved by slug. Partner 14 has none on purpose.
-- ---------------------------------------------------------------------------
INSERT INTO "product_categories" ("product_id","category_id","created_at")
  SELECT p.id, c.id, '2020-01-01T00:00:00.000Z'
  FROM "products" p JOIN "taxonomy_categories" c ON c.slug = 'zz-fixture-long-list-alpha'
  WHERE p.slug IN ('fixture-long-list-partner-01','fixture-long-list-partner-02','fixture-long-list-partner-03','fixture-long-list-partner-04','fixture-long-list-partner-05','fixture-long-list-partner-06','fixture-long-list-partner-07','fixture-long-list-partner-08')
ON CONFLICT DO NOTHING;

INSERT INTO "product_categories" ("product_id","category_id","created_at")
  SELECT p.id, c.id, '2020-01-01T00:00:00.000Z'
  FROM "products" p JOIN "taxonomy_categories" c ON c.slug = 'zz-fixture-long-list-beta'
  WHERE p.slug IN ('fixture-long-list-partner-01','fixture-long-list-partner-09','fixture-long-list-partner-10','fixture-long-list-partner-11')
ON CONFLICT DO NOTHING;

INSERT INTO "product_categories" ("product_id","category_id","created_at")
  SELECT p.id, c.id, '2020-01-01T00:00:00.000Z'
  FROM "products" p JOIN "taxonomy_categories" c ON c.slug = 'zz-fixture-long-list-gamma'
  WHERE p.slug IN ('fixture-long-list-partner-12','fixture-long-list-partner-13')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Integrations (14). The long-list product is source on 01-09, target on 10-14.
-- ---------------------------------------------------------------------------
INSERT INTO "integrations" ("id","name","source_product_id","target_product_id","mechanism_kind","mechanism_name","direction","created_at","updated_at") VALUES
  ('00000000-0000-4000-8000-000000001831','Zz Fixture Long List ↔ Partner 01','00000000-0000-4000-8000-000000001800','00000000-0000-4000-8000-000000001801','native','Native integration','both','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001832','Zz Fixture Long List → Partner 02','00000000-0000-4000-8000-000000001800','00000000-0000-4000-8000-000000001802','api','REST API','a_to_b','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001833','Zz Fixture Long List ← Partner 03','00000000-0000-4000-8000-000000001800','00000000-0000-4000-8000-000000001803','native','Native integration','b_to_a','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001834','Zz Fixture Long List ↔ Partner 04','00000000-0000-4000-8000-000000001800','00000000-0000-4000-8000-000000001804','api','REST API','both','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001835','Zz Fixture Long List → Partner 05','00000000-0000-4000-8000-000000001800','00000000-0000-4000-8000-000000001805','native','Native integration','a_to_b','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001836','Zz Fixture Long List ↔ Partner 06','00000000-0000-4000-8000-000000001800','00000000-0000-4000-8000-000000001806','native','Native integration','both','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001837','Zz Fixture Long List ← Partner 07','00000000-0000-4000-8000-000000001800','00000000-0000-4000-8000-000000001807','api','REST API','b_to_a','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001838','Zz Fixture Long List ↔ Partner 08','00000000-0000-4000-8000-000000001800','00000000-0000-4000-8000-000000001808','native','Native integration','both','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001839','Zz Fixture Long List → Partner 09','00000000-0000-4000-8000-000000001800','00000000-0000-4000-8000-000000001809','api','REST API','a_to_b','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001840','Partner 10 ↔ Zz Fixture Long List','00000000-0000-4000-8000-000000001810','00000000-0000-4000-8000-000000001800','native','Native integration','both','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001841','Partner 11 → Zz Fixture Long List','00000000-0000-4000-8000-000000001811','00000000-0000-4000-8000-000000001800','api','REST API','a_to_b','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001842','Partner 12 ← Zz Fixture Long List','00000000-0000-4000-8000-000000001812','00000000-0000-4000-8000-000000001800','native','Native integration','b_to_a','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001843','Partner 13 ↔ Zz Fixture Long List','00000000-0000-4000-8000-000000001813','00000000-0000-4000-8000-000000001800','api','REST API','both','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001844','Partner 14 → Zz Fixture Long List','00000000-0000-4000-8000-000000001814','00000000-0000-4000-8000-000000001800','native','Native integration','a_to_b','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- Data objects on five rows: AECi-seeded claims, each with the `aeci` attestation
-- promote would have written. Data object ids are the UUIDv5 ids in
-- data-objects.sql (projects, models, drawings, specifications, rfis, budgets).
-- ---------------------------------------------------------------------------
INSERT INTO "claims" ("id","integration_id","data_object_id","direction","origin","created_at","updated_at") VALUES
  ('00000000-0000-4000-8000-000000001851','00000000-0000-4000-8000-000000001831','d0a80355-d3b7-5a7c-8e35-7246437edf68','both','aeci','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001852','00000000-0000-4000-8000-000000001831','2d14be8b-4d2a-55f9-8d45-c1092a5302af','a_to_b','aeci','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001853','00000000-0000-4000-8000-000000001832','12f6d14b-b996-565a-beda-c35f72136e13','a_to_b','aeci','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001854','00000000-0000-4000-8000-000000001839','990704b3-6374-5639-82ad-62ed19e29811','a_to_b','aeci','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001855','00000000-0000-4000-8000-000000001840','e25eeda0-3650-5a74-b3a0-b266a3eaf1c1','both','aeci','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001856','00000000-0000-4000-8000-000000001844','32a8cbf5-7bde-5fea-ada9-4ae7a3dea1eb','a_to_b','aeci','2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "attestations" ("id","claim_id","source","asserted","created_at","updated_at") VALUES
  ('00000000-0000-4000-8000-000000001861','00000000-0000-4000-8000-000000001851','aeci',1,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001862','00000000-0000-4000-8000-000000001852','aeci',1,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001863','00000000-0000-4000-8000-000000001853','aeci',1,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001864','00000000-0000-4000-8000-000000001854','aeci',1,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001865','00000000-0000-4000-8000-000000001855','aeci',1,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z'),
  ('00000000-0000-4000-8000-000000001866','00000000-0000-4000-8000-000000001856','aeci',1,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')
ON CONFLICT ("id") DO NOTHING;
