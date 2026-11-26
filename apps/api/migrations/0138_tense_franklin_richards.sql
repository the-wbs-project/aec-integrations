CREATE TABLE `claim_aeci_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`claim_id` text NOT NULL,
	`replacement_claim_id` text,
	`reason` text NOT NULL,
	`internal_note` text,
	`source_url` text NOT NULL,
	`created_by` text,
	`retracted_at` text,
	`retracted_by` text,
	`retracted_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`replacement_claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`retracted_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_aeci_corrections_live_key` ON `claim_aeci_corrections` (`claim_id`) WHERE "retracted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `claim_aeci_corrections_claim_idx` ON `claim_aeci_corrections` (`claim_id`,`updated_at`);