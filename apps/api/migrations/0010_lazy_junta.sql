CREATE TABLE `promote_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `promote_jobs_created_at_idx` ON `promote_jobs` (`created_at`);