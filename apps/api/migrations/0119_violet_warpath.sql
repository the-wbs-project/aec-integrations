CREATE TABLE `legal_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`version` text NOT NULL,
	`effective_at` integer NOT NULL,
	`summary_json` text NOT NULL,
	`material` integer NOT NULL,
	`requires_acceptance` integer NOT NULL,
	`expedited_reason` text,
	`pdf_key` text NOT NULL,
	`pdf_sha256` text NOT NULL,
	`pdf_bytes` integer NOT NULL,
	`published_by` text NOT NULL,
	`published_at` text NOT NULL,
	`notice_enqueued_at` text,
	`notice_vendor_count` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legal_versions_document_version_key` ON `legal_versions` (`document`,`version`);