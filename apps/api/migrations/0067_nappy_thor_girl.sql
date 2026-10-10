ALTER TABLE `page_views` ADD `pair_product_a_id` text REFERENCES products(id);--> statement-breakpoint
ALTER TABLE `page_views` ADD `pair_product_b_id` text REFERENCES products(id);--> statement-breakpoint
CREATE INDEX `page_views_pair_a_idx` ON `page_views` (`pair_product_a_id`,`created_at`) WHERE "pair_product_a_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `page_views_pair_b_idx` ON `page_views` (`pair_product_b_id`,`created_at`) WHERE "pair_product_b_id" IS NOT NULL;