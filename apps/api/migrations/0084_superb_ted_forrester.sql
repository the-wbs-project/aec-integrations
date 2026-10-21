-- AECI-1416 (E6b.4): product proposals (ADR 0042, REVIEW_APP_PROMOTE_API.md §4a). A new
-- product the review app sends for a vendor that owns its record is stored here instead
-- of being created. drizzle-kit's output, unedited: one CREATE TABLE and two indexes on a
-- new table, so no existing table is recreated and no ON DELETE action fires
-- (`docs/migrations.md` §0). `src/test/migration-0084.spec.ts` is the tripwire.
CREATE TABLE `product_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`ref` text NOT NULL,
	`payload` text NOT NULL,
	`proposed_at` text NOT NULL,
	`promote_job_id` text,
	`decision` text,
	`decided_at` text,
	`decided_by` text,
	`created_product_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_proposals_decision_check" CHECK("decision" IS NULL OR "decision" IN ('accepted', 'declined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_proposals_ref_key` ON `product_proposals` (`ref`);--> statement-breakpoint
CREATE INDEX `product_proposals_vendor_open_idx` ON `product_proposals` (`vendor_id`,`proposed_at`) WHERE "decision" IS NULL;