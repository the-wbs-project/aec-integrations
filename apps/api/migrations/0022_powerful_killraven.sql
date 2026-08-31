-- AECI-721 PR-B — the single destructive migration for the connector-powered edge move.
--
-- Two table recreates (`integrations` for the `mechanism_kind` CHECK, `claims` for the
-- polymorphic anchor) plus the data move itself. Governed by `STAGE_1_5_SPEC.md` §13
-- and `DATABASE_SCHEMA.md` §9a.6 — the additive half shipped separately so that every
-- count expression already sums BOTH delivered-tier tables before any row moves —
-- which is what makes this migration count-neutral rather than merely intended to be.
--
-- ╔════════════════════════════════════════════════════════════════════════════════╗
-- ║ STATEMENT ORDER IS A DATA-LOSS CONTROL. DO NOT REORDER. DO NOT REGENERATE.      ║
-- ╚════════════════════════════════════════════════════════════════════════════════╝
--
-- HAND-ASSEMBLED from drizzle-kit output. Two edits, both mandatory:
--
--   1. THE PRAGMA. drizzle-kit emits `PRAGMA foreign_keys=OFF` / `=ON`, which is not
--      the lever D1 supports — D1's migrations documentation specifies
--      `PRAGMA defer_foreign_keys = true`, which holds for the surrounding
--      transaction and resets on commit (so it needs no matching re-enable).
--      `docs/migrations.md` §3.3a rule 1. Regenerating reintroduces the wrong pragma.
--
--   2. THE CASCADE CHAIN, which drizzle-kit cannot know about. drizzle's recreate is
--      `CREATE __new_X` → copy → `DROP TABLE X` → rename, and in SQLite `DROP TABLE`
--      performs an implicit DELETE that FIRES FOREIGN KEY ACTIONS. `defer_foreign_keys`
--      defers *violation reporting*, NOT cascade *actions*. Here the chain is two
--      levels deep — `integrations` → `claims` (ON DELETE CASCADE) → `attestations`
--      (ON DELETE CASCADE) — so the generated order would destroy 1,697 claims and
--      1,697 attestations: vendor-supplied evidence that cannot be reconstructed.
--      `0014_careful_absorbing_man.sql`, this repo's only prior recreate, never hit
--      this because `page_views` had no children.
--
--      MEASURED, not theorised: `src/test/migration-0022.spec.ts` seeds 6 claims and
--      6 attestations, applies this migration in the GENERATED order, and observes
--      `claims = 0, attestations = 0`. Restoring the order below returns 6 and 6.
--      Five of its eight cases fail if anyone reorders this file.
--
--      The order below makes `integrations` CHILDLESS before it is dropped, and each
--      child empty before ITS parent is dropped, so no cascade can reach a live row.
--      The two `__carry_*` tables are `CREATE TABLE … AS SELECT`, which produces a
--      constraint-free, FK-free copy — cascade-immune by construction.
--
-- THE ID-PRESERVATION TRICK (`DATABASE_SCHEMA.md` §9a.6). Each moved edge is inserted
-- into `connector_evidenced_pairs` with `id` = its `integrations.id` VERBATIM. So the
-- 85 production claims that ride along keep their `anchor_id` VALUE unchanged — only
-- which column holds it moves. `claims_identity_key` sees no change, there are no
-- unique violations, and every existing `audit_log` row, PostHog log line and
-- attestation keeps resolving to the same id.
--
-- THE ROUTING PREDICATE, used identically in steps 8, 9 and 11:
--     powered_by_product_id IS NOT NULL AND <> source AND <> target
-- Regardless of `mechanism_kind` (§13.2's open residue, resolved this way by AECI-721:
-- "accountable-party" means "no connector intermediary", not "no named builder", which
-- is why `connector_evidenced_pairs.built_by_vendor_id` exists on day one). The
-- self-reference exclusion is Convention A (§13.2a): ~60 production edges name one of
-- their own endpoints as the connector and STAY in `integrations` — the destination's
-- `connector_evidenced_pairs_distinct_connector` CHECK would refuse them anyway.
--
-- Measured against production 2026-08-31: 19 edges move, 85 claims and 85 attestations
-- ride along, 60 self-references stay, 53 `iPaaS`-with-NULL-`powered_by` stay.
--
-- DRY-RUN against production, read-only, same date — the routing predicate and the
-- direction CASE run as SELECTs before anything is written:
--   would_move 19 · distinct (connector, MIN, MAX) triples 19  → no unique-index
--     collision on `connector_evidenced_pairs_pair_idx`
--   direction: both 15 · b_to_a 2 · a_to_b 0 · NULL 2 · outside the enum 0
--     → the CASE is total over the real data — no row silently lands with a NULL
--       direction because its input was unrecognised.

