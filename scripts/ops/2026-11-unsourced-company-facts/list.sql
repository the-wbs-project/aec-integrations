-- AECI-1634. Read-only. Lists live vendors that do not own their record and hold a
-- headquarters or founded year with no source URL. The vendor page hides such a value,
-- but search, VendorListItem, Algolia and the JSON-LD still show it
-- (STAGE_2_VENDOR_PORTAL_SPEC.md §6.23, "Known gap").
--
-- A field that an active AECi correction still holds is left out: it shows with the
-- correction's own source (AECI-1614). `override_value` shows any active override whose
-- value no longer matches, so it can be reviewed by hand. Run with --command: --file
-- returns no rows.
SELECT v.id, v.slug, v.company_name, f.fact, f.value, f.source_url, f.checked_at,
  (SELECT count(*) FROM product_vendors pv JOIN products p ON p.id = pv.product_id
     WHERE pv.vendor_id = v.id AND p.promotion_status = 'promoted') AS live_products,
  (SELECT fo.value FROM field_overrides fo
     WHERE fo.entity_type = 'vendor' AND fo.entity_id = v.id AND fo.field = f.fact
       AND fo.lifted_at IS NULL) AS override_value
FROM vendors v
JOIN (
  SELECT id AS vendor_id, 'headquarters' AS fact, headquarters AS value,
    headquarters_source_url AS source_url, headquarters_checked_at AS checked_at
  FROM vendors WHERE headquarters IS NOT NULL
  UNION ALL
  SELECT id, 'founded_year', founded_year, founded_year_source_url, founded_year_checked_at
  FROM vendors WHERE founded_year IS NOT NULL
) f ON f.vendor_id = v.id
WHERE v.promotion_status = 'promoted'
  AND v.owned_at IS NULL
  AND (f.source_url IS NULL OR lower(substr(f.source_url, 1, 7)) <> 'http://'
       AND lower(substr(f.source_url, 1, 8)) <> 'https://')
  AND NOT EXISTS (
    SELECT 1 FROM field_overrides fo
    WHERE fo.entity_type = 'vendor' AND fo.entity_id = v.id AND fo.field = f.fact
      AND fo.lifted_at IS NULL AND json(fo.value) = json_quote(f.value))
ORDER BY v.slug, f.fact;
