ALTER TABLE `page_views` ADD `is_bot` integer;--> statement-breakpoint
ALTER TABLE `page_views` ADD `bot_name` text;--> statement-breakpoint
CREATE INDEX `page_views_bot_idx` ON `page_views` (`is_bot`,`created_at`);