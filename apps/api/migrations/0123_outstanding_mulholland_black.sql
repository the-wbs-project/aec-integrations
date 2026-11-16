CREATE TABLE `plan_change_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`kind` text NOT NULL,
	`license_id` text NOT NULL,
	`cause` text NOT NULL,
	`event_at` text NOT NULL,
	`phase` text NOT NULL,
	`due_at` text NOT NULL,
	`r2_key` text,
	`written_at` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `plan_change_snapshots_r2_key_due_at_idx` ON `plan_change_snapshots` (`r2_key`,`due_at`);--> statement-breakpoint
CREATE INDEX `plan_change_snapshots_product_event_at_idx` ON `plan_change_snapshots` (`product_id`,`event_at`);