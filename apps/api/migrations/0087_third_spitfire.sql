CREATE TABLE `page_view_classifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`page_view_id` integer NOT NULL,
	`class` text NOT NULL,
	`reason_codes` text NOT NULL,
	`classifier_version` text NOT NULL,
	`evaluated_at` text NOT NULL,
	`evidence_from` text NOT NULL,
	`evidence_to` text NOT NULL,
	`view_day` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`page_view_id`) REFERENCES `page_views`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `page_view_classifications_view_version_idx` ON `page_view_classifications` (`page_view_id`,`classifier_version`);--> statement-breakpoint
CREATE INDEX `page_view_classifications_day_idx` ON `page_view_classifications` (`view_day`,`classifier_version`,`class`);