-- =============================================================================
-- Vendor replies to reviews (AECI-1175, STAGE_2_VENDOR_PORTAL_SPEC.md §11c) —
-- local dev fixtures.
--
-- WHY
--   The local seed has no reviews (the review seeder `db:seed-reviews` is a
--   by-hand preview tool), so `review_responses` would start empty and the
--   portal Reviews tab (AECI-1179), the admin queue (AECI-1177) and the public
--   render (AECI-1178) would have nothing to develop against. These rows give
--   one reply in each of the five statuses.
--
--   ⚠️  TEST FIXTURES — dev / CI only. Never staging or production. Real
--   reviews come from reviewers; real replies from vendor seats.
--
-- WHAT
--   * Eight APPROVED reviews and one PENDING review on Dynamo for Revit
--     (c…710, extension-fixtures.sql), which Autodesk (a…001, catalog.sql,
--     `verified` with an active entitlement) owns. Autodesk is the default
--     `LOCAL_VENDOR_SLUG`, so a locally seated vendor account sees them.
--     Dynamo is chosen because no e2e or Lighthouse target reads it.
--   * Five Autodesk replies, one per status: pending, published, rejected,
--     withdrawn, removed. Two more pending replies (…1158, …1159) belong to the
--     admin-queue e2e spec and are reset to pending on every run (AECI-1177).
--     The sixth approved review has no reply (the
--     "needs a reply" row). The pending review has none, and the vendor list
--     must never show it.
--   * Reviews are anonymous (`reviewer_id` NULL, `anonymized_at` NULL), like
--     the review seeder's, so no profile rows are needed. `moderated_by` on a
--     reply resolves the e2e admin from auth-fixtures.sql when it exists, and
--     is NULL otherwise, so this file also runs on its own.
--   * Dynamo's `review_count` and rating averages are recomputed from approved
--     reviews at the end, the same expression the review seeder uses, so the
--     denormalized counts stay true.
--
-- IDS
--   d0000000-0000-4000-8000-0000000011xx. Not the review seeder's `aeceed00-`
--   prefix, so its teardown never touches these rows.
--
-- ORDER: after extension-fixtures.sql and auth-fixtures.sql in db:seed:local.
-- Idempotent (INSERT OR IGNORE on the text PKs and the unique index).
-- =============================================================================

INSERT OR IGNORE INTO "reviews"
  ("id","product_id","rating_overall","rating_onboarding","title","body","role_at_company","years_using","would_recommend","status","moderated_at","created_at","updated_at") VALUES
  ('d0000000-0000-4000-8000-000000001101','c0000000-0000-4000-8000-000000000710',4,3,'Saves our design team hours each week','We script repetitive Revit tasks with Dynamo. Graphs break across Revit upgrades, which costs us a day each release.','practitioner',3,'yes','approved','2026-09-01T10:00:00.000Z','2026-09-01T09:00:00.000Z','2026-09-01T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001102','c0000000-0000-4000-8000-000000000710',5,4,'The best way into computational design','Our architects learned it in a week. Package management is the only weak spot.','manager',2,'yes','approved','2026-09-02T10:00:00.000Z','2026-09-02T09:00:00.000Z','2026-09-02T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001103','c0000000-0000-4000-8000-000000000710',2,2,'Hard to support at scale','Every office runs a different package set. IT spends too long chasing broken graphs.','IT',4,'maybe','approved','2026-09-03T10:00:00.000Z','2026-09-03T09:00:00.000Z','2026-09-03T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001104','c0000000-0000-4000-8000-000000000710',3,3,'Good, but the documentation lags','The node library is powerful. The docs trail the releases by months.','practitioner',1,'maybe','approved','2026-09-04T10:00:00.000Z','2026-09-04T09:00:00.000Z','2026-09-04T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001105','c0000000-0000-4000-8000-000000000710',1,2,'Crashes on large models','On our hospital model Dynamo crashes Revit about once a day.','practitioner',2,'no','approved','2026-09-05T10:00:00.000Z','2026-09-05T09:00:00.000Z','2026-09-05T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001106','c0000000-0000-4000-8000-000000000710',4,4,'Solid for parametric facades','We use it on every facade package now. The learning curve is real but short.','exec',5,'yes','approved','2026-09-06T10:00:00.000Z','2026-09-06T09:00:00.000Z','2026-09-06T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001107','c0000000-0000-4000-8000-000000000710',3,3,'Still waiting on moderation','A pending review. The vendor reviews list must never show it.','other',1,'maybe','pending',NULL,'2026-09-07T09:00:00.000Z','2026-09-07T09:00:00.000Z');

