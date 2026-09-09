CREATE TABLE `indexnow_queue` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`queued_at` text NOT NULL,
	`source` text DEFAULT 'promote' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `indexnow_queue_url_idx` ON `indexnow_queue` (`url`);--> statement-breakpoint
CREATE INDEX `indexnow_queue_queued_at_idx` ON `indexnow_queue` (`queued_at`);