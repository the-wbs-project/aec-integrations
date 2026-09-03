-- AECI-303 (§9) — the version-diff scenario, for LOCAL development only.
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
-- The §9 selectors only render when a pair has BOTH product releases AND at least
-- one version-stamped attestation. Nothing produces either automatically: promote
-- does not ingest versions (§11), and the only writer is
-- `/api/vendor/products/:id/versions`, which needs a Verified-vendor session. So a
-- freshly seeded local D1 shows no version chrome at all — correct, but it means the
-- feature cannot be exercised by hand, and the self-skipping interaction block in
-- `apps/web/e2e/products-pair.spec.ts` skips.
--
-- This file is that missing input. Apply it with:
--   pnpm --filter @aeci/api db:seed:version-diff:local
--
-- Deliberately NOT part of `db:seed:local`: it is a narrow demo of one epic's
-- surface, not baseline reference data, and every other pair page should keep
-- showing the launch-reality default so a regression there stays visible.
--
-- Covers the four cases that matter, on the revit ⇄ procore pair from
-- `seed/catalog.sql` (revit is endpoint A, so `vendor_a` is Revit's slot):
--   models         — UNSTAMPED, so present at every selection (the 1.5 baseline)
--   drawings       — introduced in Revit 2026.10  → `added` at latest
--   specifications — deprecated in Revit 2026.10  → `removed` at latest
--                    …and carries a RETRACTED earlier position, so the per-claim
--                    timeline has real append-only history to render.
--
-- `2026.9` before `2026.10` is included on purpose: it is the case a lexical sort
-- gets wrong, and the reason `sort_key` is a non-negotiable INTEGER column (§8.2).

DELETE FROM product_versions WHERE id LIKE 'd0000000-0000-4000-8000-%';
DELETE FROM attestations WHERE id LIKE 'f0000000-0000-4000-8000-%';
DELETE FROM claims WHERE id LIKE 'e0000000-0000-4000-8000-%';

-- Revit releases (endpoint A). sort_key is what `deriveVersionSortKey` produces.
INSERT INTO product_versions (id, product_id, label, released_at, sunset_at, sort_key, created_at, updated_at) VALUES
 ('d0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','2026.1','2026-01-15',NULL,20260000100000,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 ('d0000000-0000-4000-8000-000000000002','b0000000-0000-4000-8000-000000000001','2026.9','2026-06-15',NULL,20260000900000,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z'),
 ('d0000000-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000001','2026.10','2026-09-15',NULL,20260001000000,'2026-01-03T00:00:00.000Z','2026-01-03T00:00:00.000Z');

-- Procore releases (endpoint B). A different label scheme on purpose: `sort_key` is
-- per-product, and comparing it across two products is meaningless arithmetic.
INSERT INTO product_versions (id, product_id, label, released_at, sunset_at, sort_key, created_at, updated_at) VALUES
 ('d0000000-0000-4000-8000-000000000011','b0000000-0000-4000-8000-000000000004','v4',NULL,NULL,40000000000,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 ('d0000000-0000-4000-8000-000000000012','b0000000-0000-4000-8000-000000000004','v5',NULL,NULL,50000000000,'2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z');

INSERT INTO claims (id, integration_id, data_object_id, direction, created_at, updated_at) VALUES
 ('e0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000002','12f6d14b-b996-565a-beda-c35f72136e13','a_to_b','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 ('e0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000002','990704b3-6374-5639-82ad-62ed19e29811','a_to_b','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
 ('e0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000002','e25eeda0-3650-5a74-b3a0-b266a3eaf1c1','b_to_a','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');

-- models: the unstamped AECi seed. Must never vanish from any selection.
INSERT INTO attestations (id, claim_id, source, asserted, introduced_at, deprecated_at, retracted_at, attested_by_vendor_id, note, created_at, updated_at, introduced_version_id, deprecated_version_id) VALUES
 ('f0000000-0000-4000-8000-000000000001','e0000000-0000-4000-8000-000000000001','aeci',1,NULL,NULL,NULL,NULL,'Curated by AECi.','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',NULL,NULL);

-- drawings: introduced in 2026.10 → `added` at latest, absent at 2026.9.
INSERT INTO attestations (id, claim_id, source, asserted, introduced_at, deprecated_at, retracted_at, attested_by_vendor_id, note, created_at, updated_at, introduced_version_id, deprecated_version_id) VALUES
 ('f0000000-0000-4000-8000-000000000002','e0000000-0000-4000-8000-000000000002','vendor_a',1,NULL,NULL,NULL,'a0000000-0000-4000-8000-000000000001','Added in the 2026.10 release.','2026-03-01T00:00:00.000Z','2026-03-01T00:00:00.000Z','d0000000-0000-4000-8000-000000000003',NULL);

-- specifications: 2026.1 → 2026.10, so `removed` at latest and present at 2026.9.
INSERT INTO attestations (id, claim_id, source, asserted, introduced_at, deprecated_at, retracted_at, attested_by_vendor_id, note, created_at, updated_at, introduced_version_id, deprecated_version_id) VALUES
 ('f0000000-0000-4000-8000-000000000003','e0000000-0000-4000-8000-000000000003','vendor_a',1,NULL,NULL,NULL,'a0000000-0000-4000-8000-000000000001','Dropped in 2026.10.','2026-04-01T00:00:00.000Z','2026-04-01T00:00:00.000Z','d0000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000003');

-- …and the position it superseded. `retracted_at` is set, the row is NOT deleted —
-- that is the append-only model (§2.1) the timeline reads, and the reason
-- `attestations_slot_key` is PARTIAL on `retracted_at IS NULL` (so only one live row
-- may hold a slot while any number of retracted ones may share it).
INSERT INTO attestations (id, claim_id, source, asserted, introduced_at, deprecated_at, retracted_at, attested_by_vendor_id, note, created_at, updated_at, introduced_version_id, deprecated_version_id) VALUES
 ('f0000000-0000-4000-8000-000000000004','e0000000-0000-4000-8000-000000000003','vendor_a',1,NULL,NULL,'2026-04-01T00:00:00.000Z','a0000000-0000-4000-8000-000000000001','Originally introduced in 2026.1.','2026-02-01T00:00:00.000Z','2026-02-01T00:00:00.000Z','d0000000-0000-4000-8000-000000000001',NULL);
