ALTER TABLE `notification_preferences` ADD `marketing_muted_at` text;--> statement-breakpoint
ALTER TABLE `notification_preferences` ADD `marketing_mute_token` text;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_preferences_marketing_mute_token_key` ON `notification_preferences` (`marketing_mute_token`);