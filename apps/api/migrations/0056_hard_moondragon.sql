CREATE TABLE `user_activity_daily` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`role` text NOT NULL,
	`vendor_id` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`surfaces` integer DEFAULT 0 NOT NULL,
	`arrival_utm_source` text,
	`arrival_utm_campaign` text,
	`arrival_notification_id` text,
	`arrival_at` text,
	PRIMARY KEY(`user_id`, `day`)
);
--> statement-breakpoint
CREATE INDEX `user_activity_daily_vendor_day_idx` ON `user_activity_daily` (`vendor_id`,`day`);--> statement-breakpoint
CREATE INDEX `user_activity_daily_day_idx` ON `user_activity_daily` (`day`);