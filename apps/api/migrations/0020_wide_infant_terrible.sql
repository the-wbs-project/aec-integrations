ALTER TABLE `page_views` ADD `dedupe_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `page_views_dedupe_key_idx` ON `page_views` (`dedupe_key`);