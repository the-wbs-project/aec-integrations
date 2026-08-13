CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`outcome` text,
	`detail` text,
	CONSTRAINT "job_runs_outcome_check" CHECK("outcome" IN ('ok', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_started_at_idx` ON `job_runs` (`job`,`started_at`);