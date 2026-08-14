-- AECI-607 — Stage 2 migration 2: the product-version model.
-- Contract: docs/STAGE_2_ATTESTATIONS_SPEC.md §1.2 / §8. Purely additive.
--
-- ⚠️ NUMBERED 0008, NOT 0007 — the gap is deliberate. `origin/aeci-514` (this epic)
-- and `origin/aeci-515` (Paid Tiers) each independently generated a DIFFERENT
-- `0006_*.sql` — `0006_lyrical_leper_queen` here, `0006_easy_sandman`
-- (`vendor_entitlements`, AECI-609) there. They collide when both epics merge to
-- `stage-2`, and whichever merges second has to renumber. Leaving 0007 free gives
-- that reconciliation somewhere to land without touching this file.
--
-- ⚠️ THE `ALTER` STATEMENTS ARE HAND-AUTHORED. `drizzle-kit generate` emitted them
-- as bare `REFERENCES product_versions(id)` with **no `ON DELETE` clause**, silently
-- dropping the `ON DELETE SET NULL` §8.2 requires — the same defect AECI-603 hit and
-- recorded in docs/migrations.md §0. Left as generated, deleting a product version
-- would have been rejected outright by the FK (RESTRICT is SQLite's default) instead
-- of degrading the stamp to "no version data". The `CREATE TABLE` + indexes above are
-- untouched generator output: `CREATE TABLE` does emit the full FK clause.
--
-- The body still matches `meta/0008_snapshot.json`, so `db:generate` stays a no-op
-- and the CI drift gate passes — drizzle-kit diffs `schema.ts` against the snapshot,
-- never against the database. Statement order matters: `product_versions` must exist
-- before the `attestations` FKs point at it.
--
-- Both `ADD COLUMN`s are nullable with no default, which is the only form SQLite
-- accepts for `ADD COLUMN` carrying a `REFERENCES` clause. Nothing backfills: every
-- attestation in D1 today came from promote, which does not ingest versions (§8.3).
CREATE TABLE `product_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`label` text NOT NULL,
	`released_at` text,
	`sunset_at` text,
	`sort_key` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_versions_label_key` ON `product_versions` (`product_id`,`label`);--> statement-breakpoint
CREATE INDEX `product_versions_order_idx` ON `product_versions` (`product_id`,`sort_key`);--> statement-breakpoint
ALTER TABLE `attestations` ADD `introduced_version_id` text REFERENCES product_versions(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `attestations` ADD `deprecated_version_id` text REFERENCES product_versions(id) ON DELETE SET NULL;
