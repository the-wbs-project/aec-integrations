-- AECI-1613: reviewer updates to published reviews. A pure CREATE TABLE plus three
-- indexes; no existing table is recreated. `review_updates_status_check` is a
-- hand-written COLUMN constraint (the AECI-1005 pattern, docs/migrations.md §3.3a),
-- deliberately absent from schema.ts. src/test/migration-0108.spec.ts pins it.
CREATE TABLE `review_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`body` text NOT NULL,
	`rating_overall` integer,
	`rating_onboarding` integer,
	`status` text DEFAULT 'pending' NOT NULL CONSTRAINT "review_updates_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected', 'removed')),
	`rejection_reason` text,
	`moderated_by` text,
	`moderated_at` text,
	`published_at` text,
	`toxicity_score` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`moderated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "review_updates_rating_overall_check" CHECK("rating_overall" BETWEEN 1 AND 5),
	CONSTRAINT "review_updates_rating_onboarding_check" CHECK("rating_onboarding" BETWEEN 1 AND 5),
	CONSTRAINT "review_updates_ratings_pair_check" CHECK(("rating_overall" IS NULL) = ("rating_onboarding" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_updates_one_pending_key` ON `review_updates` (`review_id`) WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX `review_updates_status_created_idx` ON `review_updates` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `review_updates_review_status_published_idx` ON `review_updates` (`review_id`,`status`,`published_at`);