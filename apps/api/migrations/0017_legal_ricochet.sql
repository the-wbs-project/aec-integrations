CREATE TABLE `asn_registry` (
	`asn` integer PRIMARY KEY NOT NULL,
	`info_type` text,
	`as_name` text,
	`source` text NOT NULL,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `asn_registry_fetched_at_idx` ON `asn_registry` (`fetched_at`);