-- AECI-1618. Dry run for sourced-logo-apply.sql. Writes nothing.
-- One row per record the apply would change: the logo a local save overwrote, read from
-- the before state of the record's earliest logo edit, when promote still owned the logo.
--
-- `wrangler d1 execute --file` never returns rows, so run this with --command.
-- Run order and commands: README.md. Run sourced-logo-apply.sql BEFORE claim-ended-apply.sql.
SELECT 'vendor' AS entity_type, v.id, v.slug, v.logo_source, v.logo_url AS current_logo,
  (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
    WHERE a.entity_type = 'vendor' AND a.entity_id = v.id AND a.action = 'vendor.updated'
      AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
    ORDER BY a.created_at, a.id LIMIT 1) AS proposed_sourced_logo
FROM vendors v
WHERE v.logo_source IS NOT NULL AND v.sourced_logo_url IS NULL
  AND (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
    WHERE a.entity_type = 'vendor' AND a.entity_id = v.id AND a.action = 'vendor.updated'
      AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
    ORDER BY a.created_at, a.id LIMIT 1) IS NOT NULL
  AND (SELECT json_extract(a.before_state, '$.logoSource') FROM audit_log a
    WHERE a.entity_type = 'vendor' AND a.entity_id = v.id AND a.action = 'vendor.updated'
      AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
    ORDER BY a.created_at, a.id LIMIT 1) IS NULL
UNION ALL
SELECT 'product', p.id, p.slug, p.logo_source, p.logo_url,
  (SELECT json_extract(a.before_state, '$.logoUrl') FROM audit_log a
    WHERE a.entity_type = 'product' AND a.entity_id = p.id AND a.action = 'product.updated'
      AND json_type(a.after_state, '$.logoUrl') IS NOT NULL
    ORDER BY a.created_at, a.id LIMIT 1)
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