INSERT OR IGNORE INTO "review_responses"
  ("id","review_id","vendor_id","author_profile_id","body","status","rejection_reason","moderated_by","moderated_at","published_at","created_at","updated_at") VALUES
  ('d0000000-0000-4000-8000-000000001151','d0000000-0000-4000-8000-000000001101','a0000000-0000-4000-8000-000000000001',NULL,
    'Thank you. Dynamo 3.2 keeps graphs working across the last two Revit releases.','pending',NULL,NULL,NULL,NULL,
    '2026-09-10T09:00:00.000Z','2026-09-10T09:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001152','d0000000-0000-4000-8000-000000001102','a0000000-0000-4000-8000-000000000001',NULL,
    'Thanks for the review. The package manager was rebuilt in 3.0.
It now checks versions before it installs.','published',NULL,
    (SELECT "id" FROM "profiles" WHERE "id" = '519f1e77-6e60-440e-81a9-3354d06be0b6'),'2026-09-11T10:00:00.000Z','2026-09-11T10:00:00.000Z',
    '2026-09-11T09:00:00.000Z','2026-09-11T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001153','d0000000-0000-4000-8000-000000001103','a0000000-0000-4000-8000-000000000001',NULL,
    'Email our enterprise team and we will give you a discount if you update this review.','rejected',
    'A reply may not offer the reviewer anything or ask them to change the review.',
    (SELECT "id" FROM "profiles" WHERE "id" = '519f1e77-6e60-440e-81a9-3354d06be0b6'),'2026-09-12T10:00:00.000Z',NULL,
    '2026-09-12T09:00:00.000Z','2026-09-12T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001154','d0000000-0000-4000-8000-000000001104','a0000000-0000-4000-8000-000000000001',NULL,
    'The documentation site now tracks each release.','withdrawn',NULL,NULL,NULL,NULL,
    '2026-09-13T09:00:00.000Z','2026-09-13T11:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001155','d0000000-0000-4000-8000-000000001105','a0000000-0000-4000-8000-000000000001',NULL,
    'This reviewer clearly does not know how to use the product.','removed',
    'A reply may not attack or guess at the reviewer.',
    (SELECT "id" FROM "profiles" WHERE "id" = '519f1e77-6e60-440e-81a9-3354d06be0b6'),'2026-09-15T10:00:00.000Z',NULL,
    '2026-09-14T09:00:00.000Z','2026-09-15T10:00:00.000Z');

-- AECI-1177 — two more approved reviews, each with a PENDING Autodesk reply, for
-- `apps/web/e2e/admin-review-responses.spec.ts` to approve and reject through the
-- real queue. `INSERT OR REPLACE` on the replies, not `OR IGNORE`, so every
-- `db:seed:local` puts them back to `pending` and the spec can run again. Nothing
-- references `review_responses`, so the REPLACE's delete cascades nowhere. The
-- five rows above stay `OR IGNORE`, one per status, for development.
INSERT OR IGNORE INTO "reviews"
  ("id","product_id","rating_overall","rating_onboarding","title","body","role_at_company","years_using","would_recommend","status","moderated_at","created_at","updated_at") VALUES
  ('d0000000-0000-4000-8000-000000001108','c0000000-0000-4000-8000-000000000710',4,3,'Fast once the graphs are set up','Setup took a sprint. After that our tagging runs in minutes.','practitioner',2,'yes','approved','2026-09-08T10:00:00.000Z','2026-09-08T09:00:00.000Z','2026-09-08T10:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001109','c0000000-0000-4000-8000-000000000710',3,2,'Training was the hard part','The tool is fine. Getting the team trained took longer than we planned.','manager',1,'maybe','approved','2026-09-09T10:00:00.000Z','2026-09-09T09:00:00.000Z','2026-09-09T10:00:00.000Z');

INSERT OR REPLACE INTO "review_responses"
  ("id","review_id","vendor_id","author_profile_id","body","status","rejection_reason","moderated_by","moderated_at","published_at","created_at","updated_at") VALUES
  ('d0000000-0000-4000-8000-000000001158','d0000000-0000-4000-8000-000000001108','a0000000-0000-4000-8000-000000000001',NULL,
    'Thanks. The 3.2 templates cut setup to a day for most teams.','pending',NULL,NULL,NULL,NULL,
    '2026-09-16T09:00:00.000Z','2026-09-16T09:00:00.000Z'),
  ('d0000000-0000-4000-8000-000000001159','d0000000-0000-4000-8000-000000001109','a0000000-0000-4000-8000-000000000001',NULL,
    'Call our sales line on 555 0100 for a training bundle at half price.','pending',NULL,NULL,NULL,NULL,
    '2026-09-17T09:00:00.000Z','2026-09-17T09:00:00.000Z');

UPDATE "products" SET
  "review_count" = (SELECT COUNT(*) FROM "reviews" r WHERE r."product_id" = "products"."id" AND r."status" = 'approved'),
  "rating_overall_avg" = (SELECT ROUND(AVG(r."rating_overall"), 2) FROM "reviews" r WHERE r."product_id" = "products"."id" AND r."status" = 'approved'),
  "rating_onboarding_avg" = (SELECT ROUND(AVG(r."rating_onboarding"), 2) FROM "reviews" r WHERE r."product_id" = "products"."id" AND r."status" = 'approved')
WHERE "id" = 'c0000000-0000-4000-8000-000000000710';
