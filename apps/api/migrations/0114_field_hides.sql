CREATE TABLE `field_hides` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field` text NOT NULL,
	`reason` text NOT NULL,
	`internal_note` text,
	`source_url` text NOT NULL,
	`received_at` text NOT NULL,
	`vendor_id` text,
	`set_by` text,
	`set_at` text NOT NULL,
	`cleared_by` text,
	`cleared_at` text,
	`clear_kind` text,
	`clear_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_hides_active_key` ON `field_hides` (`entity_type`,`entity_id`,`field`) WHERE "cleared_at" IS NULL;--> statement-breakpoint
CREATE INDEX `field_hides_vendor_idx` ON `field_hides` (`vendor_id`,`set_at`) WHERE "vendor_id" IS NOT NULL;