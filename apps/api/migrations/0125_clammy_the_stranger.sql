CREATE TABLE `acceptance_chain_exports` (
	`seq` integer PRIMARY KEY NOT NULL,
	`day` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`prev_sha256` text,
	`state_sha256` text NOT NULL,
	`entries` integer NOT NULL,
	`tsa_status` text NOT NULL,
	`tsa_key` text,
	`exported_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `acceptance_chain_exports_tsa_status_idx` ON `acceptance_chain_exports` (`tsa_status`,`seq`);--> statement-breakpoint
CREATE TABLE `acceptance_chain_rows` (
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`seq` integer NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`table_name`, `row_id`)
);
