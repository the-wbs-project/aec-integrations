CREATE TABLE `notification_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`enabled` integer NOT NULL,
	`updated_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
