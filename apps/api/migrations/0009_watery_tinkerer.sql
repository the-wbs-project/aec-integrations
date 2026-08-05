CREATE TABLE `product_trades` (
	`product_id` text NOT NULL,
	`trade_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`product_id`, `trade_id`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trade_id`) REFERENCES `taxonomy_trades`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `product_trades_trade_idx` ON `product_trades` (`trade_id`);--> statement-breakpoint
CREATE TABLE `taxonomy_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`display_order` integer,
	`aliases` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `taxonomy_trades_slug_key` ON `taxonomy_trades` (`slug`);