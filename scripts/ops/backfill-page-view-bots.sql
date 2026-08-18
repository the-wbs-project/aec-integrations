-- One-time backfill of page_views.is_bot / bot_name for rows captured before the
-- traffic classifier existed (AECI-526 follow-up).
--
-- The raw User-Agent was discarded at capture (only its SHA-256 hash persists), so
-- this file classifies historical rows by Cloudflare ASN. The CASE mirrors
-- DATACENTER_ASNS in apps/api/src/lib/bot-classification.ts — KEEP THE TWO IN SYNC;
-- `bot-classification.spec.ts` parses this file and fails CI if they diverge.
-- Named crawlers (Googlebot / Bingbot / Applebot …) get an org label here instead of
-- their own name, because that name comes from the UA. AECI-582 recovers many of them
-- anyway, by hashing: see scripts/ops/2026-08-page-view-bot-backfill/recover-ua-names.sql,
-- which runs BEFORE this file and claims those rows first.
--
-- Run it: unclassified rows read as HUMAN in the digest, so until this runs, every
-- historical day and every day-over-day delta over-counts humans. As of 2026-08-04 prod
-- held 17,784 such rows (2026-06-23 → 2026-08-03), the majority of them datacenter
-- crawls. Re-run it after every widening of DATACENTER_ASNS — but note it only reaches
-- rows that are still null, so ASNs promoted to bot AFTER a run stay marked human
-- (fix those with a targeted UPDATE … SET is_bot = 1 … for the newly listed ASNs).
--
-- Run once per environment AFTER migration 0007 is applied. Prefer the AECI-582 runner,
-- which dry-runs, backs up and verifies around both files:
--   scripts/ops/2026-08-page-view-bot-backfill/run.sh --env production --apply --allow-production
-- Idempotent: a second run matches no rows.
--
-- RUN LOG — first run on every tier was 2026-08-13 (AECI-582), via that runner:
--   preview 646 rows / staging 660 / demo 19,557 / production 26,671.
--   Production: 17,784 unclassified → 24,575 bot + 2,096 human; "reads as human"
--   fell 18,322 → 2,096. Recorded in docs/POST_LAUNCH_HEALTH_REPORT.md (2026-08-13).

