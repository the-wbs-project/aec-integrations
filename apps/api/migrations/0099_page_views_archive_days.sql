CREATE TABLE `page_views_archive_days` (
	`day` text PRIMARY KEY NOT NULL,
	`page_views_rows` integer NOT NULL,
	`classification_rows` integer NOT NULL,
	`object_key` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`archived_at` text NOT NULL
);
