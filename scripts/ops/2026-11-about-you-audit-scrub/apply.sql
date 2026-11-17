-- AECI-1869: remove the six About-you answer values from profile.updated audit rows.
-- The Privacy Policy says About you answers are deleted with the account. Erasure keeps
-- audit rows, so the values must not be in them. Code since AECI-1869 never writes them.
-- The keys must match ABOUT_YOU_AUDIT_KEYS in apps/api/src/routes/account.ts.
-- Safe to run twice: the marker row needs at least one row to scrub, and the UPDATE
-- matches only rows that still hold a key.

-- 1. One system audit row recording the scrub and how many rows it changed.
INSERT INTO audit_log (id, actor_type, action, entity_type, entity_id, metadata, created_at)
SELECT
  lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
  'system', 'audit_log.about_you_scrubbed', 'audit_log', NULL,
  json_object('source', 'ops', 'issue', 'AECI-1869', 'script', 'scripts/ops/2026-11-about-you-audit-scrub/apply.sql', 'rows', n.c),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (
  SELECT count(*) AS c FROM audit_log
  WHERE action = 'profile.updated'
    AND (json_type(before_state, '$.company_type') IS NOT NULL OR json_type(before_state, '$.company_size') IS NOT NULL OR json_type(before_state, '$.primary_role') IS NOT NULL OR json_type(before_state, '$.firm_name') IS NOT NULL OR json_type(before_state, '$.linkedin_url') IS NOT NULL OR json_type(before_state, '$.audience_ids') IS NOT NULL
      OR json_type(after_state, '$.company_type') IS NOT NULL OR json_type(after_state, '$.company_size') IS NOT NULL OR json_type(after_state, '$.primary_role') IS NOT NULL OR json_type(after_state, '$.firm_name') IS NOT NULL OR json_type(after_state, '$.linkedin_url') IS NOT NULL OR json_type(after_state, '$.audience_ids') IS NOT NULL)
) AS n
WHERE n.c > 0;

-- 2. Remove the six keys. Other keys (display_name, listing_view_preference, onboarding) stay.
-- A state left as {} becomes NULL, matching what the code writes now.
UPDATE audit_log
SET
  before_state = nullif(json_remove(before_state, '$.company_type', '$.company_size', '$.primary_role', '$.firm_name', '$.linkedin_url', '$.audience_ids'), '{}'),
  after_state = nullif(json_remove(after_state, '$.company_type', '$.company_size', '$.primary_role', '$.firm_name', '$.linkedin_url', '$.audience_ids'), '{}'),
  metadata = json_set(coalesce(metadata, '{}'), '$.about_you_scrubbed', 'AECI-1869')
WHERE action = 'profile.updated'
  AND (json_type(before_state, '$.company_type') IS NOT NULL OR json_type(before_state, '$.company_size') IS NOT NULL OR json_type(before_state, '$.primary_role') IS NOT NULL OR json_type(before_state, '$.firm_name') IS NOT NULL OR json_type(before_state, '$.linkedin_url') IS NOT NULL OR json_type(before_state, '$.audience_ids') IS NOT NULL
    OR json_type(after_state, '$.company_type') IS NOT NULL OR json_type(after_state, '$.company_size') IS NOT NULL OR json_type(after_state, '$.primary_role') IS NOT NULL OR json_type(after_state, '$.firm_name') IS NOT NULL OR json_type(after_state, '$.linkedin_url') IS NOT NULL OR json_type(after_state, '$.audience_ids') IS NOT NULL);
