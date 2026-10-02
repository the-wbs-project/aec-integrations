CREATE TABLE `notification_delivery_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`svix_id` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`event_type` text NOT NULL,
	`notification_send_id` integer,
	`notification_id` text NOT NULL,
	`tier` text NOT NULL,
	`recipient_hash` text NOT NULL,
	`bounce_type` text,
	`bounce_subtype` text,
	`occurred_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_events_svix_recipient_idx` ON `notification_delivery_events` (`svix_id`,`recipient_hash`);--> statement-breakpoint
CREATE INDEX `notification_delivery_events_message_idx` ON `notification_delivery_events` (`provider_message_id`);--> statement-breakpoint
CREATE INDEX `notification_delivery_events_recipient_idx` ON `notification_delivery_events` (`recipient_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `notification_sends_provider_message_idx` ON `notification_sends` (`provider_message_id`);