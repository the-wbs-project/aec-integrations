-- AECI-1495 — rename the live `coda` slugs after the Coda -> Superhuman rebrand.
-- Run against PRODUCTION only (`aeci-app-production-us`), per README.md. Not a migration:
-- it changes rows that no migration created (ruled 2026-10-28).
--
-- Safe to run twice. Each UPDATE is keyed on the production id AND the old slug, and
-- refuses when the new slug is already taken. The redirect rows ignore a duplicate. Each
-- audit row is written only where the rename landed and only once.
--
-- `updated_at` is set by hand because raw SQL skips Drizzle's `$onUpdate`. The Algolia
-- sync is a delta on `updated_at`, so without it the search records keep `coda`.
--
-- The audit rows reuse `vendor.updated` / `product.updated` (a slug is catalog state,
-- ADR 0022) with the slug in before/after and `metadata.source = 'ops'`.

UPDATE vendors
SET slug = 'superhuman', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3'
  AND slug = 'coda'
  AND NOT EXISTS (SELECT 1 FROM vendors WHERE slug = 'superhuman');

UPDATE products
SET slug = 'superhuman-docs', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = 'dee0b67c-160e-4804-a17a-4459dc6071ca'
  AND slug = 'coda'
  AND NOT EXISTS (SELECT 1 FROM products WHERE slug = 'superhuman-docs');

INSERT INTO slug_redirects (entity, from_slug, to_slug, reason, created_at)
SELECT 'vendor', 'coda', 'superhuman', 'AECI-1495 — Coda renamed Superhuman (2026-07-08); live slug renamed.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM vendors WHERE id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3' AND slug = 'superhuman')
ON CONFLICT (entity, from_slug) DO NOTHING;

INSERT INTO slug_redirects (entity, from_slug, to_slug, reason, created_at)
SELECT 'product', 'coda', 'superhuman-docs', 'AECI-1495 — Coda renamed Superhuman Docs (2026-07-08); live slug renamed.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (SELECT 1 FROM products WHERE id = 'dee0b67c-160e-4804-a17a-4459dc6071ca' AND slug = 'superhuman-docs')
ON CONFLICT (entity, from_slug) DO NOTHING;

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata, vendor_id, created_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'vendor.updated', 'vendor', id,
  '{"slug":"coda"}', '{"slug":"superhuman"}',
  '{"source":"ops","issue":"AECI-1495","script":"scripts/ops/2026-10-coda-slug-rename/apply.sql"}',
  id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM vendors
WHERE id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3' AND slug = 'superhuman'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log
    WHERE entity_id = 'f13e7be3-317a-47b8-be47-de9ef26d8ac3'
      AND action = 'vendor.updated'
      AND json_extract(metadata, '$.issue') = 'AECI-1495'
  );

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, before_state, after_state, metadata, vendor_id, product_id, created_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'product.updated', 'product', id,
  '{"slug":"coda"}', '{"slug":"superhuman-docs"}',
  '{"source":"ops","issue":"AECI-1495","script":"scripts/ops/2026-10-coda-slug-rename/apply.sql"}',
  'f13e7be3-317a-47b8-be47-de9ef26d8ac3', id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM products
WHERE id = 'dee0b67c-160e-4804-a17a-4459dc6071ca' AND slug = 'superhuman-docs'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log
    WHERE entity_id = 'dee0b67c-160e-4804-a17a-4459dc6071ca'
      AND action = 'product.updated'
      AND json_extract(metadata, '$.issue') = 'AECI-1495'
  );
