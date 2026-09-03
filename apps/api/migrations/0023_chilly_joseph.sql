-- AECI-616 — the maintenance marker's real review timestamp + maintainer.
-- Contract: docs/STAGE_2_ATTESTATIONS_SPEC.md §13. Purely additive.
--
-- ⚠️ HAND-AUTHORED BODY — this is NOT raw `drizzle-kit generate` output, and
-- regenerating over it would reintroduce a migration that destroys data. Same
-- reasoning as 0021_lyrical_leper_queen.sql; see docs/migrations.md §0 (when
-- drizzle-kit wants to recreate a table). The three new CHECK constraints put
-- drizzle-kit on the SQLite table-recreate path for all three tables
-- (`CREATE __new_x` → `INSERT…SELECT` → `DROP TABLE x` → `RENAME`), and what it
-- emitted is unusable three times over:
--
--   1. Each `INSERT INTO __new_x(… "last_reviewed_at", "maintained_by" …) SELECT
--      … "last_reviewed_at", "maintained_by" … FROM x` reads the very columns this
--      migration is adding — they do not exist on the pre-migration table, so the
--      statement errors outright.
--   2. `DROP TABLE products` fires `integrations.source_product_id` /
--      `target_product_id` ON DELETE CASCADE — it would delete **every integration
--      in the database** (515 in production). `DROP TABLE vendors` likewise reaches
--      `claims.created_by_vendor_id` and `attestations.attested_by_vendor_id`.
--   3. D1 does not support `PRAGMA foreign_keys = on|off` (only `defer_foreign_keys`),
--      so the guard drizzle-kit wraps the drop in is inert there — the cascade in (2)
--      actually fires.
--
-- The statements below are the additive equivalent and match
-- `meta/0018_snapshot.json`, so `db:generate` stays a no-op and drift-check passes.
--
-- NO BACKFILL, deliberately and permanently (AECI-616 "Explicitly not in scope").
-- Every existing row keeps `last_reviewed_at IS NULL` and renders bare attribution
-- with no date. Seeding it from `created_at` / `updated_at` / `promoted_at` would
-- manufacture exactly the fake freshness this column exists to expose. `maintained_by`
-- IS backfilled — SQLite applies a NOT NULL column default to existing rows on ADD
-- COLUMN — and that is correct: the entire catalog today is AECi-curated, with zero
-- vendor attestations in production.
-- ⚠️ RENUMBERED AGAIN 0018 → 0023 by AECI-750 (main → stage-2 reconcile):
--    main had independently taken 0016–0020 and those are APPLIED IN PRODUCTION,
--    so main keeps its numbers and stage-2's seven move up. Body unchanged — only
--    the filename, the journal `tag` and meta/0023_snapshot.json moved. The
--    snapshot was RECOMPOSED (main's page_views columns + asn_registry grafted on),
--    not renamed; see docs/migrations.md §0.
ALTER TABLE `vendors` ADD `last_reviewed_at` text;--> statement-breakpoint
ALTER TABLE `vendors` ADD `maintained_by` text DEFAULT 'aeci' NOT NULL CONSTRAINT "vendors_maintained_by_check" CHECK("maintained_by" IN ('aeci', 'vendor'));--> statement-breakpoint
ALTER TABLE `products` ADD `last_reviewed_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `maintained_by` text DEFAULT 'aeci' NOT NULL CONSTRAINT "products_maintained_by_check" CHECK("maintained_by" IN ('aeci', 'vendor'));--> statement-breakpoint
ALTER TABLE `integrations` ADD `last_reviewed_at` text;--> statement-breakpoint
ALTER TABLE `integrations` ADD `maintained_by` text DEFAULT 'aeci' NOT NULL CONSTRAINT "integrations_maintained_by_check" CHECK("maintained_by" IN ('aeci', 'vendor'));
