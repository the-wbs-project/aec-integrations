-- AECI-991 — re-key `integration_endpoint_moves` on the two pair SLUGS and drop both
-- foreign keys. Contract: docs/STAGE_1_5_SPEC.md §7.2a + docs/DATABASE_SCHEMA.md §4.3a.
--
-- ╔════════════════════════════════════════════════════════════════════════════════╗
-- ║ HAND-ASSEMBLED. This is NOT raw `drizzle-kit generate` output. Regenerating it  ║
-- ║ produces a bare DROP + CREATE that silently discards every move row instead of  ║
-- ║ translating it. `src/test/migration-0041.spec.ts` applies this file against     ║
-- ║ non-empty data and fails if the carry goes. `meta/0041_snapshot.json` already   ║
-- ║ describes the post-state, so `db:generate` stays a no-op and drift-check passes.║
-- ╚════════════════════════════════════════════════════════════════════════════════╝
--
-- ─── WHY ────────────────────────────────────────────────────────────────────────
--
-- The table recorded the pair an edge LEFT, keyed on two product ids, each an FK to
-- `products` with ON DELETE CASCADE. A redirect keyed on the thing it points AWAY
-- from cannot have a cascade on that thing: deleting the product deletes the
-- redirect. A merge-then-retire does exactly that — AECI-809 re-pointed 44 edges off
-- Autodesk Construction Cloud onto Autodesk Forma and then retracted the ACC record,
-- and all 44 move rows went with it. 44 indexed pair URLs went from "about to 301"
-- to 404 with nothing logged. Slugs have no owning row, so they cannot cascade.
--
-- ─── WHY THE DROP IS SAFE HERE, UNLIKE 0027 / 0033 ──────────────────────────────
--
-- SQLite's `DROP TABLE` fires foreign-key ACTIONS, and `PRAGMA defer_foreign_keys`
-- defers violation reporting, not the actions — that is how 0027 destroyed 1,697
-- claims and 1,697 attestations when it was got wrong. NOTHING references
-- `integration_endpoint_moves`: it has no inbound foreign keys and therefore no
-- cascade children, which `src/test/d1.spec.ts` now pins so a future child cannot be
-- added quietly. The rows are carried explicitly below regardless, because a recreate
-- that relies on an empty table proves nothing (docs/migrations.md §3.3a rule 3).
--
-- ─── THE CARRY ──────────────────────────────────────────────────────────────────
--
-- Two ids become two slugs, re-sorted: id order and slug order are unrelated, and the
-- new CHECK is on the SLUGS, so a straight column-for-column copy would insert rows
-- the constraint rejects. `MIN`/`MAX` over the two slugs is the canonical form.
--
-- The join is INNER on purpose. A row whose product is gone cannot be translated —
-- there is no slug to recover — and it also cannot exist, because the very cascade
-- this migration removes already deleted it. The 44 ACC rows are not recoverable
-- here; they are rebuilt from `audit_log` by
-- `scripts/ops/2026-09-endpoint-move-rebuild/`, which runs AFTER this migration.
CREATE TABLE `__new_integration_endpoint_moves` (
	`integration_id` text NOT NULL,
	`from_product_a_slug` text NOT NULL,
	`from_product_b_slug` text NOT NULL,
	`moved_at` text NOT NULL,
	PRIMARY KEY(`integration_id`, `from_product_a_slug`, `from_product_b_slug`),
	CONSTRAINT "integration_endpoint_moves_canonical_pair_check" CHECK("from_product_a_slug" < "from_product_b_slug")
);
--> statement-breakpoint
INSERT OR IGNORE INTO `__new_integration_endpoint_moves`
  (`integration_id`, `from_product_a_slug`, `from_product_b_slug`, `moved_at`)
SELECT m.`integration_id`,
       MIN(a.`slug`, b.`slug`),
       MAX(a.`slug`, b.`slug`),
       m.`moved_at`
  FROM `integration_endpoint_moves` m
  JOIN `products` a ON a.`id` = m.`from_product_a_id`
  JOIN `products` b ON b.`id` = m.`from_product_b_id`
 WHERE a.`slug` <> b.`slug`;
--> statement-breakpoint
DROP TABLE `integration_endpoint_moves`;
--> statement-breakpoint
ALTER TABLE `__new_integration_endpoint_moves` RENAME TO `integration_endpoint_moves`;
--> statement-breakpoint
CREATE INDEX `integration_endpoint_moves_from_idx` ON `integration_endpoint_moves` (`from_product_a_slug`,`from_product_b_slug`);
