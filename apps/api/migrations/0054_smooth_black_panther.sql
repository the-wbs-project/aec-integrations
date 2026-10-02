CREATE TABLE `notification_sends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`notification_id` text NOT NULL,
	`recipient_hash` text NOT NULL,
	`tier` text NOT NULL,
	`outcome` text NOT NULL,
	`provider_message_id` text,
	`dedupe_key` text,
	`entity_type` text,
	`entity_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_sends_dedupe_key_idx` ON `notification_sends` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notification_sends_recipient_idx` ON `notification_sends` (`recipient_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_sends_notification_idx` ON `notification_sends` (`notification_id`,`created_at`);