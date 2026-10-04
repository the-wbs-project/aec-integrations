ALTER TABLE `audit_log` ADD `vendor_id` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `product_id` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `vendor_tier` text;--> statement-breakpoint
ALTER TABLE `audit_log` ADD `vendor_entitlement_status` text;--> statement-breakpoint
CREATE INDEX `audit_log_vendor_idx` ON `audit_log` (`vendor_id`,`created_at`) WHERE "vendor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `audit_log_product_idx` ON `audit_log` (`product_id`,`created_at`) WHERE "product_id" IS NOT NULL;