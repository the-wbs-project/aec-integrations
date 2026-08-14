-- AECI-603 — Stage 2 migration 1: attestation authority + claim provenance.
-- Contract: docs/STAGE_2_ATTESTATIONS_SPEC.md §1.2 / §2. Purely additive.
--
-- ⚠️ HAND-AUTHORED BODY — this is NOT raw `drizzle-kit generate` output, and
-- regenerating over it would reintroduce a migration that cannot run. See
-- docs/migrations.md §0 (when drizzle-kit wants to recreate a table). What the
-- generator emitted for this same schema diff, and why each part is unusable:
--
--   1. Adding `claims_origin_check` made drizzle-kit take the SQLite table-recreate
--      path: `PRAGMA foreign_keys=OFF` → `CREATE __new_claims` → `INSERT…SELECT` →
--      `DROP TABLE claims` → `RENAME`. Three problems, any one of them fatal:
--        a. Its `INSERT INTO __new_claims(…) SELECT origin, created_by_vendor_id …
--           FROM claims` reads columns that do not exist on the pre-migration
--           table — the statement errors out.
--        b. D1 does not support `PRAGMA foreign_keys = on|off` (only
--           `defer_foreign_keys`), so the guard around the drop is inert there.
--        c. With foreign keys enforced, `DROP TABLE claims` fires
--           `attestations.claim_id ON DELETE CASCADE` — it would delete every
--           attestation in the database.
--   2. `ALTER TABLE … ADD COLUMN … .references()` emits a bare `REFERENCES
--      vendors(id)` with no `ON DELETE` clause, silently dropping the SET NULL the
--      spec requires.
--
-- The statements below are the additive equivalent and match
-- `meta/0006_snapshot.json`, so `db:generate` stays a no-op and drift-check passes.
-- (SQLite applies a NOT NULL column default to existing rows on ADD COLUMN, so every
-- claim in D1 today backfills to `origin = 'aeci'` — correct: all of them came from
-- promote. Verified against SQLite 3.51, including that the ALTER-added FK's
-- ON DELETE SET NULL actually fires.)
ALTER TABLE `claims` ADD `origin` text DEFAULT 'aeci' NOT NULL CONSTRAINT "claims_origin_check" CHECK("origin" IN ('aeci', 'vendor'));--> statement-breakpoint
ALTER TABLE `claims` ADD `created_by_vendor_id` text REFERENCES vendors(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `attestations` ADD `retracted_at` text;--> statement-breakpoint
ALTER TABLE `attestations` ADD `attested_by_vendor_id` text REFERENCES vendors(id) ON DELETE SET NULL;--> statement-breakpoint
-- The active-attestation predicate moves off the `deprecated_at` version stamp and
-- onto `retracted_at` (§1.2 / STAGE_1_5_SPEC.md §3.3). Recreated rather than altered
-- because SQLite has no ALTER INDEX.
DROP INDEX `attestations_active_idx`;--> statement-breakpoint
CREATE INDEX `attestations_active_idx` ON `attestations` (`claim_id`) WHERE "retracted_at" IS NULL;--> statement-breakpoint
-- One LIVE attestation per (claim, slot). Partial, so retract-then-insert can stack any
-- number of retracted rows in the same slot. This CREATE fails loudly if a tier already
-- holds two live rows for one (claim_id, source) — run the pre-flight in the AECI-603
-- as-built note before applying to a tier with data.
CREATE UNIQUE INDEX `attestations_slot_key` ON `attestations` (`claim_id`,`source`) WHERE "retracted_at" IS NULL;
