CREATE TABLE `product_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`context_product_id` text NOT NULL,
	`name` text NOT NULL,
	`maker` text NOT NULL,
	`website` text,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_product_id` text,
	`decline_reason` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text
);
--> statement-breakpoint
CREATE INDEX `product_requests_status_created_idx` ON `product_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `product_requests_vendor_created_idx` ON `product_requests` (`vendor_id`,`created_at`);