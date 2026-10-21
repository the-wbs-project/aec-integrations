CREATE TABLE `ownership_sync_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vendor_id` text NOT NULL,
	`reason` text NOT NULL,
	`message_id` text,
	`attempt` integer NOT NULL,
	`outcome` text NOT NULL,
	`http_status` integer,
	`record_version` integer,
	`owner` text,
	`product_count` integer,
	`integration_count` integer,
	`error` text,
	`duration_ms` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ownership_sync_deliveries_vendor_idx` ON `ownership_sync_deliveries` (`vendor_id`,`created_at`);