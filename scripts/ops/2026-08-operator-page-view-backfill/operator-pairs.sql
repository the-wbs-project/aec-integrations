-- The operator cohort: `(user_agent_hash, cf_asn)` VISITOR PAIRS, not either alone.
-- `ADMIN_PANEL_SPEC.md` §13 D13. Single source of truth — `run.sh` parses this file,
-- so the projection, the write, and the rollback can never disagree about the cohort.
--
-- ─── Why a PAIR, and not the obvious simpler rules ──────────────────────────────
--
-- Measured against production on 2026-08-19 (2,494 human public-page views all-time):
--
--   "Everything from Indonesia"   flags 333 rows. Only 185 are the operator — 148 are
--                                 NOT (44% false positives, 25 distinct browsers), and
--                                 it MISSES the 183 views from the operator's US period
--                                 (Jun 23 → Jul 30, before they moved). Wrong in both
--                                 directions. This is the same objection D13 already
--                                 recorded against ANALYTICS_INTERNAL_ASNS.
--
--   "The operator's UA hash"      Works for hash 365d59… (6 network/country pairs, all
--                                 explainable as one person: two home ISPs plus VPN
--                                 exits). It does NOT work for d37ac4d2…, which spans
--                                 6 ASNs across 5 COUNTRIES — a shared browser build,
--                                 not a device. Flagging that hash outright would
--                                 delete real visitors in four countries.
--
--   "(ua_hash, cf_asn)"           Correct for both. It is also, deliberately, the exact
--                                 tuple §9.8 already calls a "visitor", so this backfill
--                                 flags operator VISITORS in the same terms the panel
--                                 counts everyone else.
--
-- ─── How each pair was established ─────────────────────────────────────────────
--
-- `proof` below counts rows the pair wrote on `/admin*` or `/account` — operator-only
-- surfaces no visitor reaches, so a single such row proves the pair is the operator.
-- Four of the six pairs carry direct proof. The two that do not are admitted on
-- evidence stated per row, and both are deliberately narrowed by ASN.
--
-- Counts are as of 2026-08-19 and are indicative; `run.sh --env … ` re-measures.

--            user_agent_hash                                                  asn      rows  proof
-- ---------------------------------------------------------------------------------------------------
-- 365d59e9…  operator's primary browser                                       23700 ID  190     5
-- 365d59e9…  same browser, previous US home ISP                               23089 US  176     1
-- 365d59e9…  same browser via Cloudflare WARP (all 112 already is_bot=1)      13335 US  112     3
-- 365d59e9…  same browser via WARP after the move (all 84 already is_bot=1)   13335 ID   84     0
-- 365d59e9…  same browser via a VPN exit (all 19 already is_bot=1)            212238 US  19     0
-- 365d59e9…  same browser, US, two-day window                                 23314 US    8     0
-- d37ac4d2…  operator's SECOND browser, home ISP only                         23700 ID   90     0
--
-- The two zero-proof 365d59… pairs (13335/ID, 212238/US) are the SAME browser hash as
-- three proven pairs, on VPN/WARP exits the bot classifier already flagged — they are
-- the operator's own traffic reaching us through a tunnel, and every one of those rows
-- is currently mislabelled as a datacenter crawler.
--
-- d37ac4d2… on 23700 is admitted on four independent signals: it appeared on the
-- operator's exact home ISP the day AFTER their primary hash last wrote there (Aug 18),
-- 90 views over 2 days against a site averaging ~40 human views/day, browsing the
-- catalog the way an operator checks work (28 `/products` SPA hops, product-pair pages,
-- a spread of individual products), and the hash's own history starts 2026-08-04 —
-- consistent with a browser update rotating the fingerprint. Restricted to ASN 23700
-- precisely because the hash itself is shared: its other 11 rows, in four other
-- countries, are real visitors and are NOT flagged.

SELECT 1 WHERE 0; -- not executable; run.sh reads the PAIRS block below

-- PAIRS-BEGIN
--   ('<user_agent_hash>', <cf_asn>)
('365d59e9b0d62fad2f7a80ba5727b69d992e812c8acfc819ac36e33ca4f522bd', 23700),
('365d59e9b0d62fad2f7a80ba5727b69d992e812c8acfc819ac36e33ca4f522bd', 23089),
('365d59e9b0d62fad2f7a80ba5727b69d992e812c8acfc819ac36e33ca4f522bd', 13335),
('365d59e9b0d62fad2f7a80ba5727b69d992e812c8acfc819ac36e33ca4f522bd', 212238),
('365d59e9b0d62fad2f7a80ba5727b69d992e812c8acfc819ac36e33ca4f522bd', 23314),
('d37ac4d248088c642487523ab0069fc279dfd865d6e23d3a430fdb98f5e8cb9f', 23700)
-- PAIRS-END

-- ─── Deliberately NOT included ─────────────────────────────────────────────────
--
-- Two candidates on the operator's home ISP were examined and rejected, because the
-- point of this backfill is precision and neither can be told apart from a visitor:
--
--   0fc305b8…  on 23700 — 11 views inside one hour on 2026-08-17, one ASN, one country.
--              Could be the operator on a phone; could equally be a real Indonesian
--              visitor reading for an hour. No proof row, no distinguishing behaviour.
--
--   545ea538…  on 23700 — 7 views inside ONE SECOND on 2026-08-14. Not human browsing
--              at all; a prefetch or a script. Excluding it would be defensible, but it
--              belongs to the bot classifier (§13 D10 constraint 1 keeps that verdict
--              out of this file), not to the operator flag.
--
-- Leaving them counted keeps the human figure an upper bound, which is the direction
-- this project's honesty rules already prefer.
