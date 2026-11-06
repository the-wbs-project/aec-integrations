CREATE TABLE `claim_thread_acknowledgments` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`integration_id` text NOT NULL,
	`other_vendor_id` text NOT NULL,
	`profile_id` text,
	`text_version` text NOT NULL,
	`acknowledged_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_thread_acknowledgments_key` ON `claim_thread_acknowledgments` (`vendor_id`,`integration_id`,`other_vendor_id`);--> statement-breakpoint
CREATE INDEX `claim_thread_acknowledgments_profile_idx` ON `claim_thread_acknowledgments` (`profile_id`);