CREATE TABLE `gsc_recrawl_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`priority` integer NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`queued_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gsc_recrawl_queue_url_idx` ON `gsc_recrawl_queue` (`url`);--> statement-breakpoint
CREATE INDEX `gsc_recrawl_queue_priority_queued_at_idx` ON `gsc_recrawl_queue` (`priority`,`queued_at`);