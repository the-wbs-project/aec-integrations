-- AECI-1088 (the AECI-1040 owner carve-out): the vendor-ownership columns on
-- `connector_evidenced_pairs`, the same four `0044` and `0046` gave `integrations`.
--
-- ADDITIVE ONLY. Four `ALTER TABLE ... ADD COLUMN` statements and nothing else.
-- `connector_evidenced_pairs` is NEVER recreated here: it is a cascade parent of
-- `claims`, and `attestations` cascade from `claims`, so a recreate's DROP deletes
-- both, two levels deep (docs/migrations.md §3.3a). `src/test/migration-0049.spec.ts`
-- is the tripwire.
--
-- `origin` and `retired_by` carry COLUMN-level CHECKs written by hand, on the 0044 and
-- 0046 precedent. drizzle-kit generated the bare columns; declaring the CHECKs in
-- `schema.ts` would make every later generate render a table recreate. SQLite verifies
-- an added CHECK against existing rows: every existing row takes the 'aeci' default
-- for `origin` and NULL for `retired_by`, and NULL passes a CHECK, so neither can fail.
--
-- No backfill. Every existing pair is AECi-seeded and unclaimed, which is what the
-- defaults say. `claimed_at` and `origin` land in the same file on purpose: the ops
-- lanes' `notVendorHeldSql` switches on only when both columns exist
-- (`scripts/ops/2026-09-retraction-consumer/vendor-held.mjs`).
ALTER TABLE `connector_evidenced_pairs` ADD `claimed_at` text;--> statement-breakpoint
ALTER TABLE `connector_evidenced_pairs` ADD `origin` text DEFAULT 'aeci' NOT NULL CONSTRAINT "connector_evidenced_pairs_origin_check" CHECK ("origin" IN ('aeci', 'vendor'));--> statement-breakpoint
ALTER TABLE `connector_evidenced_pairs` ADD `retired_at` text;--> statement-breakpoint
ALTER TABLE `connector_evidenced_pairs` ADD `retired_by` text CONSTRAINT "connector_evidenced_pairs_retired_by_check" CHECK ("retired_by" IN ('owner', 'aeci'));
