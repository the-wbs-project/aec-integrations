-- AECI-1574 — rename the live `openasset-connector` product slug to `openasset-source`.
-- The row was the OpenAsset Connector until AECI-496 made it the main product, and it was
-- renamed OpenAsset Source on 2026-11-02. Only the product changes. The vendor keeps
-- `openasset`.
-- Run against PRODUCTION only (`aeci-app-production-us`), per README.md. Not a migration:
-- it changes a row that no migration created (ruled 2026-10-28, AECI-1495).
--
-- Safe to run twice. The UPDATE is keyed on the production id AND the old slug, and
-- refuses when the new slug is already taken. The redirect row ignores a duplicate. The
-- audit row is written only where the rename landed and only once.
--
-- `updated_at` is set by hand because raw SQL skips Drizzle's `$onUpdate`. The Algolia
-- sync is a delta on `updated_at`, so without it the search record keeps the old slug.
--
-- The audit row reuses `product.updated` (a slug is catalog state, ADR 0022) with the
-- slug in before/after and `metadata.source = 'ops'`. `vendor_id` is OpenAsset's id from
-- `product_vendors`, read in the preflight.

UPDATE products
SET slug = 'openasset-source', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2'
  AND slug = 'openasset-connector'
  AND NOT EXISTS (SELECT 1 FROM products WHERE slug = 'openasset-source');

INSERT INTO slug_redirects (entity, from_slug, to_slug, reason, created_at)
SELECT 'product', 'openasset-connector', 'openasset-source', 'AECI-1574 — OpenAsset Connector became OpenAsset Source (renamed 2026-11-02); live slug renamed.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM products WHERE id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2' AND slug = 'openasset-source')
ON CONFLICT (entity, from_slug) DO NOTHING;

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata, vendor_id, product_id, created_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'product.updated', 'product', id,
  '{"slug":"openasset-connector"}', '{"slug":"openasset-source"}',
  '{"source":"ops","issue":"AECI-1574","script":"scripts/ops/2026-11-openasset-slug-rename/apply.sql"}',
  '9e20c13f-3bcd-4238-9a4a-b246cb8e8964', id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products
WHERE id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2' AND slug = 'openasset-source'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log
    WHERE entity_id = '3ddbf0dc-70c1-4f8f-a3fc-b85ef7deeaa2'
      AND action = 'product.updated'
      AND json_extract(metadata, '$.issue') = 'AECI-1574'
  );
