-- AECI-891 — the REACH anchor: `claims` gains a third arm, `connector_pair_id`.
--
-- A claim may now hang off `connector_pairs` (the reachable tier, `DATABASE_SCHEMA.md`
-- §9a.5) as well as off `integrations` and `connector_evidenced_pairs` (the two delivered
-- tiers). Operator ruling 2026-09-13: when I24 retires the delivered row that used to
-- carry a claim, the claim moves to the reached pair rather than being dropped.
--
-- Three things change on the table and ALL THREE force a full recreate, because SQLite
-- has no `ALTER TABLE … ALTER CONSTRAINT` and refuses `ADD COLUMN` for a STORED generated
-- column:
--   * the new `connector_pair_id` column and its `ON DELETE cascade` FK;
--   * `anchor_id`, whose generation expression becomes a three-way
--     `coalesce(integration_id, connector_evidenced_pair_id, connector_pair_id)`;
--   * `claims_anchor_check`, which stops being `a <> b` and becomes a SUM of the three
--     `IS NOT NULL` booleans compared to 1. `<>` cannot express three arms:
--     `a <> b <> c` parses as `(a <> b) <> c` and is TRUE when ALL THREE are set, so the
--     obvious translation would have silently admitted the exact row it looks like it
--     forbids. `src/test/migration-0033.spec.ts` proves the sum form catches it.
--
-- ╔════════════════════════════════════════════════════════════════════════════════╗
-- ║ STATEMENT ORDER IS A DATA-LOSS CONTROL. DO NOT REORDER. DO NOT REGENERATE.      ║
-- ╚════════════════════════════════════════════════════════════════════════════════╝
--
-- HAND-ASSEMBLED from drizzle-kit output. THREE edits, all mandatory:
--
--   1. THE PRAGMA. drizzle-kit emits `PRAGMA foreign_keys=OFF` / `=ON`, which is not the
--      lever D1 supports — D1's migrations documentation specifies
--      `PRAGMA defer_foreign_keys = true`, which holds for the surrounding transaction
--      and resets on commit, so it needs no matching re-enable. `docs/migrations.md`
--      §3.3a rule 1. The trailing `=ON` is DELETED rather than translated. Regenerating
--      this file reintroduces the wrong pragma.
--
--   2. THE CASCADE, which drizzle-kit cannot know about. Its recreate is
--      `CREATE __new_claims` → copy → `DROP TABLE claims` → rename, and in SQLite
--      `DROP TABLE` performs an implicit DELETE that FIRES FOREIGN KEY ACTIONS.
--      `defer_foreign_keys` defers *violation reporting*, NOT cascade *actions*.
--      `attestations.claim_id` references `claims.id` ON DELETE CASCADE, so the
--      generated order destroys EVERY ATTESTATION IN THE DATABASE — roughly 1,872 rows
--      in production, vendor-supplied evidence that cannot be reconstructed. The claims
--      themselves survive that order (they are copied into `__new_claims` first); the
--      attestations do not, which is what makes the loss quiet.
--
--      This is 0027's hazard one level shallower. 0027 recreated `integrations` at the
--      top of a two-level chain (`integrations` → `claims` → `attestations`) and
--      measured 1,697 claims plus 1,697 attestations destroyed in generated order. Here
--      the chain is `claims` → `attestations` only, because `attestations` is the ONLY
--      table holding an FK to `claims` — grep the migrations for REFERENCES claims and
--      you get exactly one hit, in `0005_shocking_omega_red.sql` — and nothing at all
--      references `attestations`.
--
--      MEASURED, not theorised, on 2026-09-13 against the harness: seed 1 claim and 1
--      attestation, apply the generated order, observe `claims = 1, attestations = 0`.
--      The order below returns 1 and 1.
--
--      The order below empties the child EXPLICITLY before the parent is dropped, so the
--      drop's cascade reaches nothing, and parks both tables in `CREATE TABLE … AS
--      SELECT` carry copies first. A carry table has no PK, no FKs and no CHECKs, so it
--      is cascade-immune by construction whatever order SQLite evaluates in.
--
--      `src/test/migration-0033.spec.ts` guards this by CONSERVATION — it seeds 4 claims
--      and 4 attestations, applies the committed file and asserts 4 and 4 — rather than
--      by reconstructing the generated order inside the spec, which is the shape
--      `migration-0027.spec.ts` uses. Regenerate this file and ALL EIGHT of its cases
--      fail, because the raw drizzle-kit output throws on edit 3 below; repair that and
--      three still fail on the cascade alone.
--
--   3. THE GENERATED COLUMN IN THE COPY. drizzle-kit's `INSERT INTO __new_claims(…)`
--      lists `anchor_id`, which is GENERATED ALWAYS … STORED and cannot be written —
--      SQLite rejects the statement outright. Its SELECT also reads `connector_pair_id`
--      from the OLD table, which has no such column. So the generated file does not even
--      run to completion; it is invalid before it is dangerous. The restore below uses an
--      explicit column list with `anchor_id` ABSENT, exactly as 0027 step 7 does.
--
-- ANCHOR VALUES ARE PRESERVED BY CONSTRUCTION, not by copying. Every carried claim is
-- restored with its `integration_id` and `connector_evidenced_pair_id` verbatim and
-- `connector_pair_id` as a literal NULL (the carry table predates that column), so
-- `coalesce(a, b, NULL)` recomputes to the identical value `coalesce(a, b)` produced
-- before. `claims_identity_key` sees no change, and every `audit_log` row, PostHog log
-- line and attestation keeps resolving to the same id. THIS MIGRATION MOVES NO CLAIM —
-- it only makes the third arm available. Filling it is application work.
--
-- NOTE FOR `0032_mute_gateway.sql`. Its header states that nothing references
-- `connector_pairs` and asks that `grep -rn "REFERENCES connector_pairs"
-- apps/api/migrations` stay empty. As of THIS migration that is no longer true —
-- `claims.connector_pair_id` cascades off it. Any future recreate of `connector_pairs`
-- needs 0027's and this file's treatment, exactly as 0032's own closing sentence
-- anticipated.
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
-- ── 1-2. Carry both cascade-reachable tables out of harm's way ─────────────────
-- `CREATE TABLE … AS SELECT` yields a plain table: no PK, no FKs, no CHECKs, and no
-- generated columns (`anchor_id` lands here as an ordinary text column holding its old
-- value). Nothing below can cascade into these.
CREATE TABLE `__carry_claims` AS SELECT * FROM `claims`;--> statement-breakpoint
CREATE TABLE `__carry_attestations` AS SELECT * FROM `attestations`;--> statement-breakpoint
-- ── 3-4. Empty the child EXPLICITLY, deepest first ────────────────────────────
-- Not redundant with the drop below: this is what turns the drop's cascade into a no-op
-- instead of a silent deletion. `attestations` first — it is the leaf.
DELETE FROM `attestations`;--> statement-breakpoint
DELETE FROM `claims`;--> statement-breakpoint
-- ── 5. Drop and recreate `claims` with the three-arm anchor ───────────────────
-- A plain DROP + CREATE rather than drizzle's `__new_claims` copy-and-rename: the table
-- is empty (step 4), so there is nothing to copy — and the generated INSERT was invalid
-- anyway (edit 3 above). The drop's cascade reaches only the already-empty
-- `attestations`.
DROP TABLE `claims`;--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text,
	`connector_evidenced_pair_id` text,
	`connector_pair_id` text,
	`data_object_id` text NOT NULL,
	`direction` text NOT NULL,
	`origin` text DEFAULT 'aeci' NOT NULL,
	`created_by_vendor_id` text,
	`anchor_id` text GENERATED ALWAYS AS (coalesce("integration_id", "connector_evidenced_pair_id", "connector_pair_id")) STORED,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_evidenced_pair_id`) REFERENCES `connector_evidenced_pairs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_pair_id`) REFERENCES `connector_pairs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`data_object_id`) REFERENCES `taxonomy_data_objects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "claims_direction_check" CHECK("direction" IN ('a_to_b', 'b_to_a', 'both')),
	CONSTRAINT "claims_origin_check" CHECK("origin" IN ('aeci', 'vendor')),
	CONSTRAINT "claims_anchor_check" CHECK((("integration_id" IS NOT NULL) + ("connector_evidenced_pair_id" IS NOT NULL) + ("connector_pair_id" IS NOT NULL)) = 1)
);--> statement-breakpoint
-- ── 6. Recreate the indexes ───────────────────────────────────────────────────
-- `claims_identity_key` leads on the STORED generated column, which is the whole reason
-- `anchor_id` is STORED: it is the identity key across all three anchors, and a plain
-- nullable FK column in the index would let SQLite's NULLs-are-distinct rule wave
-- duplicates through.
CREATE UNIQUE INDEX `claims_identity_key` ON `claims` (`anchor_id`,`data_object_id`,`direction`);--> statement-breakpoint
CREATE INDEX `claims_data_object_idx` ON `claims` (`data_object_id`);--> statement-breakpoint
-- ── 7. Restore the claims on their existing anchors ───────────────────────────
-- Explicit column list, `anchor_id` ABSENT: it is GENERATED ALWAYS … STORED, so SQLite
-- computes it and rejects any attempt to supply it. `connector_pair_id` is a literal
-- NULL rather than a copy — `__carry_claims` is a snapshot of the OLD table and has no
-- such column — which is also what keeps the exactly-one-anchor CHECK satisfied on every
-- restored row.
INSERT INTO `claims` ("id", "integration_id", "connector_evidenced_pair_id", "connector_pair_id", "data_object_id", "direction", "origin", "created_by_vendor_id", "created_at", "updated_at")
  SELECT "id", "integration_id", "connector_evidenced_pair_id", NULL, "data_object_id", "direction", "origin", "created_by_vendor_id", "created_at", "updated_at"
    FROM `__carry_claims`;--> statement-breakpoint
-- ── 8. Restore the attestations ───────────────────────────────────────────────
-- Every `claim_id` resolves: step 7 restored the claims with their ids intact, and no
-- claim's id was rewritten anywhere in this file.
INSERT INTO `attestations` ("id", "claim_id", "source", "asserted", "introduced_at", "deprecated_at", "introduced_version_id", "deprecated_version_id", "retracted_at", "attested_by_vendor_id", "note", "created_at", "updated_at")
  SELECT "id", "claim_id", "source", "asserted", "introduced_at", "deprecated_at", "introduced_version_id", "deprecated_version_id", "retracted_at", "attested_by_vendor_id", "note", "created_at", "updated_at"
    FROM `__carry_attestations`;--> statement-breakpoint
-- ── 9. Drop the carry tables ──────────────────────────────────────────────────
DROP TABLE `__carry_claims`;--> statement-breakpoint
DROP TABLE `__carry_attestations`;
