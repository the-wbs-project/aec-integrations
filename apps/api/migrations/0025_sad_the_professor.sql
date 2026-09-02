CREATE TABLE `vendor_seat_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`invited_by_id` text,
	`expires_at` text NOT NULL,
	`accepted_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_seat_invites_token_key` ON `vendor_seat_invites` (`token`);--> statement-breakpoint
CREATE INDEX `vendor_seat_invites_vendor_idx` ON `vendor_seat_invites` (`vendor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `vendor_seat_invites_pending_idx` ON `vendor_seat_invites` (`vendor_id`,`email`) WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE `profiles` ADD `seat_owner` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- AECI-664 backfill (hand-written; drizzle-kit generates schema, not data).
-- Every seat that exists TODAY was granted by hand through the §5 admin claim
-- review — an AECi-reviewed human — which is exactly the definition of an owner.
-- Without this, `seat_owner` defaults to false everywhere and the invite feature
-- ships dead: no existing vendor could invite anyone.
UPDATE `profiles` SET `seat_owner` = 1 WHERE `role` = 'vendor_admin';
