ALTER TABLE `vendor_seat_invites` ADD `last_sent_at` text;--> statement-breakpoint
ALTER TABLE `vendor_seat_invites` ADD `send_count` integer DEFAULT 1 NOT NULL;