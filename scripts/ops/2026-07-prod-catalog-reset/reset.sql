-- ============================================================
-- PROD catalog reset: everything EXCEPT products & vendors
-- Target:  Cloudflare dashboard -> D1 -> aeci-app-production -> Console
-- Date:    prepared 2026-07-25 (row counts verified against live prod)
-- Keeps:   products, vendors, taxonomy_data_objects, page_views,
--          audit_log, profiles, stats_cache, d1_migrations
--
-- The D1 console is NOT atomic across statements. Order is child-first,
-- so a mid-run failure leaves an FK-consistent partial state — re-run
-- from where it stopped.
-- ============================================================

-- 1) Integration tree, children first (the integrations delete would
--    cascade the first two anyway; explicit deletes make the console
--    output predictable).
DELETE FROM attestations;          -- expect 712
DELETE FROM claims;                -- expect 712
DELETE FROM integrations;          -- expect 397

-- 2) Product join sets + extensions — fully rebuilt by the re-push
--    ("join sets are replaced to exactly match what you send").
DELETE FROM product_extensions;    -- expect 6
DELETE FROM product_categories;    -- expect 241
DELETE FROM product_audiences;     -- expect 450
DELETE FROM product_phases;        -- expect 309
DELETE FROM product_vendors;       -- expect 124

-- 3) Taxonomy terms — promote re-creates whatever the cleaned data still
--    uses; dead terms disappear. taxonomy_data_objects is deliberately
--    ABSENT: promote resolves claims against it but never creates it.
DELETE FROM taxonomy_categories;   -- expect 33
DELETE FROM taxonomy_audiences;    -- expect 30
DELETE FROM taxonomy_phases;       -- expect 5

-- 4) Reset the denormalized counter so kept product pages don't claim
--    integrations that no longer exist. Re-push recomputes it. Raw SQL
--    doesn't touch updated_at, which keeps the orphan-detection diff clean.
UPDATE products SET integration_count = 0;

-- 5) Audit record for the manual reset (id/created_at are app-side
--    Drizzle defaults, so raw SQL must supply them).
INSERT INTO audit_log (id, actor_id, actor_type, action, entity_type, entity_id, metadata, created_at)
VALUES (
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || hex(randomblob(6))),
  NULL,
  'admin',
  'catalog.integrations_reset',
  NULL,
  NULL,
  json_object(
    'reason', 'data-quality reset ahead of full re-promotion; products and vendors retained',
    'operator', 'chrisw@thewbsproject.com',
    'scope', 'integrations, claims, attestations, product joins/extensions, taxonomy terms (not data_objects)'
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);
