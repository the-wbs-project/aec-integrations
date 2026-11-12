CREATE TABLE `legal_notice_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`legal_version_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legal_notice_deliveries_version_vendor_key` ON `legal_notice_deliveries` (`legal_version_id`,`vendor_id`);