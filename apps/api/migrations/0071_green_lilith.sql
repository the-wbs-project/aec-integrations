CREATE TABLE `profile_audiences` (
	`profile_id` text NOT NULL,
	`audience_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`profile_id`, `audience_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`audience_id`) REFERENCES `taxonomy_audiences`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_audiences_audience_idx` ON `profile_audiences` (`audience_id`);--> statement-breakpoint
CREATE TABLE `profile_details` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`company_type` text,
	`company_size` text,
	`primary_role` text,
	`firm_name` text,
	`linkedin_url` text,
	`onboarding_completed_at` text,
	`onboarding_skipped_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
