-- Run immediately after reset.sql. Every value must match the comment.
SELECT
  (SELECT COUNT(*) FROM integrations)           AS integrations,     -- 0
  (SELECT COUNT(*) FROM claims)                 AS claims,           -- 0
  (SELECT COUNT(*) FROM attestations)           AS attestations,     -- 0
  (SELECT COUNT(*) FROM product_extensions)     AS product_ext,      -- 0
  (SELECT COUNT(*) FROM product_categories)     AS product_cats,     -- 0
  (SELECT COUNT(*) FROM product_audiences)      AS product_auds,     -- 0
  (SELECT COUNT(*) FROM product_phases)         AS product_phases,   -- 0
  (SELECT COUNT(*) FROM product_vendors)        AS product_vendors,  -- 0
  (SELECT COUNT(*) FROM taxonomy_categories)    AS tax_categories,   -- 0
  (SELECT COUNT(*) FROM taxonomy_audiences)     AS tax_audiences,    -- 0
  (SELECT COUNT(*) FROM taxonomy_phases)        AS tax_phases,       -- 0
  (SELECT COUNT(*) FROM taxonomy_data_objects)  AS data_objects,     -- 20 (unchanged)
  (SELECT COUNT(*) FROM products)               AS products,         -- 123 (unchanged)
  (SELECT COUNT(*) FROM vendors)                AS vendors,          -- 83 (unchanged)
  (SELECT COUNT(*) FROM page_views)             AS page_views,       -- ~11.3k (unchanged)
  (SELECT COUNT(*) FROM audit_log)              AS audit_log;        -- ~9k, +1 from the reset row
