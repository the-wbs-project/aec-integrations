CREATE TABLE `recrawl_submissions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`channel` text NOT NULL,
	`outcome` text NOT NULL,
	`http_status` integer,
	`batch_id` text NOT NULL,
	`priority` integer,
	`submitted_at` text NOT NULL,
	CONSTRAINT "recrawl_submissions_channel_check" CHECK("channel" IN ('indexnow', 'gsc_manual')),
	CONSTRAINT "recrawl_submissions_outcome_check" CHECK("outcome" IN ('accepted', 'refused', 'failed', 'requested'))
);
--> statement-breakpoint
CREATE INDEX `recrawl_submissions_url_submitted_at_idx` ON `recrawl_submissions` (`url`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `recrawl_submissions_batch_id_idx` ON `recrawl_submissions` (`batch_id`);--> statement-breakpoint
CREATE INDEX `recrawl_submissions_submitted_at_idx` ON `recrawl_submissions` (`submitted_at`);