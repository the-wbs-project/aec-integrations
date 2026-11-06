-- AECI-1618. Dry run for claim-ended-apply.sql. Writes nothing.
-- One row per owned vendor with no unbanned seat, and the date the apply would store: its
-- last seat revoke when one is on record, else the moment the apply runs. A date in the
-- past makes the logo removal due at the next daily run.
--
-- `wrangler d1 execute --file` never returns rows, so run this with --command.
-- Run order and commands: README.md. Run sourced-logo-apply.sql BEFORE claim-ended-apply.sql.
SELECT v.id, v.slug, v.owned_at, v.logo_source,
  (SELECT max(a.created_at) FROM audit_log a
    WHERE a.action = 'vendor_claim.seat_revoked' AND a.vendor_id = v.id) AS proposed_claim_ended_at,
  (SELECT count(*) FROM profiles s WHERE s.vendor_id = v.id AND s.role = 'vendor_admin') AS banned_seats,
  (SELECT count(*) FROM product_vendors pv WHERE pv.vendor_id = v.id) AS products
FROM vendors v
WHERE v.owned_at IS NOT NULL AND v.claim_ended_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM profiles s
    WHERE s.vendor_id = v.id AND s.role = 'vendor_admin' AND s.banned_at IS NULL);
