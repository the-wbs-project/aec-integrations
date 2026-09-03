-- READ-ONLY report of historical `page_views` double-fires (AECI-743).
--
-- Nothing here writes. The write-side guard (migration 0020: `dedupe_key` + a UNIQUE
-- index, plus the ingest probe in apps/api/src/routes/page-views.ts) only protects rows
-- written from that deploy onward — rows already in the table cannot be repaired, since
-- the double-fire is indistinguishable in the stored row from two genuine arrivals.
-- Deleting them was considered and deliberately rejected: D1 Time Travel recovers only
-- ~30 days, and `metrics_daily` has already snapshotted the affected days, so a delete
-- would leave the aggregate and the log disagreeing with no way back. This file exists
-- so any figure quoted from a pre-fix day can be corrected by hand instead.
--
-- Run it:
--   wrangler d1 execute aeci-app-production --env production --remote \
--     --file=scripts/ops/2026-09-page-view-duplicates/find-duplicates.sql
--
-- CAVEAT ON `--file`: wrangler runs a file as an IMPORT and prints only a summary
-- ("Processed 3 queries"), never the result rows — so use it to confirm the queries
-- parse, then re-run whichever section you want to READ with `--command "..." --json`.
-- (`changed_db: true` in that summary is wrangler's own bookkeeping; `rows_written` is
-- 0, which is the number that matters here.)
--
-- Read `--remote` results with the same three exclusions the digest applies
-- (`NOT_INTERNAL`, docs/DATABASE_SCHEMA.md §9.1) if you want digest-matching numbers.
-- The queries below deliberately do NOT apply them: this is an ingest-integrity audit,
-- and an operator's own double-fire is still a double-fire.
--
-- The window is PAGE_VIEW_DEDUPE_WINDOW_MS (@aeci/shared) = 10 s, doubled to 20 s to
-- match the ingest guard's effective reach (it probes the current AND previous bucket).
-- Keep the two numbers in step if that constant ever moves.
--
-- BASELINE — measured against production on 2026-09-01, before the fix shipped.
-- Suspected duplicates inside the 20 s effective window, by class:
--   human  arrival 52 · spa 23 · navigation null 589
--   bot    arrival 730 · spa 4 · navigation null 13,781
-- (`navigation` is null on every row written before AECI-585, so those cannot be
-- attributed to a writer; read them as "unclassifiable", not as arrivals.)
-- Tightening the window to 3 s cuts the human arrival figure to 19 — worth knowing
-- before quoting either number, since the gap is reloads, not a different defect.
--
-- Corroborated-floor impact (query 3), the reason this issue was filed:
--   2026-08-29  as counted 2 → corrected 1   ← the named incident
--   2026-08-18  as counted 4 → corrected 3
-- No other day in the table is affected.
--   The named incident: ids 38956 / 38957, `/products/leap-crm`, 83 ms apart, both
--   `navigation = 'arrival'` with `path = '/products/:slug'` — i.e. two full SSR
--   cache-MISS renders, NOT an SSR + client double-write. Those two rows were the whole
--   "Google — 2 views" traffic-source table and the entire corroborated-referrer
--   population of the 2026-08-29 digest.

-- ── 1. Summary: how many suspected double-fires, by class ───────────────────────
with paired as (
  select
    id,
    is_bot,
    navigation,
    created_at,
    lag(created_at) over (
      partition by user_agent_hash, concrete_path
      order by created_at
    ) as prev_at
  from page_views
  -- A null hash cannot identify a visitor, so a "pair" on it is not evidence of
  -- anything (the same NULL-safety reasoning NOT_INTERNAL's `not exists` is built on).
  where user_agent_hash is not null
)
select
  case when is_bot = 1 then 'bot' else 'human' end as class,
  navigation,
  count(*) as suspected_duplicate_rows
from paired
where prev_at is not null
  and (julianday(created_at) - julianday(prev_at)) * 86400.0 < 20.0
group by 1, 2
order by suspected_duplicate_rows desc;

-- ── 2. The human rows themselves, newest first ─────────────────────────────────
-- One row per SECOND-of-pair. `first_branch` / `second_branch` read the cache branch
-- off `path`: a route PATTERN (`/products/:slug`) means the SSR resolver ran, i.e. a
-- cache MISS; a concrete path means the runtime synthesized the payload on a HIT.
-- MISS→MISS is the signature of two document requests racing before the first render
-- reached the edge cache.
with paired as (
  select
    id,
    concrete_path,
    path,
    navigation,
    referrer_source,
    cf_asn,
    cf_colo,
    client_verdict,
    created_at,
    lag(created_at) over w as prev_at,
    lag(id) over w as prev_id,
    lag(path) over w as prev_path
  from page_views
  where user_agent_hash is not null
    and (is_bot is null or is_bot = 0)
  window w as (partition by user_agent_hash, concrete_path order by created_at)
)
select
  prev_id || ' + ' || id as row_pair,
  concrete_path,
  navigation,
  case when prev_path like '%:%' then 'MISS' else 'HIT' end as first_branch,
  case when path like '%:%' then 'MISS' else 'HIT' end as second_branch,
  referrer_source,
  cf_asn,
  cf_colo,
  client_verdict,
  prev_at as first_at,
  created_at as second_at,
  round((julianday(created_at) - julianday(prev_at)) * 86400.0, 3) as gap_seconds
from paired
where prev_at is not null
  and (julianday(created_at) - julianday(prev_at)) * 86400.0 < 20.0
order by created_at desc;

-- ── 3. Corroborated-floor impact, per day ──────────────────────────────────────
-- The floor (AECI-683) counts human rows whose `referrer_source` is a NAMED external
-- referrer — the one figure a rotating-proxy pool cannot inflate, which is exactly why
-- a double-fire inside it matters more than its size. `as_counted` is what that day's
-- digest printed; `corrected` is what it should have said.
with paired as (
  select
    substr(created_at, 1, 10) as day,
    referrer_source,
    created_at,
    lag(created_at) over (
      partition by user_agent_hash, concrete_path
      order by created_at
    ) as prev_at
  from page_views
  where user_agent_hash is not null
    and (is_bot is null or is_bot = 0)
    -- Mirrors NAMED_REFERRER_SOURCES in apps/api/src/lib/referrer-classification.ts.
    -- Deliberately an IN-list, not `!= 'Direct'`: `Other` is an open bucket a forger
    -- controls and `Direct` swallows every stripped referral.
    and referrer_source in (
      'Google', 'Bing', 'DuckDuckGo', 'Yahoo', 'Ecosia', 'Brave Search', 'Yandex', 'Baidu',
      'LinkedIn', 'Twitter/X', 'Facebook', 'Instagram', 'YouTube', 'Reddit',
      'Hacker News', 'GitHub', 'Telegram', 'Bluesky'
    )
)
select
  day,
  count(*) as as_counted,
  sum(
    case
      when prev_at is not null
       and (julianday(created_at) - julianday(prev_at)) * 86400.0 < 20.0
      then 0 else 1
    end
  ) as corrected
from paired
group by day
having as_counted <> corrected
order by day desc;
