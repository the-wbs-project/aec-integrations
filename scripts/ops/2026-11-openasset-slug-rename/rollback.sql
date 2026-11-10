-- AECI-1574 rollback: put the `openasset-connector` slug back and drop the redirect row.
-- Run only if apply.sql must be undone. A redirect row left behind while the old slug is
-- live does nothing (a live row always wins), but drop it anyway so the map stays true.
-- The reversal writes its own audit row, once, and only where apply.sql had written one.

UPDATE products
SET slug = 'openasset-connector', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2'
  AND slug = 'openasset-source'
  AND NOT EXISTS (SELECT 1 FROM products WHERE slug = 'openasset-connector');

DELETE FROM slug_redirects
WHERE entity = 'product' AND from_slug = 'openasset-connector' AND to_slug = 'openasset-source';

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata, vendor_id, product_id, created_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'product.updated', 'product', id,
  '{"slug":"openasset-source"}', '{"slug":"openasset-connector"}',
  '{"source":"ops","issue":"AECI-1574","script":"scripts/ops/2026-11-openasset-slug-rename/rollback.sql"}',
  '9e20c13f-3bcd-4238-9a4a-b246cb8e8964', id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products
WHERE id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2' AND slug = 'openasset-connector'
  AND EXISTS (
    SELECT 1 FROM audit_log
    WHERE entity_id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2' AND action = 'product.updated'
      AND json_extract(metadata, '$.script') = 'scripts/ops/2026-11-openasset-slug-rename/apply.sql'
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log
    WHERE entity_id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2' AND action = 'product.updated'
      AND json_extract(metadata, '$.script') = 'scripts/ops/2026-11-openasset-slug-rename/rollback.sql'
  );