UPDATE page_views
SET is_bot = 1,
    bot_name = CASE cf_asn
      WHEN 16509 THEN 'Datacenter (AWS)'
      WHEN 14618 THEN 'Datacenter (AWS)'
      WHEN 7224 THEN 'Datacenter (AWS)'
      WHEN 8987 THEN 'Datacenter (AWS)'
      WHEN 15169 THEN 'Datacenter (Google)'
      WHEN 19527 THEN 'Datacenter (Google)'
      WHEN 396982 THEN 'Datacenter (Google Cloud)'
      WHEN 139070 THEN 'Datacenter (Google Cloud)'
      WHEN 8075 THEN 'Datacenter (Microsoft)'
      WHEN 8068 THEN 'Datacenter (Microsoft)'
      WHEN 8069 THEN 'Datacenter (Microsoft)'
      WHEN 12076 THEN 'Datacenter (Microsoft)'
      WHEN 13335 THEN 'Datacenter (Cloudflare)'
      WHEN 31898 THEN 'Datacenter (Oracle Cloud)'
      WHEN 36351 THEN 'Datacenter (IBM Cloud)'
      WHEN 45102 THEN 'Datacenter (Alibaba)'
      WHEN 37963 THEN 'Datacenter (Alibaba)'
      WHEN 24429 THEN 'Datacenter (Alibaba)'
      WHEN 132203 THEN 'Datacenter (Tencent)'
      WHEN 45090 THEN 'Datacenter (Tencent)'
      WHEN 133478 THEN 'Datacenter (Tencent)'
      WHEN 55990 THEN 'Datacenter (Huawei Cloud)'
      WHEN 136907 THEN 'Datacenter (Huawei Cloud)'
      WHEN 20940 THEN 'Datacenter (Akamai)'
      WHEN 63949 THEN 'Datacenter (Akamai/Linode)'
      WHEN 54113 THEN 'Datacenter (Fastly)'
      WHEN 60068 THEN 'Datacenter (CDN77/DataCamp)'
      WHEN 212238 THEN 'Datacenter (CDN77/DataCamp)'
      WHEN 202422 THEN 'Datacenter (G-Core)'
      WHEN 16276 THEN 'Datacenter (OVH)'
      WHEN 24940 THEN 'Datacenter (Hetzner)'
      WHEN 213230 THEN 'Datacenter (Hetzner)'
      WHEN 212317 THEN 'Datacenter (Hetzner)'
      WHEN 14061 THEN 'Datacenter (DigitalOcean)'
      WHEN 20473 THEN 'Datacenter (Vultr)'
      WHEN 12876 THEN 'Datacenter (Scaleway)'
      WHEN 51167 THEN 'Datacenter (Contabo)'
      WHEN 197540 THEN 'Datacenter (netcup)'
      WHEN 214996 THEN 'Datacenter (netcup)'
      WHEN 8560 THEN 'Datacenter (IONOS)'
      WHEN 47583 THEN 'Datacenter (Hostinger)'
      WHEN 19318 THEN 'Datacenter (InterServer)'
      WHEN 22612 THEN 'Datacenter (Namecheap)'
      WHEN 26496 THEN 'Datacenter (GoDaddy)'
      WHEN 60781 THEN 'Datacenter (Leaseweb)'
      WHEN 16265 THEN 'Datacenter (Leaseweb)'
      WHEN 30633 THEN 'Datacenter (Leaseweb)'
      WHEN 395954 THEN 'Datacenter (Leaseweb)'
      WHEN 49981 THEN 'Datacenter (WorldStream)'
      WHEN 9009 THEN 'Datacenter (M247)'
      WHEN 62610 THEN 'Datacenter (Zenlayer)'
      WHEN 21859 THEN 'Datacenter (Zenlayer)'
      WHEN 36352 THEN 'Datacenter (ColoCrossing)'
      WHEN 47007 THEN 'Datacenter (Colocation America)'
      WHEN 46261 THEN 'Datacenter (QuickPacket)'
      WHEN 8100 THEN 'Datacenter (QuadraNet)'
      WHEN 18779 THEN 'Datacenter (EGIHosting)'
      WHEN 202425 THEN 'Datacenter (IP Volume)'
      WHEN 46475 THEN 'Datacenter (Limestone Networks)'
      WHEN 26548 THEN 'Datacenter (PureVoltage)'
      WHEN 42708 THEN 'Datacenter (Glesys)'
      WHEN 39351 THEN 'Datacenter (31173 Services)'
      WHEN 51747 THEN 'Datacenter (Internet Vikings)'
      WHEN 204770 THEN 'Datacenter (Cherry Servers)'
      WHEN 60404 THEN 'Datacenter (Liteserver)'
      WHEN 34343 THEN 'Datacenter (Eweka)'
      WHEN 14956 THEN 'Datacenter (RouterHosting)'
      WHEN 64286 THEN 'Datacenter (LogicWeb)'
      WHEN 203020 THEN 'Datacenter (HostRoyale)'
      WHEN 207990 THEN 'Datacenter (HostRoyale)'
      WHEN 200373 THEN 'Datacenter (3xK Tech)'
      WHEN 47890 THEN 'Datacenter (Unmanaged Ltd)'
      WHEN 51852 THEN 'Datacenter (Private Layer)'
      WHEN 51396 THEN 'Datacenter (pfcloud)'
      WHEN 210644 THEN 'Datacenter (Aeza)'
      WHEN 57523 THEN 'Datacenter (Chang Way)'
      WHEN 142430 THEN 'Datacenter (DIGI VPS)'
      WHEN 150303 THEN 'Datacenter (SoloRDP)'
      WHEN 48090 THEN 'Datacenter (DMZHost)'
      WHEN 213790 THEN 'Datacenter (Limited Network)'
      WHEN 211590 THEN 'Datacenter (Bucklog)'
      WHEN 219502 THEN 'Datacenter (Storm Industries)'
      WHEN 213250 THEN 'Datacenter (ITP-Solutions)'
      WHEN 211693 THEN 'Datacenter (NolimitCloud)'
      WHEN 203919 THEN 'Datacenter (LumaDock)'
      WHEN 203363 THEN 'Datacenter (Kuroit)'
      WHEN 43180 THEN 'Datacenter (Trunk Networks)'
      WHEN 202412 THEN 'Datacenter (Omegatech)'
      WHEN 197769 THEN 'Datacenter (VPS Dedicated)'
      WHEN 62240 THEN 'Datacenter (Clouvider)'
      WHEN 62164 THEN 'Datacenter (Heymman)'
      WHEN 137409 THEN 'Datacenter (GSL Networks)'
      WHEN 135377 THEN 'Datacenter (UCloud HK)'
      WHEN 206804 THEN 'Datacenter (EstNOC)'
      WHEN 50245 THEN 'Datacenter (Serverel)'
      WHEN 22295 THEN 'Datacenter (Advin Services)'
      WHEN 197170 THEN 'Datacenter (TechTies)'
      WHEN 400529 THEN 'Datacenter (Infraly)'
      WHEN 399629 THEN 'Datacenter (BL Networks)'
      WHEN 205759 THEN 'Datacenter (Ghosty Networks)'
      WHEN 141039 THEN 'Datacenter (PacketHub)'
      WHEN 136787 THEN 'Datacenter (PacketHub)'
      WHEN 53514 THEN 'Datacenter (UHQ Services)'
      WHEN 398324 THEN 'Censys (scanner)'
      WHEN 398722 THEN 'Censys (scanner)'
      WHEN 213412 THEN 'ONYPHE (scanner)'
      WHEN 211298 THEN 'Driftnet (scanner)'
      WHEN 40793 THEN 'LinkedIn (link preview)'
      WHEN 62041 THEN 'Telegram (link preview)'
    END
WHERE is_bot IS NULL
  AND cf_asn IN (
    16509, 14618, 7224, 8987, 15169, 19527, 396982, 139070, 8075, 8068, 8069, 12076, 13335,
    31898, 36351, 45102, 37963, 24429, 132203, 45090, 133478, 55990, 136907, 20940, 63949,
    54113, 60068, 212238, 202422, 16276, 24940, 213230, 212317, 14061, 20473, 12876, 51167,
    197540, 214996, 8560, 47583, 19318, 22612, 26496, 60781, 16265, 30633, 395954, 49981, 9009,
    62610, 21859, 36352, 47007, 46261, 8100, 18779, 202425, 46475, 26548, 42708, 39351, 51747,
    204770, 60404, 34343, 14956, 64286, 203020, 207990, 200373, 47890, 51852, 51396, 210644,
    57523, 142430, 150303, 48090, 213790, 211590, 219502, 213250, 211693, 203919, 203363, 43180,
    202412, 197769, 62240, 62164, 137409, 135377, 206804, 50245, 22295, 197170, 400529, 399629,
    205759, 141039, 136787, 53514, 398324, 398722, 213412, 211298, 40793, 62041
  );

-- Everything still unclassified (residential/unknown ASN, or null ASN) is human.
UPDATE page_views SET is_bot = 0 WHERE is_bot IS NULL;
