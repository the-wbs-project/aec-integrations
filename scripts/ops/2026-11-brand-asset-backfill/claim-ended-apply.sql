-- AECI-1618. Backfills `claim_ended_at` for owned vendors with no unbanned seat. Review
-- claim-ended-dry-run.sql first. Run after migration 0105, once per environment.
-- Idempotent: it only touches a vendor whose claim has no end date.
--
-- The audit row comes first because the guard reads the column the UPDATE fills. The
-- products go before the vendor for the same reason. `updated_at` moves on both, so the
-- nightly Algolia sync sees the flip.
-- Run order and commands: README.md. Run sourced-logo-apply.sql BEFORE claim-ended-apply.sql.

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, vendor_id, before_state, after_state, metadata, created_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'vendor.claim_ended', 'vendor', v.id, v.id,
  json_object('claim_ended_at', NULL),
  json_object('claim_ended_at', COALESCE(
    (SELECT max(a.created_at) FROM audit_log a
      WHERE a.action = 'vendor_claim.seat_revoked' AND a.vendor_id = v.id),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))),
  json_object('source', 'ops:backfill-claim-ended', 'vendorId', v.id, 'cause', 'backfill'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM vendors v
WHERE v.owned_at IS NOT NULL AND v.claim_ended_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM profiles s
    WHERE s.vendor_id = v.id AND s.role = 'vendor_admin' AND s.banned_at IS NULL);

UPDATE products SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT pv.product_id FROM product_vendors pv
  JOIN vendors v ON v.id = pv.vendor_id
  WHERE v.owned_at IS NOT NULL AND v.claim_ended_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM profiles s
      WHERE s.vendor_id = v.id AND s.role = 'vendor_admin' AND s.banned_at IS NULL)
);

UPDATE vendors AS v SET
  claim_ended_at = COALESCE(
    (SELECT max(a.created_at) FROM audit_log a
      WHERE a.action = 'vendor_claim.seat_revoked' AND a.vendor_id = v.id),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE v.owned_at IS NOT NULL AND v.claim_ended_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM profiles s
    WHERE s.vendor_id = v.id AND s.role = 'vendor_admin' AND s.banned_at IS NULL);
