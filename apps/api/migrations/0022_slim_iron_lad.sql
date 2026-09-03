-- AECI-607 — Stage 2 migration 2: the product-version model.
-- Contract: docs/STAGE_2_ATTESTATIONS_SPEC.md §1.2 / §8. Purely additive.
--
-- ⚠️ RENUMBERED 0008 → 0017 by AECI-619. It shipped as 0008 (leaving 0007 free)
-- precisely so this reconciliation had somewhere to land; in the event `main` had
-- reached 0015, so both of this epic's migrations moved to the end of the chain
-- instead. `meta/0017_snapshot.json` was REGENERATED against the merged schema,
-- not renamed — see the note in 0021_lyrical_leper_queen.sql. `aeci-515` still
-- holds a 0006 and takes 0018+ when it reconciles.
--
-- ⚠️ THE `ALTER` STATEMENTS ARE HAND-AUTHORED. `drizzle-kit generate` emitted them
-- as bare `REFERENCES product_versions(id)` with **no `ON DELETE` clause**, silently
-- dropping the `ON DELETE SET NULL` §8.2 requires — the same defect AECI-603 hit and
-- recorded in docs/migrations.md §0. Left as generated, deleting a product version
-- would have been rejected outright by the FK (RESTRICT is SQLite's default) instead
-- of degrading the stamp to "no version data". The `CREATE TABLE` + indexes above are
-- untouched generator output: `CREATE TABLE` does emit the full FK clause.
--
-- The body still matches `meta/0017_snapshot.json`, so `db:generate` stays a no-op
-- and the CI drift gate passes — drizzle-kit diffs `schema.ts` against the snapshot,
-- never against the database. Statement order matters: `product_versions` must exist
-- before the `attestations` FKs point at it.
--
-- Both `ADD COLUMN`s are nullable with no default, which is the only form SQLite
-- accepts for `ADD COLUMN` carrying a `REFERENCES` clause. Nothing backfills: every
-- attestation in D1 today came from promote, which does not ingest versions (§8.3).
-- ⚠️ RENUMBERED AGAIN 0017 → 0022 by AECI-750 (main → stage-2 reconcile):
--    main had independently taken 0016–0020 and those are APPLIED IN PRODUCTION,
--    so main keeps its numbers and stage-2's seven move up. Body unchanged — only
--    the filename, the journal `tag` and meta/0022_snapshot.json moved. The
--    snapshot was RECOMPOSED (main's page_views columns + asn_registry grafted on),
--    not renamed; see docs/migrations.md §0.
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
