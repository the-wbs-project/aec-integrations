CREATE TABLE `metrics_daily` (
	`day` text NOT NULL,
	`metric` text NOT NULL,
	`value` real NOT NULL,
	`source` text DEFAULT 'measured' NOT NULL,
	`computed_at` text NOT NULL,
	PRIMARY KEY(`day`, `metric`),
	CONSTRAINT "metrics_daily_source_check" CHECK("source" IN ('measured', 'reconstructed'))
);
--> statement-breakpoint
CREATE INDEX `metrics_daily_metric_day_idx` ON `metrics_daily` (`metric`,`day`);--> statement-breakpoint
ALTER TABLE `products` ADD `promoted_at` text;