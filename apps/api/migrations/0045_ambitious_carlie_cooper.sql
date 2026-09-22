-- AECI-1007 / ADR 0035 decision 6: per-side integration links.
--
-- ADDITIVE ONLY. One CREATE TABLE and one CREATE UNIQUE INDEX. No existing table is
-- touched, so nothing is recreated. `integration_vendor_links` is a NEW cascade child
-- of `integrations`, which means the next recreate of `integrations` must carry it
-- out of the way too (docs/migrations.md §3.3a). `src/test/d1.spec.ts` pins the
-- child list and `src/test/migration-0045.spec.ts` is this file's tripwire.
--
-- `product_id` has no FK on purpose: the integration's own cascade already removes
-- the link when an endpoint product goes (see the schema.ts docblock).
CREATE TABLE `integration_vendor_links` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`product_id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`vendor_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "integration_vendor_links_kind_check" CHECK("kind" IN ('listing', 'docs'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_vendor_links_side_kind_key` ON `integration_vendor_links` (`integration_id`,`product_id`,`kind`);