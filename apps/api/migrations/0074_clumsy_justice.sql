CREATE TABLE `agreement_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`version` text NOT NULL,
	`source` text NOT NULL,
	`email` text NOT NULL,
	`profile_id` text,
	`vendor_id` text,
	`billing_account_id` text,
	`vendor_request_id` text,
	`stripe_checkout_session_id` text,
	`accepted_at` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`billing_account_id`) REFERENCES `billing_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_request_id`) REFERENCES `vendor_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agreement_acceptances_vendor_idx` ON `agreement_acceptances` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `agreement_acceptances_billing_account_idx` ON `agreement_acceptances` (`billing_account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agreement_acceptances_stripe_session_key` ON `agreement_acceptances` (`stripe_checkout_session_id`) WHERE "stripe_checkout_session_id" IS NOT NULL;