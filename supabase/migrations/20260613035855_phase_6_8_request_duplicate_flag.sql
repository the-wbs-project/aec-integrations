-- AECI-215 (Phase 6.8) — Add `duplicate_of_request_id` to `vendor_requests`.
--
-- Persists the duplicate-detection signal computed at submit time (§7.2): when a new
-- claim/correction matches an existing `open` request for the same target (same kind,
-- or same submitter_email), this points at the EARLIEST such request — the "original".
-- Informational only — never auto-rejects; the admin dashboard (6.10) reads it directly.
--
-- Self-referential FK to vendor_requests(id); ON DELETE SET NULL so removing the
-- original never orphans the pointer (rows are status-archived in Stage 1, but the FK
-- stays correct regardless). Nullable — most submits have no duplicate. No index: the
-- detection lookup rides the existing vendor_requests_target_idx (target_type, target_id),
-- and the column is only ever read per-row, not filtered on.
--
-- Forward-only per docs/migrations.md §3.1. `IF NOT EXISTS` keeps re-apply safe. The
-- schema.prisma field is hand-mirrored (db:pull is unusable under P1012 multiSchema;
-- see docs/prisma.md).

BEGIN;

ALTER TABLE "vendor_requests"
  ADD COLUMN IF NOT EXISTS "duplicate_of_request_id" UUID
    REFERENCES "vendor_requests" ("id") ON DELETE SET NULL;

COMMIT;
