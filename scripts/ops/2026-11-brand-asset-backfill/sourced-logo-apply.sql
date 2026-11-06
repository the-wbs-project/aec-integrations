-- AECI-1618. Backfills `sourced_logo_url` for records a local save overwrote before the
-- column existed. Review sourced-logo-dry-run.sql first. Run after migration 0103, once
-- per environment. Idempotent: it only fills an empty column.
--
-- Each record gets its audit row first, in this one file, because the guard reads the
-- column the UPDATE fills. `updated_at` stays: nothing public renders this column.
-- Run order and commands: README.md. Run sourced-logo-apply.sql BEFORE claim-ended-apply.sql.

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, vendor_id, before_state, after_state, metadata, created_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'vendor.updated', 'vendor', v.id, v.id,
  json_object('sourcedLogoUrl', NULL),
  json_object('sourcedLogoUrl', (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
      WHERE a.entity_type = 'vendor' AND a.entity_id = v.id AND a.action = 'vendor.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1)),
  json_object('source', 'ops:backfill-sourced-logo', 'reason', 'AECI-1618'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM vendors v
WHERE v.logo_source IS NOT NULL AND v.sourced_logo_url IS NULL
  AND (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
      WHERE a.entity_type = 'vendor' AND a.entity_id = v.id AND a.action = 'vendor.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1) IS NOT NULL
  AND (SELECT json_extract(a.before_state, '$.logoSource') FROM audit_log a
      WHERE a.entity_type = 'vendor' AND a.entity_id = v.id AND a.action = 'vendor.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1) IS NULL;

UPDATE vendors AS v SET sourced_logo_url = (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
      WHERE a.entity_type = 'vendor' AND a.entity_id = v.id AND a.action = 'vendor.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1)
WHERE v.logo_source IS NOT NULL AND v.sourced_logo_url IS NULL
  AND (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
      WHERE a.entity_type = 'vendor' AND a.entity_id = v.id AND a.action = 'vendor.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1) IS NOT NULL
  AND (SELECT json_extract(a.before_state, '$.logoSource') FROM audit_log a
      WHERE a.entity_type = 'vendor' AND a.entity_id = v.id AND a.action = 'vendor.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1) IS NULL;

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, product_id, before_state, after_state, metadata, created_at)
SELECT lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'product.updated', 'product', p.id, p.id,
  json_object('sourcedLogoUrl', NULL),
  json_object('sourcedLogoUrl', (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
      WHERE a.entity_type = 'product' AND a.entity_id = p.id AND a.action = 'product.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1)),
  json_object('source', 'ops:backfill-sourced-logo', 'reason', 'AECI-1618'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products p
WHERE p.logo_source IS NOT NULL AND p.sourced_logo_url IS NULL
  AND (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
      WHERE a.entity_type = 'product' AND a.entity_id = p.id AND a.action = 'product.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1) IS NOT NULL
  AND (SELECT json_extract(a.before_state, '$.logoSource') FROM audit_log a
      WHERE a.entity_type = 'product' AND a.entity_id = p.id AND a.action = 'product.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1) IS NULL;

UPDATE products AS p SET sourced_logo_url = (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
      WHERE a.entity_type = 'product' AND a.entity_id = p.id AND a.action = 'product.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1)
WHERE p.logo_source IS NOT NULL AND p.sourced_logo_url IS NULL
  AND (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
      WHERE a.entity_type = 'product' AND a.entity_id = p.id AND a.action = 'product.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1) IS NOT NULL
  AND (SELECT json_extract(a.before_state, '$.logoSource') FROM audit_log a
      WHERE a.entity_type = 'product' AND a.entity_id = p.id AND a.action = 'product.updated'
        AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
      ORDER BY a.created_at, a.id LIMIT 1) IS NULL;
