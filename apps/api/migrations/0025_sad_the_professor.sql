CREATE TABLE `vendor_seat_invites` (
-- ⚠️ RENUMBERED AGAIN 0020 → 0025 by AECI-750 (main → stage-2 reconcile):
--    main had independently taken 0016–0020 and those are APPLIED IN PRODUCTION,
--    so main keeps its numbers and stage-2's seven move up. Body unchanged — only
--    the filename, the journal `tag` and meta/0025_snapshot.json moved. The
--    snapshot was RECOMPOSED (main's page_views columns + asn_registry grafted on),
--    not renamed; see docs/migrations.md §0.
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
