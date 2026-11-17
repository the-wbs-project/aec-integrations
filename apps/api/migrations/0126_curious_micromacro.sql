CREATE TABLE `litigation_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`vendor_id` text,
	`reason` text NOT NULL,
	`matter_reference` text,
	`placed_by` text NOT NULL,
	`placed_at` text NOT NULL,
	`released_at` text,
	`released_by` text,
	`release_reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `litigation_holds_open_global_idx` ON `litigation_holds` (`scope`) WHERE "released_at" IS NULL AND "scope" = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX `litigation_holds_open_vendor_idx` ON `litigation_holds` (`vendor_id`) WHERE "released_at" IS NULL AND "vendor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `litigation_holds_placed_at_idx` ON `litigation_holds` (`placed_at`);