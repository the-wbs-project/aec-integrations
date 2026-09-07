-- AECI-685 / AECI-792 rollback for `apply.sql`.
--
-- Restores the `vendors` row verbatim from `vendor-row.json` and re-points the two
-- integrations back. Run as ONE `wrangler d1 execute --remote --file`.
--
-- WHAT THIS CANNOT RESTORE: `page_views.vendor_id` for the ~31 rows nulled by step 2.
-- That attribution is gone permanently. It is log-class (ADR 0022) and was accepted as
-- unrecoverable when the plan was written — do not treat its absence as a failed
-- rollback.
--
-- Note the INSERT restores `updated_at` verbatim (2026-08-25) rather than bumping it:
-- the 08:00 UTC incremental Algolia sync is watermarked on `updated_at`, so a bumped
-- value would silently re-index the vendor into `production_vendors` and undo step 3
-- of the runbook. If you WANT it back in search, re-add it deliberately.

INSERT INTO vendors (
  id, slug, company_name, description, website, headquarters, founded_year,
  public_private, parent_company, linkedin_url, x_url, facebook_url, instagram_url,
  youtube_url, crunchbase_url, wiki_url, source_url, github_org, phone_number,
  contact_email, logo_url, verified, promotion_status, admin_notes,
  vqs_credibility, vqs_momentum, vqs_fit, vqs_total, vqs_computed_at,
  created_at, updated_at, last_reviewed_at, maintained_by
) VALUES (
  'b52e0001-8b9e-40c5-87fc-953c2e0dd843',
  'bluebeam',
  'Bluebeam',
  'Bluebeam Software develops tools and enhancements to paperless workflows that leverage the PDF format.',
  'https://www.bluebeam.com',
  'Pasadena, CA',
  2002,
  'private',
  'Nemetschek Group',
  'https://www.linkedin.com/company/bluebeam-software',
  'https://x.com/bluebeam',
  'https://www.facebook.com/bluebeam/',
  'https://www.instagram.com/bluebeam_inc/',
  'https://www.youtube.com/@bluebeaminc',
  'https://www.crunchbase.com/organization/bluebeam-software',
  'https://en.wikipedia.org/wiki/Bluebeam_Software%2C_Inc.',
  NULL,
  'Bluebeam',
  '626.788.4100',
  'partners@bluebeam.com',
  'https://cdn.brandfetch.io/bluebeam.com/fallback/lettermark/icon?c=1idIE-oh6Ya7Cjvu5d7',
  0,
  'promoted',
  NULL,
  NULL, NULL, NULL, NULL, NULL,
  '2026-06-26T18:19:20.074Z',
  '2026-08-25T10:54:32.590Z',
  NULL,
  'aeci'
);

UPDATE integrations
   SET built_by_vendor_id = 'b52e0001-8b9e-40c5-87fc-953c2e0dd843'
 WHERE id IN (
   '322ba420-f306-4948-9195-b979eebafba2',
   '6c0cbee8-5d54-4244-bf59-11b88e09ccd0'
 );

INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, metadata, created_at)
VALUES (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
  substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2) ||
  '-' || lower(hex(randomblob(6))),
  'admin',
  'vendor.retraction_rolled_back',
  'vendor',
  'b52e0001-8b9e-40c5-87fc-953c2e0dd843',
  json_object(
    'issue', 'AECI-685',
    'execution_issue', 'AECI-792',
    'unrecoverable', 'page_views.vendor_id (~31 rows) stays NULL'
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')  -- REQUIRED — see the note in apply.sql
);
