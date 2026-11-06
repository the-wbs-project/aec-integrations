-- =============================================================================
-- Reviewer updates to published reviews (AECI-1613, STAGE_1_SPEC.md §4.7a) —
-- local dev fixtures.
--
-- WHY
--   The local seed has no review updates, so the product page, `/account` "Your
--   reviews" and the `/admin/review-updates` queue would have nothing to develop
--   against.
--
--   ⚠️  TEST FIXTURES — dev / CI only. Never staging or production.
--
-- WHAT
--   * Two more APPROVED reviews on Dynamo for Revit (c…710), dated before every
--     review in review-response-fixtures.sql, so they sort last on the product
--     page and never push that file's replies off the first page.
--   * …1110 belongs to the e2e test admin (519f…, auth-fixtures.sql) when that
--     profile exists, and is anonymous otherwise, so this file also runs on its
--     own. It carries a REJECTED update and an APPROVED update that re-rates it
--     2/2 → 4/4. That review therefore averages at 4/4, not 2/2.
--   * …1111 is anonymous and carries one PENDING update that re-rates it, for the
--     admin queue. A pending update counts nowhere.
--   * Dynamo's counts and averages are recomputed at the end with the effective
--     rating rule (`effectiveReviewRatingSql` in @aeci/shared/seed-reviews).
--
-- IDS
--   Reviews d0000000-0000-4000-8000-0000000011{10,11}; updates
--   d0000000-0000-4000-8000-0000000011{60,61,62}.
--
-- ORDER: after review-response-fixtures.sql in db:seed:local. Idempotent; …1162 is reset to pending each run
-- (INSERT OR IGNORE on the text PKs). Nothing references `review_updates`.
-- =============================================================================

INSERT OR IGNORE INTO "reviews"
  ("id","product_id","reviewer_id","rating_overall","rating_onboarding","title","body","role_at_company","years_using","would_recommend","status","moderated_at","created_at","updated_at") VALUES
  ('d0000000-0000-4000-8000-000000001110','c0000000-0000-4000-8000-000000000710',
    (SELECT "id" FROM "profiles" WHERE "id" = '519f1e77-6e60-440e-81a9-3354d06be0b6'),
    2,2,'Graphs broke on every Revit upgrade','Each Revit release broke half our graphs, and the fixes took our BIM team most of a week every time.','manager',3,'maybe','approved','2026-08-20T10:00:00.000Z','2026-08-20T09:00:00.000Z','2026-08-20T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001111','c0000000-0000-4000-8000-000000000710',NULL,
    3,3,'Fine for small scripts','Good for small automation. Bigger graphs get slow and hard to read, so we keep them short.','practitioner',1,'maybe','approved','2026-08-21T10:00:00.000Z','2026-08-21T09:00:00.000Z','2026-08-21T10:00:00.000Z');

INSERT OR IGNORE INTO "review_updates"
  ("id","review_id","body","rating_overall","rating_onboarding","status","rejection_reason","moderated_by","moderated_at","published_at","toxicity_score","created_at","updated_at") VALUES
  ('d0000000-0000-4000-8000-000000001160','d0000000-0000-4000-8000-000000001110',
    'Autodesk sent me a gift card to update this review, so here is my update. Five stars now.',5,5,'rejected',
    'An update may not follow an incentive from the vendor.',
    (SELECT "id" FROM "profiles" WHERE "id" = '519f1e77-6e60-440e-81a9-3354d06be0b6'),'2026-09-02T10:00:00.000Z',NULL,NULL,
    '2026-09-01T09:00:00.000Z','2026-09-02T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001161','d0000000-0000-4000-8000-000000001110',
    'Dynamo 3.2 fixed the upgrade breakage for us.
Our graphs came through the last two Revit releases with no rework.',4,4,'approved',NULL,
    (SELECT "id" FROM "profiles" WHERE "id" = '519f1e77-6e60-440e-81a9-3354d06be0b6'),'2026-09-20T10:00:00.000Z','2026-09-20T10:00:00.000Z',NULL,
    '2026-09-19T09:00:00.000Z','2026-09-20T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001162','d0000000-0000-4000-8000-000000001111',
    'The 3.2 release made large graphs much faster. We now run our whole tagging workflow in one graph.',4,4,'pending',NULL,NULL,NULL,NULL,NULL,
    '2026-10-01T09:00:00.000Z','2026-10-01T09:00:00.000Z');

-- Reset …1162 to pending on every seed run, so the admin e2e that decides it can run again.
UPDATE "review_updates" SET
  "status" = 'pending', "rejection_reason" = NULL, "moderated_by" = NULL, "moderated_at" = NULL,
  "published_at" = NULL, "updated_at" = '2026-10-01T09:00:00.000Z'
WHERE "id" = 'd0000000-0000-4000-8000-000000001162';

UPDATE "products" SET
  "review_count" = (SELECT COUNT(*) FROM "reviews" r WHERE r."product_id" = "products"."id" AND r."status" = 'approved'),
  "rating_overall_avg" = (SELECT ROUND(AVG(COALESCE((SELECT u."rating_overall" FROM "review_updates" u WHERE u."review_id" = r."id" AND u."status" = 'approved' AND u."rating_overall" IS NOT NULL ORDER BY u."published_at" DESC, u."id" DESC LIMIT 1), r."rating_overall")), 2) FROM "reviews" r WHERE r."product_id" = "products"."id" AND r."status" = 'approved'),
  "rating_onboarding_avg" = (SELECT ROUND(AVG(COALESCE((SELECT u."rating_onboarding" FROM "review_updates" u WHERE u."review_id" = r."id" AND u."status" = 'approved' AND u."rating_onboarding" IS NOT NULL ORDER BY u."published_at" DESC, u."id" DESC LIMIT 1), r."rating_onboarding")), 2) FROM "reviews" r WHERE r."product_id" = "products"."id" AND r."status" = 'approved')
WHERE "id" = 'c0000000-0000-4000-8000-000000000710';
