-- AECI-1500 (E9.2 of the AECI-1339 Stripe epic): `stripe_events`, the Stripe webhook's
-- dedup ledger (`docs/DATABASE_SCHEMA.md` §8.6g). drizzle-kit's output, unedited below this
-- header: one CREATE TABLE for a new table with no foreign key in or out, so no existing
-- table is recreated and no ON DELETE action fires (`docs/migrations.md` §0).
CREATE TABLE `stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`received_at` text NOT NULL,
	`outcome` text NOT NULL,
	`subscription_id` text
);
