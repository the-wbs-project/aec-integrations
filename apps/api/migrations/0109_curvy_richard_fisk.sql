-- AECI-1643 — a published review can be removed: `reviews.status` gains `removed`, and
-- the table gains `removed_at` and `removal_reason`.
--
-- `removed` is the admin takedown of an `approved` review (`STAGE_1_SPEC.md` §22.1,
-- `ADMIN_PANEL_SPEC.md` §5.21). It is NOT `archived`, which §17 reserves for reviews of a
-- later-rejected product and which `reviews_unique_per_user_product` ignores. The unique
-- index is unchanged, so a removed review keeps blocking a re-post, as a rejected one does
-- (§22.4).
--
-- Widening a CHECK on SQLite is a full table recreate (`docs/migrations.md` §3.3a).
--
-- ╔════════════════════════════════════════════════════════════════════════════════╗
-- ║ STATEMENT ORDER IS A DATA-LOSS CONTROL. DO NOT REORDER. DO NOT REGENERATE.      ║
-- ╚════════════════════════════════════════════════════════════════════════════════╝
--
-- HAND-ASSEMBLED from drizzle-kit output, on the `0033_solid_nightcrawler.sql` recipe.
-- FOUR edits, all mandatory:
--
--   1. THE PRAGMA. drizzle-kit emits `PRAGMA foreign_keys=OFF` / `=ON`. D1 supports only
--      `PRAGMA defer_foreign_keys = true`, which holds for the surrounding transaction and
--      resets on commit. The trailing `=ON` is DELETED, not translated. §3.3a rule 1.
--
--   2. THE CASCADE, which drizzle-kit cannot know about. `reviews` has TWO cascade
--      children: `review_responses.review_id` (AECI-1175, `0058`) and
--      `review_updates.review_id` (AECI-1613, `0108`), both `ON DELETE CASCADE`. In SQLite
--      `DROP TABLE` performs an implicit DELETE that FIRES foreign-key actions, and
--      `defer_foreign_keys` defers violation REPORTING, not cascade ACTIONS. So the
--      generated order keeps every review and deletes every vendor reply and every
--      reviewer update. Nothing references either child, so the chain is one level deep.
--      The order below parks all three tables in `CREATE TABLE … AS SELECT` carry copies
--      (no PK, no FK, no CHECK: cascade-immune by construction), empties both children
--      EXPLICITLY so the drop's cascade reaches nothing, then restores them.
--
--   3. `verified_work_email` IS KEPT. The live table still has it
--      (`integer DEFAULT false NOT NULL`, `0000_init.sql`). `0096` stopped declaring it in
--      `schema.ts` as phase one of a two-phase drop, and the phase-two `DROP COLUMN`
--      (AECI-1533) has not shipped. drizzle-kit's recreate would have dropped it as a side
--      effect, because the snapshot no longer knows it. This migration widens a CHECK and
--      adds two columns, nothing more, so the column is carried verbatim and its drop
--      stays AECI-1533's own reviewed change. drizzle-kit never reads the database, so the
--      extra column does not move the drift gate.
--
--   4. AN EXPLICIT COLUMN LIST ON EVERY COPY. The generated `INSERT … SELECT` read
--      `removed_at` and `removal_reason` from the OLD table, which has neither, so the raw
--      file does not even run. The restore below names its columns and writes the two
--      new ones as literal NULLs: no existing review is removed.
--
-- `src/test/migration-0109.spec.ts` guards this by CONSERVATION on seeded data: every
-- review, reply and update survives with its values, and both children still cascade.
-- `src/test/d1.spec.ts` pins the two-child list at HEAD.
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
-- ── 1-3. Carry the parent and both cascade children out of harm's way ──────────
CREATE TABLE `__carry_reviews` AS SELECT * FROM `reviews`;--> statement-breakpoint
CREATE TABLE `__carry_review_responses` AS SELECT * FROM `review_responses`;--> statement-breakpoint
CREATE TABLE `__carry_review_updates` AS SELECT * FROM `review_updates`;--> statement-breakpoint
-- ── 4-5. Empty both children EXPLICITLY ───────────────────────────────────────
-- Not redundant with the drop below: this is what turns the drop's cascade into a no-op
-- instead of a silent deletion.
DELETE FROM `review_responses`;--> statement-breakpoint
DELETE FROM `review_updates`;--> statement-breakpoint
-- ── 6. Drop and recreate `reviews` with the widened CHECK and two new columns ──
-- A plain DROP + CREATE rather than drizzle's `__new_reviews` copy-and-rename, as in
-- `0033`: the rows come back from the carry in step 8.
DROP TABLE `reviews`;--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`reviewer_id` text,
	`anonymized_at` text,
	`rating_overall` integer NOT NULL,
	`rating_onboarding` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`role_at_company` text,
	`years_using` integer,
	`would_recommend` text,
	`reviewer_firm` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`rejection_reason` text,
	`moderated_at` text,
	`moderated_by` text,
	`toxicity_score` integer,
	`removed_at` text,
	`removal_reason` text,
	`verified_work_email` integer DEFAULT false NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewer_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`moderated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_rating_overall_check" CHECK("rating_overall" BETWEEN 1 AND 5),
	CONSTRAINT "reviews_rating_onboarding_check" CHECK("rating_onboarding" BETWEEN 1 AND 5),
	CONSTRAINT "reviews_role_at_company_check" CHECK("role_at_company" IN ('practitioner', 'manager', 'IT', 'exec', 'other')),
	CONSTRAINT "reviews_would_recommend_check" CHECK("would_recommend" IN ('yes', 'no', 'maybe')),
	CONSTRAINT "reviews_status_check" CHECK("status" IN ('pending', 'approved', 'rejected', 'archived', 'removed'))
);--> statement-breakpoint
-- ── 7. Recreate the indexes ───────────────────────────────────────────────────
-- The unique index still ignores only `archived`, so `removed` blocks a re-post.
CREATE INDEX `reviews_product_status_idx` ON `reviews` (`product_id`,`status`);--> statement-breakpoint
CREATE INDEX `reviews_status_created_idx` ON `reviews` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_reviewer_idx` ON `reviews` (`reviewer_id`) WHERE "reviewer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_unique_per_user_product` ON `reviews` (`product_id`,`reviewer_id`) WHERE "reviewer_id" IS NOT NULL AND "status" <> 'archived';--> statement-breakpoint
-- ── 8. Restore the reviews ────────────────────────────────────────────────────
-- Explicit column list. The two new columns are literal NULLs: the carry predates them.
INSERT INTO `reviews` ("id", "product_id", "reviewer_id", "anonymized_at", "rating_overall", "rating_onboarding", "title", "body", "role_at_company", "years_using", "would_recommend", "reviewer_firm", "status", "rejection_reason", "moderated_at", "moderated_by", "toxicity_score", "removed_at", "removal_reason", "verified_work_email", "locale", "created_at", "updated_at")
  SELECT "id", "product_id", "reviewer_id", "anonymized_at", "rating_overall", "rating_onboarding", "title", "body", "role_at_company", "years_using", "would_recommend", "reviewer_firm", "status", "rejection_reason", "moderated_at", "moderated_by", "toxicity_score", NULL, NULL, "verified_work_email", "locale", "created_at", "updated_at"
    FROM `__carry_reviews`;--> statement-breakpoint
