CREATE INDEX `feedback_created_at_idx` ON `feedback` (`created_at`);--> statement-breakpoint
CREATE INDEX `mailing_list_created_at_idx` ON `mailing_list` (`created_at`);--> statement-breakpoint
CREATE INDEX `mailing_list_unsubscribed_at_idx` ON `mailing_list` (`unsubscribed_at`);