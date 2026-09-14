-- AECI-921 — `integrations.direction` adopts the claim vocabulary.
--
-- `a_to_b` / `b_to_a` / `both`, anchored exactly as `claims.direction` is: A = this row's
-- `source_product_id`, B = its `target_product_id`. This was the ONLY direction column in
-- the schema that could not express a reverse flow — `claims.direction`,
-- `connector_pairs.direction` and `connector_evidenced_pairs.direction` have all been
-- three-valued since they were created.
--
-- WHY, IN ONE PARAGRAPH. Upstream orders an integration's endpoints by WHO BUILT the
-- connector (the review app's convention I1), while AECi reads `one-way` as "flows from
-- `source` to `target`" (`STAGE_1_5_SPEC.md` §3.2). Those rules agree until the builder is
-- the data CONSUMER — a BI tool reading a warehouse, a GIS tool reading a CDE — and then
-- the row stores `one-way` and the page renders the exact reverse of the truth. AECI-920
-- confirmed 14 such rows from a single keyword probe and the real count is higher. With a
-- two-value column there was no correct value to write; now there is.
--
-- ╔════════════════════════════════════════════════════════════════════════════════╗
-- ║ THIS MIGRATION CHANGES NO ROW'S MEANING. It is a pure re-spelling:             ║
-- ║   'one-way' -> 'a_to_b'   ·   'bidirectional' -> 'both'   ·   NULL -> NULL      ║
-- ║ Correcting the inverted rows is AECI-920's job, UPSTREAM. Do not "fix" them     ║
-- ║ here: the discriminator is whether the source endpoint is the data consumer,    ║
-- ║ and only the free-text description says. 6 of the 20 rows in that probe were    ║
-- ║ CORRECT, so a blanket flip would break working data.                            ║
-- ╚════════════════════════════════════════════════════════════════════════════════╝
--
-- ╔════════════════════════════════════════════════════════════════════════════════╗
-- ║ STATEMENT ORDER IS A DATA-LOSS CONTROL. DO NOT REORDER. DO NOT REGENERATE.      ║
-- ╚════════════════════════════════════════════════════════════════════════════════╝
--
-- HAND-ASSEMBLED from drizzle-kit output. THREE edits, all mandatory.
--
-- ── READ THIS BEFORE YOU "FIX" A FAILING REGENERATION ─────────────────────────
-- MEASURED on 2026-09-14 against the test harness, seeding 1 integration, 1 claim and 1
-- attestation:
--
--   generated order, exactly as drizzle-kit wrote it
--     -> ABORTS: "CHECK constraint failed: integrations_direction_check". Nothing lost.
--   generated order with ONLY the backfill added (edit 1)
--     -> integrations 1, claims 0, attestations 0. BOTH cascade levels destroyed.
--
-- The abort is the only reason the first line is safe, and it is what HIDES the second.
-- A regenerated file fails loudly and obviously on the missing backfill, and the obvious
-- repair — drop the CASE into the generated INSERT and move on — is the one that silently
-- empties `claims` and `attestations`. The loud failure is not the hazard. It is the
-- tripwire in front of the hazard, and stepping over it is the whole risk here.
--
--   1. THE BACKFILL, which drizzle-kit cannot know about. Its copy is a straight
--      `SELECT "direction"`, so every existing row carries `one-way` or `bidirectional`
--      into a table whose CHECK now admits neither. On any non-empty database the
--      generated file ABORTS on that INSERT. On an EMPTY one the INSERT touches no rows,
--      the file applies clean, and every guard downstream looks green — which is why
--      "it applied fine locally" is evidence of nothing at all here
--      (`docs/migrations.md` §3.3a rule 3). The CASE in step 6 is the backfill.
--
--   2. THE PRAGMA. drizzle-kit emits `PRAGMA foreign_keys=OFF` / `=ON`, which is not the
--      lever D1 supports — D1's migrations documentation specifies
--      `PRAGMA defer_foreign_keys = true`, which holds for the surrounding transaction and
--      resets on commit, so it needs no matching re-enable. `docs/migrations.md` §3.3a
--      rule 1. The trailing `=ON` is DELETED rather than translated.
--
--   3. THE CASCADE, which drizzle-kit also cannot know about. Its recreate is
--      `CREATE __new_integrations` -> copy -> `DROP TABLE integrations` -> rename, and in
--      SQLite `DROP TABLE` performs an implicit DELETE that FIRES FOREIGN KEY ACTIONS.
--      `defer_foreign_keys` defers violation *reporting*, NOT cascade *actions*.
--      `claims.integration_id` references `integrations.id` ON DELETE CASCADE and
--      `attestations.claim_id` references `claims.id` ON DELETE CASCADE, so the chain is
--      TWO LEVELS DEEP and the generated order destroys both.
--
--      This is the same table and the same chain as `0027_powerful_killraven.sql`, which
--      measured 1,697 claims and 1,697 attestations destroyed in generated order. The
--      measurement above reproduces that shape exactly: `integrations` — the table a
--      reviewer checks first, and the one this migration is nominally about — keeps every
--      row, because the recreate copies it before the drop. Only its descendants go. That
--      asymmetry is what makes the loss quiet.
--
--      `claims.integration_id` is the ONLY inbound FK on this table —
--      `grep -rn "REFERENCES \`integrations\`" apps/api/migrations` returns hits in 0005,
--      0027 and 0033, all of them that one column. If that ever grows, this file's order
--      needs extending before the next recreate; `src/test/d1.spec.ts` pins the list.
--
--      The order below carries both cascade-reachable tables into constraint-free copies,
--      empties them deepest-first so the drop's cascade reaches nothing, and restores them
--      after the rename. A `CREATE TABLE … AS SELECT` carry table has no PK, no FKs and no
--      CHECKs, so it is cascade-immune by construction whatever order SQLite evaluates in.
--
-- CLAIM IDS AND ANCHORS ARE UNTOUCHED. `claims` is restored verbatim — same ids, same
-- `integration_id`, same `direction` — so `anchor_id` recomputes identically,
-- `claims_identity_key` sees no change, and every `audit_log` row, PostHog log line and
-- attestation keeps resolving to the same id. `claims.direction` ALREADY used this
-- vocabulary and is not rewritten by this file; only `integrations.direction` changes.
--
-- `src/test/migration-0034.spec.ts` guards all three edits by CONSERVATION — it seeds
-- claims and attestations under a non-empty `integrations`, applies this file AS
-- COMMITTED, and asserts the counts and the backfill. Regenerate this file and it fails.
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
-- ── 1-2. Carry both cascade-reachable tables out of harm's way ────────────────
-- `CREATE TABLE … AS SELECT` yields a plain table: no PK, no FKs, no CHECKs, and no
-- generated columns (`anchor_id` lands here as an ordinary text column holding its old
-- value). Nothing below can cascade into these.
CREATE TABLE `__carry_claims` AS SELECT * FROM `claims`;--> statement-breakpoint
CREATE TABLE `__carry_attestations` AS SELECT * FROM `attestations`;--> statement-breakpoint
-- ── 3-4. Empty the children EXPLICITLY, deepest first ─────────────────────────
-- Not redundant with the drop below: this is what turns the drop's cascade into a no-op
-- instead of a silent deletion. `attestations` first — it is the leaf.
DELETE FROM `attestations`;--> statement-breakpoint
DELETE FROM `claims`;--> statement-breakpoint
-- ── 5. Recreate `integrations` with the three-value direction CHECK ───────────
CREATE TABLE `__new_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`source_product_id` text NOT NULL,
	`target_product_id` text NOT NULL,
	`mechanism_kind` text,
	`mechanism_name` text,
	`direction` text,
	`built_by_vendor_id` text,
	`powered_by_product_id` text,
	`description` text,
	`listing_url` text,
	`docs_url` text,
	`website` text,
	`mechanism_url` text,
	`pricing_model` text,
	`maturity` text,
	`notes` text,
	`last_reviewed_at` text,
	`maintained_by` text DEFAULT 'aeci' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`source_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`built_by_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`powered_by_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "integrations_maintained_by_check" CHECK("maintained_by" IN ('aeci', 'vendor')),
	CONSTRAINT "integrations_mechanism_kind_check" CHECK("mechanism_kind" IN ('native', 'iPaaS', 'marketplace-app', 'api', 'webhook', 'partner', 'integrator')),
	CONSTRAINT "integrations_direction_check" CHECK("direction" IN ('a_to_b', 'b_to_a', 'both')),
	CONSTRAINT "integrations_distinct_endpoints_check" CHECK("source_product_id" <> "target_product_id")
);--> statement-breakpoint
-- ── 6. Copy the rows, RE-SPELLING `direction` ─────────────────────────────────
-- The CASE is edit 1. It is total over every value the OLD CHECK admitted, and the `ELSE
-- NULL` is a deliberate belt-and-braces: the old CHECK made an out-of-vocabulary value
-- impossible, and if one existed anyway the honest landing is "nobody established it"
-- rather than aborting the migration on a row nobody can explain. A NULL here is legal and
-- renders as an em-dash.
--
-- `one-way` -> `a_to_b` is exact, not an approximation: `one-way` has always meant "flows
-- from this row's `source` to its `target`", and A is defined as that same
-- `source_product_id`. No endpoint is reordered and no row changes meaning.
INSERT INTO `__new_integrations`("id", "name", "source_product_id", "target_product_id", "mechanism_kind", "mechanism_name", "direction", "built_by_vendor_id", "powered_by_product_id", "description", "listing_url", "docs_url", "website", "mechanism_url", "pricing_model", "maturity", "notes", "last_reviewed_at", "maintained_by", "created_at", "updated_at")
  SELECT "id", "name", "source_product_id", "target_product_id", "mechanism_kind", "mechanism_name",
         CASE "direction"
           WHEN 'one-way' THEN 'a_to_b'
           WHEN 'bidirectional' THEN 'both'
           ELSE NULL
         END,
         "built_by_vendor_id", "powered_by_product_id", "description", "listing_url", "docs_url", "website", "mechanism_url", "pricing_model", "maturity", "notes", "last_reviewed_at", "maintained_by", "created_at", "updated_at"
    FROM `integrations`;--> statement-breakpoint
