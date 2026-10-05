CREATE TABLE `field_overrides` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field` text NOT NULL,
	`value` text,
	`reason` text NOT NULL,
	`internal_note` text,
	`vendor_id` text,
	`set_by` text,
	`set_at` text NOT NULL,
	`lifted_by` text,
	`lifted_at` text,
	`lift_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_overrides_active_key` ON `field_overrides` (`entity_type`,`entity_id`,`field`) WHERE "lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `field_overrides_entity_idx` ON `field_overrides` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `field_overrides_vendor_idx` ON `field_overrides` (`vendor_id`,`set_at`) WHERE "vendor_id" IS NOT NULL;