CREATE TABLE `vendor_entitlements` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`tier` text DEFAULT 'verified' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`period_start` text,
	`period_end` text,
	`payer` text,
	`amount` text,
	`terms` text,
	`arranged_by` text,
	`invoice_ref` text,
	`notes` text,
	`granted_by` text,
	`granted_at` text NOT NULL,
	`ended_at` text,
	`expiry_notice_sent_at` text,
	`source_request_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`granted_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_request_id`) REFERENCES `vendor_requests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vendor_entitlements_status_check" CHECK("status" IN ('pending', 'active', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_entitlements_vendor_key` ON `vendor_entitlements` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `vendor_entitlements_status_idx` ON `vendor_entitlements` (`status`);--> statement-breakpoint
CREATE INDEX `vendor_entitlements_expiry_idx` ON `vendor_entitlements` (`period_end`) WHERE "period_end" IS NOT NULL AND "status" = 'active';