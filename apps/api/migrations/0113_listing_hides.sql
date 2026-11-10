CREATE TABLE `listing_hides` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`parent_id` text,
	`kind` text NOT NULL,
	`reason` text NOT NULL,
	`internal_note` text,
	`received_at` text NOT NULL,
	`source_url` text,
	`set_by` text,
	`set_at` text NOT NULL,
	`restored_by` text,
	`restored_at` text,
	`restore_reason` text
);
--> statement-breakpoint
CREATE INDEX `listing_hides_entity_idx` ON `listing_hides` (`entity_type`,`entity_id`,`set_at`);--> statement-breakpoint
CREATE INDEX `listing_hides_parent_idx` ON `listing_hides` (`parent_id`) WHERE "parent_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `hidden_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `hidden_hide_id` text;--> statement-breakpoint
CREATE INDEX `products_hidden_idx` ON `products` (`id`) WHERE "hidden_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `vendors` ADD `hidden_at` text;--> statement-breakpoint
ALTER TABLE `vendors` ADD `hidden_hide_id` text;--> statement-breakpoint
CREATE INDEX `vendors_hidden_idx` ON `vendors` (`id`) WHERE "hidden_at" IS NOT NULL;