PRAGMA defer_foreign_keys = true;--> statement-breakpoint
-- ── 1-2. Carry the two cascade-reachable tables out of harm's way ──────────────
-- `CREATE TABLE … AS SELECT` yields a plain table: no PK, no FKs, no CHECKs. Nothing
-- below can cascade into these, whatever order SQLite evaluates the drops in.
CREATE TABLE `__carry_claims` AS SELECT * FROM `claims`;--> statement-breakpoint
CREATE TABLE `__carry_attestations` AS SELECT * FROM `attestations`;--> statement-breakpoint
-- ── 3-4. Empty the children EXPLICITLY, deepest first ─────────────────────────
-- Not redundant with the drops below: this is what makes every later cascade a no-op
-- instead of a silent deletion. `attestations` first — it is the leaf.
DELETE FROM `attestations`;--> statement-breakpoint
DELETE FROM `claims`;--> statement-breakpoint
-- ── 5. Recreate `integrations` with `integrator` in the CHECK ─────────────────
-- Safe now: `claims` is empty, so the implicit DELETE behind `DROP TABLE integrations`
-- cascades into nothing.
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
	CONSTRAINT "integrations_direction_check" CHECK("direction" IN ('one-way', 'bidirectional')),
	CONSTRAINT "integrations_distinct_endpoints_check" CHECK("source_product_id" <> "target_product_id")
);--> statement-breakpoint
INSERT INTO `__new_integrations`("id", "name", "source_product_id", "target_product_id", "mechanism_kind", "mechanism_name", "direction", "built_by_vendor_id", "powered_by_product_id", "description", "listing_url", "docs_url", "website", "mechanism_url", "pricing_model", "maturity", "notes", "last_reviewed_at", "maintained_by", "created_at", "updated_at") SELECT "id", "name", "source_product_id", "target_product_id", "mechanism_kind", "mechanism_name", "direction", "built_by_vendor_id", "powered_by_product_id", "description", "listing_url", "docs_url", "website", "mechanism_url", "pricing_model", "maturity", "notes", "last_reviewed_at", "maintained_by", "created_at", "updated_at" FROM `integrations`;--> statement-breakpoint
DROP TABLE `integrations`;--> statement-breakpoint
ALTER TABLE `__new_integrations` RENAME TO `integrations`;--> statement-breakpoint
CREATE INDEX `integrations_source_idx` ON `integrations` (`source_product_id`);--> statement-breakpoint
CREATE INDEX `integrations_target_idx` ON `integrations` (`target_product_id`);--> statement-breakpoint
CREATE INDEX `integrations_mechanism_kind_idx` ON `integrations` (`mechanism_kind`);--> statement-breakpoint
CREATE INDEX `integrations_updated_at_idx` ON `integrations` (`updated_at`);--> statement-breakpoint
CREATE INDEX `integrations_built_by_idx` ON `integrations` (`built_by_vendor_id`) WHERE "built_by_vendor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `integrations_powered_by_idx` ON `integrations` (`powered_by_product_id`) WHERE "powered_by_product_id" IS NOT NULL;--> statement-breakpoint
-- ── 6. Recreate `claims` with the polymorphic anchor ──────────────────────────
-- A plain DROP + CREATE rather than drizzle's `__new_claims` copy-and-rename: the table
-- is empty (step 4), so there is nothing to copy — and the generated INSERT was invalid
-- anyway, since it listed `anchor_id`, which is GENERATED ALWAYS and cannot be written.
-- Its cascade reaches only the already-empty `attestations`.
DROP TABLE `claims`;--> statement-breakpoint
CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`integration_id` text,
	`connector_evidenced_pair_id` text,
	`data_object_id` text NOT NULL,
	`direction` text NOT NULL,
	`origin` text DEFAULT 'aeci' NOT NULL,
	`created_by_vendor_id` text,
	`anchor_id` text GENERATED ALWAYS AS (coalesce("integration_id", "connector_evidenced_pair_id")) STORED,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`integration_id`) REFERENCES `integrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connector_evidenced_pair_id`) REFERENCES `connector_evidenced_pairs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`data_object_id`) REFERENCES `taxonomy_data_objects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "claims_direction_check" CHECK("direction" IN ('a_to_b', 'b_to_a', 'both')),
	CONSTRAINT "claims_origin_check" CHECK("origin" IN ('aeci', 'vendor')),
	CONSTRAINT "claims_anchor_check" CHECK(("integration_id" IS NOT NULL) <> ("connector_evidenced_pair_id" IS NOT NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX `claims_identity_key` ON `claims` (`anchor_id`,`data_object_id`,`direction`);--> statement-breakpoint
CREATE INDEX `claims_data_object_idx` ON `claims` (`data_object_id`);--> statement-breakpoint
-- ── 7. Restore the claims, still anchored on `integrations` ───────────────────
-- `connector_evidenced_pair_id` is selected as a literal NULL, not copied: `__carry_claims`
-- is a snapshot of the OLD table, which has no such column. Every claim is restored
-- integration-anchored and step 9 moves the ones that migrate — which also keeps the
-- XOR satisfied at every point rather than only at the end.
--
-- Explicit column list, and `anchor_id` is ABSENT from it: the column is GENERATED
-- ALWAYS AS coalesce(integration_id, connector_evidenced_pair_id) STORED, so SQLite
-- computes it and rejects any attempt to supply it. Every FK still resolves — the 19
-- rows this migration removes from `integrations` are not removed until step 11.
INSERT INTO `claims` ("id", "integration_id", "connector_evidenced_pair_id", "data_object_id", "direction", "origin", "created_by_vendor_id", "created_at", "updated_at")
  SELECT "id", "integration_id", NULL, "data_object_id", "direction", "origin", "created_by_vendor_id", "created_at", "updated_at"
    FROM `__carry_claims`;--> statement-breakpoint
-- ── 8. The move: powered edges → the delivered tier's other table ─────────────
-- `id` is copied VERBATIM (see the header). The pair is canonicalised with MIN/MAX to
-- satisfy `connector_evidenced_pairs_canonical_order`, and `direction` is re-encoded
-- from the `one-way | bidirectional` vocabulary — which says nothing once the pair is
-- ordered — into claims' `a_to_b | b_to_a | both`. The CASE is lossless in both
-- directions and NULL maps to NULL (the CHECK constrains only non-null values).
INSERT INTO `connector_evidenced_pairs` (
  "id", "connector_product_id", "product_a_id", "product_b_id",
  "name", "built_by_vendor_id", "mechanism_name", "direction", "description",
  "website", "listing_url", "docs_url", "mechanism_url", "pricing_model", "maturity",
  "notes", "last_reviewed_at", "maintained_by", "created_at", "updated_at"
)
SELECT
  "id",
  "powered_by_product_id",
  MIN("source_product_id", "target_product_id"),
  MAX("source_product_id", "target_product_id"),
  "name",
  "built_by_vendor_id",
  "mechanism_name",
  CASE
    WHEN "direction" = 'bidirectional' THEN 'both'
    WHEN "direction" = 'one-way' AND "source_product_id" < "target_product_id" THEN 'a_to_b'
    WHEN "direction" = 'one-way' THEN 'b_to_a'
  END,
  "description", "website", "listing_url", "docs_url", "mechanism_url",
  "pricing_model", "maturity", "notes", "last_reviewed_at", "maintained_by",
  "created_at",
  "updated_at"
FROM `integrations`
WHERE "powered_by_product_id" IS NOT NULL
       AND "powered_by_product_id" <> "source_product_id"
       AND "powered_by_product_id" <> "target_product_id";--> statement-breakpoint
-- ── 9. Re-home the claims — ONE statement, so the XOR holds at every row-check ─
-- `claims_anchor_check` is `(integration_id IS NOT NULL) <> (connector_evidenced_pair_id
-- IS NOT NULL)`, evaluated per row after the whole row is updated. Setting both columns
-- in one UPDATE is what keeps it satisfied — two statements would leave every touched row
-- transiently double-anchored and fail.
--
-- Keyed off the routing predicate rather than off `connector_evidenced_pairs`' contents,
-- so it targets exactly the rows step 8 inserted even if that table were somehow not
-- empty beforehand.
UPDATE `claims`
   SET "connector_evidenced_pair_id" = "integration_id",
       "integration_id" = NULL
 WHERE "integration_id" IN (
   SELECT "id" FROM `integrations` WHERE "powered_by_product_id" IS NOT NULL
       AND "powered_by_product_id" <> "source_product_id"
       AND "powered_by_product_id" <> "target_product_id"
 );--> statement-breakpoint
-- ── 10. Restore the attestations ──────────────────────────────────────────────
-- Every `claim_id` resolves: step 7 restored the claims with their ids intact, and
-- step 9 changed which column each claim's anchor lives in, never the claim's own id.
INSERT INTO `attestations` ("id", "claim_id", "source", "asserted", "introduced_at", "deprecated_at", "introduced_version_id", "deprecated_version_id", "retracted_at", "attested_by_vendor_id", "note", "created_at", "updated_at")
  SELECT "id", "claim_id", "source", "asserted", "introduced_at", "deprecated_at", "introduced_version_id", "deprecated_version_id", "retracted_at", "attested_by_vendor_id", "note", "created_at", "updated_at"
    FROM `__carry_attestations`;--> statement-breakpoint
-- ── 11. Remove the moved edges from `integrations` ────────────────────────────
-- LAST, and only now safe: their claims stopped pointing here in step 9, so the
-- ON DELETE CASCADE reaches nothing. Run before step 9 and it would delete the 85
-- claims and their attestations outright.
DELETE FROM `integrations` WHERE "powered_by_product_id" IS NOT NULL
       AND "powered_by_product_id" <> "source_product_id"
       AND "powered_by_product_id" <> "target_product_id";--> statement-breakpoint
-- ── 12. Drop the carry tables ─────────────────────────────────────────────────
DROP TABLE `__carry_claims`;--> statement-breakpoint
DROP TABLE `__carry_attestations`;
