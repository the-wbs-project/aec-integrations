CREATE TABLE `review_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`vendor_id` text NOT NULL,
	`author_profile_id` text,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`rejection_reason` text,
	`moderated_by` text,
	`moderated_at` text,
	`published_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`moderated_by`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "review_responses_status_check" CHECK("status" IN ('pending', 'published', 'rejected', 'withdrawn', 'removed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_responses_review_vendor_key` ON `review_responses` (`review_id`,`vendor_id`);--> statement-breakpoint
CREATE INDEX `review_responses_status_updated_idx` ON `review_responses` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `review_responses_vendor_updated_idx` ON `review_responses` (`vendor_id`,`updated_at`);