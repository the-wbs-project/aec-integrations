CREATE TABLE `notification_preferences` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`nudges_muted_at` text,
	`mute_token` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_mute_token_key` ON `notification_preferences` (`mute_token`);