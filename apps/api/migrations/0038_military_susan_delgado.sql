CREATE TABLE `integration_endpoint_moves` (
	`integration_id` text NOT NULL,
	`from_product_a_id` text NOT NULL,
	`from_product_b_id` text NOT NULL,
	`moved_at` text NOT NULL,
	PRIMARY KEY(`integration_id`, `from_product_a_id`, `from_product_b_id`),
	FOREIGN KEY (`from_product_a_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_product_b_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "integration_endpoint_moves_canonical_pair_check" CHECK("from_product_a_id" < "from_product_b_id")
);
--> statement-breakpoint
CREATE INDEX `integration_endpoint_moves_from_idx` ON `integration_endpoint_moves` (`from_product_a_id`,`from_product_b_id`);