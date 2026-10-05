CREATE TABLE `recrawl_queue_causes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel` text NOT NULL,
	`url` text NOT NULL,
	`source` text NOT NULL,
	`audit_log_id` text,
	`vendor_id` text,
	`product_id` text,
	`promote_job_id` text,
	`queued_at` text NOT NULL,
	CONSTRAINT "recrawl_queue_causes_channel_check" CHECK("channel" IN ('indexnow', 'gsc')),
	CONSTRAINT "recrawl_queue_causes_source_check" CHECK("source" IN ('vendor', 'promote', 'admin'))
);
--> statement-breakpoint
CREATE INDEX `recrawl_queue_causes_channel_url_idx` ON `recrawl_queue_causes` (`channel`,`url`);--> statement-breakpoint
CREATE TABLE `recrawl_submission_causes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`submission_id` integer NOT NULL,
	`source` text NOT NULL,
	`audit_log_id` text,
	`vendor_id` text,
	`product_id` text,
	`promote_job_id` text,
	`queued_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recrawl_submission_causes_submission_id_idx` ON `recrawl_submission_causes` (`submission_id`);--> statement-breakpoint
CREATE INDEX `recrawl_submission_causes_vendor_id_submission_id_idx` ON `recrawl_submission_causes` (`vendor_id`,`submission_id`);