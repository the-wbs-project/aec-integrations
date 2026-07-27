-- One-time backfill of page_views.is_bot / bot_name for rows captured before the
-- traffic classifier existed (AECI-526 follow-up).
--
-- The raw User-Agent was discarded at capture (only its SHA-256 hash persists), so
-- historical rows can only be classified by Cloudflare ASN. This CASE mirrors
-- DATACENTER_ASNS in apps/api/src/lib/bot-classification.ts — KEEP THE TWO IN SYNC.
-- Named crawlers (Googlebot / Bingbot / Applebot …) cannot be recovered for old rows
-- because that name comes from the UA, so datacenter ASNs get an org label instead.
--
-- Not strictly required: unclassified rows (is_bot IS NULL) already read as human in
-- the digest, so skipping this only means old bot rows count as human on a re-run of a
-- historical day. Running it makes past days accurate too.
--
-- Run once per environment AFTER migration 0007 is applied, e.g.:
--   pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production \
--     --env production --remote --file=../../scripts/ops/backfill-page-view-bots.sql
-- Idempotent: only touches rows where is_bot IS NULL.

UPDATE page_views
SET is_bot = 1,
    bot_name = CASE cf_asn
      WHEN 16509 THEN 'Datacenter (AWS)'
      WHEN 14618 THEN 'Datacenter (AWS)'
      WHEN 15169 THEN 'Datacenter (Google)'
      WHEN 396982 THEN 'Datacenter (Google Cloud)'
      WHEN 19527 THEN 'Datacenter (Google)'
      WHEN 8075 THEN 'Datacenter (Microsoft)'
      WHEN 8068 THEN 'Datacenter (Microsoft)'
      WHEN 13335 THEN 'Datacenter (Cloudflare)'
      WHEN 14061 THEN 'Datacenter (DigitalOcean)'
      WHEN 16276 THEN 'Datacenter (OVH)'
      WHEN 24940 THEN 'Datacenter (Hetzner)'
      WHEN 45102 THEN 'Datacenter (Alibaba)'
      WHEN 37963 THEN 'Datacenter (Alibaba)'
      WHEN 24429 THEN 'Datacenter (Alibaba)'
      WHEN 132203 THEN 'Datacenter (Tencent)'
      WHEN 45090 THEN 'Datacenter (Tencent)'
      WHEN 9009 THEN 'Datacenter (M247)'
      WHEN 20473 THEN 'Datacenter (Vultr)'
      WHEN 63949 THEN 'Datacenter (Akamai/Linode)'
      WHEN 31898 THEN 'Datacenter (Oracle Cloud)'
      WHEN 12876 THEN 'Datacenter (Scaleway)'
      WHEN 398324 THEN 'Censys (scanner)'
      WHEN 202425 THEN 'Datacenter (IP Volume)'
      WHEN 46261 THEN 'Datacenter (QuadraNet)'
      WHEN 18779 THEN 'Datacenter (EGIHosting)'
    END
WHERE is_bot IS NULL
  AND cf_asn IN (
    16509, 14618, 15169, 396982, 19527, 8075, 8068, 13335, 14061, 16276,
    24940, 45102, 37963, 24429, 132203, 45090, 9009, 20473, 63949, 31898,
    12876, 398324, 202425, 46261, 18779
  );

-- Everything still unclassified (residential/unknown ASN, or null ASN) is human.
UPDATE page_views SET is_bot = 0 WHERE is_bot IS NULL;
