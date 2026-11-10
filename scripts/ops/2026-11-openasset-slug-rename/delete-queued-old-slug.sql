-- AECI-1574 — drop discovery-queue URLs that still name the old `openasset-connector` slug.
-- They were queued before the redirect existed, and they now only 301. Chris ruled to delete
-- them on 2026-11-10. The promote in README step 5 had already queued every new-slug URL.
-- Queue rows are log-class buffers, not domain state, so no audit row (ADR 0022).
-- The match is on the whole path segment, so no other slug can be caught. It uses substr,
-- not LIKE, because D1 rejects these LIKE patterns as too complex.

DELETE FROM gsc_recrawl_queue
WHERE url = 'https://www.aecintegrations.com/products/openasset-connector'
   OR substr(url, 1, 74) = 'https://www.aecintegrations.com/products/openasset-connector/integrations/'
   OR (substr(url, 1, 41) = 'https://www.aecintegrations.com/products/'
       AND substr(url, -33) = '/integrations/openasset-connector');

DELETE FROM indexnow_queue
WHERE url = 'https://www.aecintegrations.com/products/openasset-connector'
   OR substr(url, 1, 74) = 'https://www.aecintegrations.com/products/openasset-connector/integrations/'
   OR (substr(url, 1, 41) = 'https://www.aecintegrations.com/products/'
       AND substr(url, -33) = '/integrations/openasset-connector');
