CREATE TABLE `vendor_abuse_cost_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`suspension_id` text NOT NULL,
	`kind` text NOT NULL,
	`work_date` text NOT NULL,
	`description` text NOT NULL,
	`minutes` integer,
	`amount_cents` integer,
	`logged_at` text NOT NULL,
	`logged_by` text NOT NULL,
	`voided_at` text,
	`voided_by` text,
	`void_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`suspension_id`) REFERENCES `vendor_suspensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vendor_abuse_cost_entries_suspension_idx` ON `vendor_abuse_cost_entries` (`suspension_id`);--> statement-breakpoint
CREATE TABLE `vendor_suspensions` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`kind` text NOT NULL,
	`rule` text NOT NULL,
	`evidence` text NOT NULL,
	`reason` text NOT NULL,
	`suspended_at` text NOT NULL,
	`suspended_by` text NOT NULL,
	`notice_sent_at` text,
	`resolution` text,
	`resolved_at` text,
	`resolved_by` text,
	`resolution_reason` text,
	`stage_2_finding` text,
	`stage_2_notice_sent_at` text,
	`statement` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_suspensions_open_idx` ON `vendor_suspensions` (`vendor_id`) WHERE "resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX `vendor_suspensions_vendor_idx` ON `vendor_suspensions` (`vendor_id`,`suspended_at`);--> statement-breakpoint
CREATE TABLE `vendor_termination_refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`suspension_id` text NOT NULL,
	`license_id` text,
	`stripe_subscription_id` text,
	`stripe_invoice_id` text,
	`stripe_payment_intent_id` text,
	`paid_cents` integer NOT NULL,
	`gross_cents` integer NOT NULL,
	`cost_applied_cents` integer NOT NULL,
	`refund_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`stripe_refund_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`suspension_id`) REFERENCES `vendor_suspensions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vendor_termination_refunds_suspension_idx` ON `vendor_termination_refunds` (`suspension_id`);