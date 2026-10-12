CREATE TABLE `plan_inquiries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`topic` text NOT NULL,
	`email` text NOT NULL,
	`company` text NOT NULL,
	`details` text,
	`country` text,
	`city` text,
	`region` text,
	`timezone` text,
	`referrer` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plan_inquiries_created_at_idx` ON `plan_inquiries` (`created_at`);