-- ── 7. Swap the tables ────────────────────────────────────────────────────────
-- Safe now: `claims` is empty (step 4), so the implicit DELETE behind this DROP cascades
-- into nothing.
DROP TABLE `integrations`;--> statement-breakpoint
ALTER TABLE `__new_integrations` RENAME TO `integrations`;--> statement-breakpoint
-- ── 8. Recreate the indexes ───────────────────────────────────────────────────
CREATE INDEX `integrations_source_idx` ON `integrations` (`source_product_id`);--> statement-breakpoint
CREATE INDEX `integrations_target_idx` ON `integrations` (`target_product_id`);--> statement-breakpoint
CREATE INDEX `integrations_mechanism_kind_idx` ON `integrations` (`mechanism_kind`);--> statement-breakpoint
CREATE INDEX `integrations_updated_at_idx` ON `integrations` (`updated_at`);--> statement-breakpoint
CREATE INDEX `integrations_built_by_idx` ON `integrations` (`built_by_vendor_id`) WHERE "built_by_vendor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `integrations_powered_by_idx` ON `integrations` (`powered_by_product_id`) WHERE "powered_by_product_id" IS NOT NULL;--> statement-breakpoint
-- ── 9. Restore the claims, verbatim ───────────────────────────────────────────
-- Explicit column list with `anchor_id` ABSENT: it is GENERATED ALWAYS … STORED, so SQLite
-- computes it and rejects any attempt to supply it — and `__carry_claims` DOES hold a copy
-- of it (a `CREATE … AS SELECT` materialises a generated column as an ordinary one), so a
-- `SELECT *` here would fail. Every anchor column is carried through unchanged, so each
-- restored row recomputes the identical `anchor_id`.
--
-- `claims.direction` is NOT touched by this migration. It already spoke `a_to_b` /
-- `b_to_a` / `both`; this file is what makes the mechanism row above agree with it.
INSERT INTO `claims` ("id", "integration_id", "connector_evidenced_pair_id", "connector_pair_id", "data_object_id", "direction", "origin", "created_by_vendor_id", "created_at", "updated_at")
  SELECT "id", "integration_id", "connector_evidenced_pair_id", "connector_pair_id", "data_object_id", "direction", "origin", "created_by_vendor_id", "created_at", "updated_at"
    FROM `__carry_claims`;--> statement-breakpoint
-- ── 10. Restore the attestations ──────────────────────────────────────────────
-- Every `claim_id` resolves: step 9 restored the claims with their ids intact, and no
-- claim's id was rewritten anywhere in this file.
INSERT INTO `attestations` ("id", "claim_id", "source", "asserted", "introduced_at", "deprecated_at", "introduced_version_id", "deprecated_version_id", "retracted_at", "attested_by_vendor_id", "note", "created_at", "updated_at")
  SELECT "id", "claim_id", "source", "asserted", "introduced_at", "deprecated_at", "introduced_version_id", "deprecated_version_id", "retracted_at", "attested_by_vendor_id", "note", "created_at", "updated_at"
    FROM `__carry_attestations`;--> statement-breakpoint
-- ── 11. Drop the carry tables ─────────────────────────────────────────────────
DROP TABLE `__carry_claims`;--> statement-breakpoint
DROP TABLE `__carry_attestations`;
