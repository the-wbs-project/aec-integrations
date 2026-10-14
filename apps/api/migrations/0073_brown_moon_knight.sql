CREATE TABLE `billing_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`name` text NOT NULL,
	`billing_email` text,
	`stripe_customer_id` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `billing_accounts_vendor_key` ON `billing_accounts` (`vendor_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `billing_accounts_stripe_customer_key` ON `billing_accounts` (`stripe_customer_id`) WHERE "stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `licenses` (
	`id` text PRIMARY KEY NOT NULL,
	`billing_account_id` text NOT NULL,
	`source` text NOT NULL,
	`starts_at` text NOT NULL,
	`ends_at` text,
	`ended_at` text,
	`reference` text,
	`stripe_subscription_id` text,
	`assigned_product_id` text,
	`assigned_at` text,
	`release_at_renewal` integer DEFAULT false NOT NULL,
	`cancel_at_term_end` integer DEFAULT false NOT NULL,
	`cancel_reason` text,
	`terms_version` text,
	`granted_by` text,
	`expiry_notice_sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`billing_account_id`) REFERENCES `billing_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assigned_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `licenses_account_idx` ON `licenses` (`billing_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `licenses_live_product_idx` ON `licenses` (`assigned_product_id`) WHERE "ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `licenses_ends_idx` ON `licenses` (`ends_at`) WHERE "ended_at" IS NULL AND "ends_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `licenses_stripe_subscription_idx` ON `licenses` (`stripe_subscription_id`) WHERE "stripe_subscription_id" IS NOT NULL;