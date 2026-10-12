CREATE TABLE `listing_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`listing_name` text NOT NULL,
	`website` text NOT NULL,
	`submitter_email` text NOT NULL,
	`submitter_name` text,
	`submitter_role` text,
	`submitter_linkedin_url` text,
	`plan_interest` text,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `listing_requests_status_created_idx` ON `listing_requests` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `vendor_requests` ADD `plan_interest` text;