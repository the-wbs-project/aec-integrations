CREATE TABLE `license_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`billing_account_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`quantity` integer NOT NULL,
	`starts_at` text,
	`ends_at` text NOT NULL,
	`reference` text,
	`notes` text,
	`items_json` text DEFAULT '[]' NOT NULL,
	`terms_version` text NOT NULL,
	`status` text NOT NULL,
	`granted_by` text,
	`acceptance_id` text,
	`decided_at` text,
	`decided_by` text,
	`withdraw_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`billing_account_id`) REFERENCES `billing_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `license_grants_status_ends_idx` ON `license_grants` (`status`,`ends_at`);--> statement-breakpoint
CREATE INDEX `license_grants_account_idx` ON `license_grants` (`billing_account_id`);--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `license_grant_id` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `grant_ends_at` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `method` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `text_sha256` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `seat_role` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `deal_reference` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `deal_signed_at` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `checkbox_label_sha256` text;--> statement-breakpoint
ALTER TABLE `agreement_acceptances` ADD `checkbox_default_unticked` integer;--> statement-breakpoint
ALTER TABLE `licenses` ADD `license_grant_id` text;