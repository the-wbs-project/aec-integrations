-- AECI-1495 rollback: put the `coda` slugs back and drop the two redirect rows.
-- Run only if apply.sql must be undone. A redirect row left behind while the `coda` row is
-- live does nothing (a live row always wins), but drop it anyway so the map stays true.
-- Each reversal writes its own audit row, once, and only where apply.sql had written one.

UPDATE vendors
SET slug = 'coda', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3'
  AND slug = 'superhuman'
  AND NOT EXISTS (SELECT 1 FROM vendors WHERE slug = 'coda');

UPDATE products
SET slug = 'coda', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'dee0b67c-160e-4804-a17a-4459dc6071ca'
  AND slug = 'superhuman-docs'
  AND NOT EXISTS (SELECT 1 FROM products WHERE slug = 'coda');

DELETE FROM slug_redirects
WHERE from_slug = 'coda'
  AND ((entity = 'vendor' AND to_slug = 'superhuman') OR (entity = 'product' AND to_slug = 'superhuman-docs'));

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata, vendor_id, created_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'vendor.updated', 'vendor', id,
  '{"slug":"superhuman"}', '{"slug":"coda"}',
  '{"source":"ops","issue":"AECI-1495","script":"scripts/ops/2026-10-coda-slug-rename/rollback.sql"}',
  id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM vendors
WHERE id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3' AND slug = 'coda'
  AND EXISTS (
    SELECT 1 FROM audit_log
    WHERE entity_id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3' AND action = 'vendor.updated'
      AND json_extract(metadata, '$.script') = 'scripts/ops/2026-10-coda-slug-rename/apply.sql'
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log
    WHERE entity_id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3' AND action = 'vendor.updated'
      AND json_extract(metadata, '$.script') = 'scripts/ops/2026-10-coda-slug-rename/rollback.sql'
  );

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata, vendor_id, product_id, created_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'product.updated', 'product', id,
  '{"slug":"superhuman-docs"}', '{"slug":"coda"}',
  '{"source":"ops","issue":"AECI-1495","script":"scripts/ops/2026-10-coda-slug-rename/rollback.sql"}',
  'f13e7be3-317a-47b8-be47-de9ef26d8ac3', id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products
WHERE id = 'dee0b67c-160e-4804-a17a-4459dc6071ca' AND slug = 'coda'
  AND EXISTS (
    SELECT 1 FROM audit_log
    WHERE entity_id = 'dee0b67c-160e-4804-a17a-4459dc6071ca' AND action = 'product.updated'
      AND json_extract(metadata, '$.script') = 'scripts/ops/2026-10-coda-slug-rename/apply.sql'
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log
    WHERE entity_id = 'dee0b67c-160e-4804-a17a-4459dc6071ca' AND action = 'product.updated'
      AND json_extract(metadata, '$.script') = 'scripts/ops/2026-10-coda-slug-rename/rollback.sql'
  );
