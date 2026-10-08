CREATE TABLE `vendor_plan_pricing` (
	`vendor_id` text PRIMARY KEY NOT NULL,
	`managed_price_cents` integer,
	`price_message` text,
	`updated_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade
);
