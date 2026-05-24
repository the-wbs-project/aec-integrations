-- AECI-48 / Phase 2 Spec §5.1: rebuild vendor_requests with the loose-polymorphic shape.
--
-- The baseline migration (20260515024116_baseline_schema) created vendor_requests
-- with separate vendor_id / product_id FKs + payload jsonb. Phase 2 §5.1 supersedes
-- that with (target_type, target_id), explicit submitter_* + domain_match + body +
-- source_url columns, an 'in_review' status, and resolved_by referencing profiles.
--
-- Forms ship in Phase 6, so no rows exist in any environment — a drop+recreate is
-- safe and avoids a column-by-column ALTER dance. Reversal recipe if ever needed:
-- reapply baseline migration lines 251-265 (CREATE TABLE), 447 (kind/status index),
-- 531-534 (vendor/product FKs), 642-647 (kind/status CHECKs), 698-707 (partial
-- indexes). No separate down-file is maintained, matching the project's
-- forward-only convention (see 20260522000000_pin_handle_new_user_search_path).

BEGIN;

-- ─── Drop existing shape ─────────────────────────────────────────────────────
ALTER TABLE "vendor_requests" DROP CONSTRAINT IF EXISTS "vendor_requests_vendor_id_fkey";
ALTER TABLE "vendor_requests" DROP CONSTRAINT IF EXISTS "vendor_requests_product_id_fkey";
DROP INDEX IF EXISTS "vendor_requests_kind_status_idx";
DROP INDEX IF EXISTS "vendor_requests_vendor_idx";
DROP INDEX IF EXISTS "vendor_requests_product_idx";
DROP INDEX IF EXISTS "vendor_requests_linear_idx";
DROP TABLE IF EXISTS "vendor_requests";

-- ─── Create Phase 2 §5.1 shape ───────────────────────────────────────────────
CREATE TABLE "vendor_requests" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind"            TEXT NOT NULL,
    "target_type"     TEXT NOT NULL,
    -- target_id is NOT NULL: a vendor_request without a target is meaningless.
    -- §5.1's code block is silent on nullability; this is the only sensible choice.
    "target_id"       UUID NOT NULL,
    "submitter_email" TEXT NOT NULL,
    "submitter_name"  TEXT,
    "submitter_role"  TEXT,
    "domain_match"    TEXT NOT NULL DEFAULT 'pending',
    "body"            TEXT NOT NULL,
    "source_url"      TEXT,
    "status"          TEXT NOT NULL DEFAULT 'open',
    "linear_issue_id" TEXT,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at"     TIMESTAMPTZ(6),
    "resolved_by"     UUID,

    CONSTRAINT "vendor_requests_pkey" PRIMARY KEY ("id")
);

-- ─── CHECK constraints (text + CHECK convention, matching baseline) ──────────
ALTER TABLE "vendor_requests"
  ADD CONSTRAINT vendor_requests_kind_check
    CHECK ("kind" IN ('claim', 'correction'));

ALTER TABLE "vendor_requests"
  ADD CONSTRAINT vendor_requests_target_type_check
    CHECK ("target_type" IN ('product', 'vendor'));

ALTER TABLE "vendor_requests"
  ADD CONSTRAINT vendor_requests_status_check
    CHECK ("status" IN ('open', 'in_review', 'resolved', 'rejected'));

ALTER TABLE "vendor_requests"
  ADD CONSTRAINT vendor_requests_domain_match_check
    CHECK ("domain_match" IN ('pending', 'match', 'no_match', 'manual_review'));

-- ─── FK to profiles (profiles exists from 20260515052617_auth_integration) ───
ALTER TABLE "vendor_requests"
  ADD CONSTRAINT "vendor_requests_resolved_by_fkey"
  FOREIGN KEY ("resolved_by") REFERENCES "profiles"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- ─── Indexes per Phase 2 §5.1 acceptance criteria ────────────────────────────
CREATE INDEX "vendor_requests_status_idx"
  ON "vendor_requests"("status");

CREATE INDEX "vendor_requests_target_idx"
  ON "vendor_requests"("target_type", "target_id");

CREATE INDEX "vendor_requests_created_at_idx"
  ON "vendor_requests"("created_at" DESC);

-- ─── Re-enable RLS (DROP TABLE wipes it). The admin-read policy in
--     docs/rls_policies.sql will be re-created on the next apply of that file. ─
ALTER TABLE "vendor_requests" ENABLE ROW LEVEL SECURITY;

COMMIT;
