-- Run AFTER the full re-promotion finishes. Replace the timestamp with the
-- moment the re-push started (UTC ISO). Any product/vendor listed here was
-- NOT touched by the re-push — i.e., it no longer exists in the cleaned
-- source data. Retract each with `pnpm ops:retract-product` (apps/api), or
-- delete manually (NULL the matching page_views.product_id / vendor_id rows
-- first — those FKs have no ON DELETE action and will block the delete).
SELECT 'product' AS kind, id, slug, name, updated_at
FROM products
WHERE updated_at < '2026-07-25T00:00:00.000Z'  -- <-- re-push start time
UNION ALL
SELECT 'vendor', id, slug, name, updated_at
FROM vendors
WHERE updated_at < '2026-07-25T00:00:00.000Z'  -- <-- re-push start time
ORDER BY kind, slug;
