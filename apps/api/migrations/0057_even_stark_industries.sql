CREATE TABLE `vendor_activity_daily` (
	`day` text NOT NULL,
	`vendor_id` text NOT NULL,
	`seats` integer NOT NULL,
	`pending_invites` integer NOT NULL,
	`active_users_1d` integer NOT NULL,
	`active_users_7d` integer NOT NULL,
	`active_users_30d` integer NOT NULL,
	`entitlement_tier` text,
	`entitlement_status` text,
	`effective_tier` text NOT NULL,
	`open_contests_owned` integer NOT NULL,
	`open_contests_filed` integer NOT NULL,
	`data_flows_confirmed` integer NOT NULL,
	`products_total` integer NOT NULL,
	`products_confirmed` integer NOT NULL,
	`computed_at` text NOT NULL,
	PRIMARY KEY(`day`, `vendor_id`)
);
--> statement-breakpoint
CREATE INDEX `vendor_activity_daily_vendor_day_idx` ON `vendor_activity_daily` (`vendor_id`,`day`);