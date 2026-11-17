CREATE TABLE `dmca_notices` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`notice_id` text,
	`received_at` text NOT NULL,
	`submitter_name` text,
	`submitter_contact` text,
	`content_identified` text,
	`work_claimed` text,
	`account_id` text,
	`vendor_id` text,
	`action` text DEFAULT 'pending' NOT NULL,
	`action_at` text,
	`forwarded_at` text,
	`court_action_at` text,
	`restore_outcome` text,
	`restore_outcome_at` text,
	`closed_at` text,
	`notes` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dmca_notices_account_kind_idx` ON `dmca_notices` (`account_id`,`kind`) WHERE "account_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `dmca_notices_notice_id_idx` ON `dmca_notices` (`notice_id`);--> statement-breakpoint
CREATE INDEX `dmca_notices_received_at_idx` ON `dmca_notices` (`received_at`);