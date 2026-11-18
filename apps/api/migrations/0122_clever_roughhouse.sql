CREATE TABLE `legal_notice_reader_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`legal_version_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legal_notice_reader_deliveries_version_profile_key` ON `legal_notice_reader_deliveries` (`legal_version_id`,`profile_id`);--> statement-breakpoint
CREATE TABLE `terms_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`version` text NOT NULL,
	`legal_version_id` text,
	`profile_id` text NOT NULL,
	`email` text NOT NULL,
	`accepted_at` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`checkbox_label` text NOT NULL,
	`checkbox_label_sha256` text NOT NULL,
	`checkbox_default_unticked` integer NOT NULL,
	`pdf_sha256` text,
	`evidence_removed_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `terms_acceptances_profile_document_version_key` ON `terms_acceptances` (`profile_id`,`document`,`version`);