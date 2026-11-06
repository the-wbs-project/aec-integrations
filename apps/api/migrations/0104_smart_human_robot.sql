ALTER TABLE `connector_evidenced_pairs` ADD `vendor_edited_at` text;--> statement-breakpoint
ALTER TABLE `field_overrides` ADD `source_url` text;--> statement-breakpoint
ALTER TABLE `integrations` ADD `vendor_edited_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `description_edited_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `profile_edited_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `usefulness_edited_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `managed_edited_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `managed_ended_at` text;--> statement-breakpoint
ALTER TABLE `vendors` ADD `plan_ended_at` text;