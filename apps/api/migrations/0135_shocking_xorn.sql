CREATE TABLE `sync_service_veto_objections` (
	`id` text PRIMARY KEY NOT NULL,
	`veto_id` text NOT NULL,
	`vendor_id` text,
	`vendor_name` text,
	`ground` text NOT NULL,
	`explanation` text NOT NULL,
	`source_url` text,
	`filed_by` text,
	`status` text DEFAULT 'open' NOT NULL,
	`decision_note` text,
	`decided_by` text,
	`decided_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`veto_id`) REFERENCES `sync_service_pair_vetoes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`filed_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "sync_service_veto_objections_ground_check" CHECK("ground" IN ('unauthorised_account', 'wrong_product', 'reason_plainly_false')),
	CONSTRAINT "sync_service_veto_objections_status_check" CHECK("status" IN ('open', 'accepted', 'declined', 'closed')),
	CONSTRAINT "sync_service_veto_objections_source_check" CHECK("ground" <> 'reason_plainly_false' OR "source_url" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_service_veto_objections_open_key` ON `sync_service_veto_objections` (`veto_id`) WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX `sync_service_veto_objections_veto_idx` ON `sync_service_veto_objections` (`veto_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sync_service_veto_objections_status_idx` ON `sync_service_veto_objections` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `sync_service_pair_vetoes` ADD `reason_code` text;--> statement-breakpoint
ALTER TABLE `sync_service_pair_vetoes` ADD `end_reason` text;