CREATE TABLE `integration_field_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text NOT NULL,
	`field` text NOT NULL,
	`current_value` text,
	`proposed_value` text,
	`reason` text NOT NULL,
	`submitter_vendor_id` text NOT NULL,
	`submitted_by` text,
	`routed_to` text NOT NULL,
	`owner_vendor_id` text,
	`status` text DEFAULT 'open' NOT NULL,
	`decision_note` text,
	`decided_by` text,
	`decided_at` text,
	`upstream_linear_issue_id` text,
	`upstream_linear_issue_url` text,
	`workflow_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitter_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`submitted_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflow_instances`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "integration_field_challenges_field_check" CHECK("field" IN ('name', 'mechanism_kind', 'mechanism_name', 'direction', 'description', 'listing_url', 'docs_url', 'website', 'mechanism_url', 'pricing_model', 'maturity', 'owner')),
	CONSTRAINT "integration_field_challenges_routed_to_check" CHECK("routed_to" IN ('owner', 'aeci')),
	CONSTRAINT "integration_field_challenges_status_check" CHECK("status" IN ('open', 'accepted', 'declined', 'withdrawn'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_field_challenges_open_key` ON `integration_field_challenges` (`integration_id`,`field`,`submitter_vendor_id`) WHERE "status" = 'open';--> statement-breakpoint
CREATE INDEX `integration_field_challenges_owner_idx` ON `integration_field_challenges` (`owner_vendor_id`,`status`);--> statement-breakpoint
CREATE INDEX `integration_field_challenges_queue_idx` ON `integration_field_challenges` (`routed_to`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `integration_field_challenges_submitter_idx` ON `integration_field_challenges` (`submitter_vendor_id`,`updated_at`);