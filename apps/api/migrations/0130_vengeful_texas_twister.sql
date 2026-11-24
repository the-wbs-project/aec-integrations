CREATE TABLE `claim_owner_answers` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`vendor_id` text,
	`asserted` integer NOT NULL,
	`retracted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_owner_answers_live_key` ON `claim_owner_answers` (`claim_id`) WHERE "retracted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `claim_owner_answers_claim_idx` ON `claim_owner_answers` (`claim_id`,`updated_at`);