-- ── 9. Restore both children ──────────────────────────────────────────────────
-- Every `review_id` resolves: step 8 restored the reviews with their ids intact. Neither
-- child table was recreated, so its hand-written status CHECK is untouched.
INSERT INTO `review_responses` ("id", "review_id", "vendor_id", "author_profile_id", "body", "status", "rejection_reason", "moderated_by", "moderated_at", "published_at", "created_at", "updated_at")
  SELECT "id", "review_id", "vendor_id", "author_profile_id", "body", "status", "rejection_reason", "moderated_by", "moderated_at", "published_at", "created_at", "updated_at"
    FROM `__carry_review_responses`;--> statement-breakpoint
INSERT INTO `review_updates` ("id", "review_id", "body", "rating_overall", "rating_onboarding", "status", "rejection_reason", "moderated_by", "moderated_at", "published_at", "toxicity_score", "created_at", "updated_at")
  SELECT "id", "review_id", "body", "rating_overall", "rating_onboarding", "status", "rejection_reason", "moderated_by", "moderated_at", "published_at", "toxicity_score", "created_at", "updated_at"
    FROM `__carry_review_updates`;--> statement-breakpoint
-- ── 10. Drop the carry tables ─────────────────────────────────────────────────
DROP TABLE `__carry_reviews`;--> statement-breakpoint
DROP TABLE `__carry_review_responses`;--> statement-breakpoint
DROP TABLE `__carry_review_updates`;
