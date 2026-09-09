# `metrics_daily` re-backfill after the AECI-683 predicate change (AECI-688)

No script lives here. The run used the existing
[`ops:backfill-metrics-daily`](../../../apps/api/scripts/backfill-metrics-daily.ts); this
directory is the run log, following the convention of the two backfills beside it.

AECI-683 added a third clause to `NOT_INTERNAL` — a correlated `NOT EXISTS` excluding any
page view that shares a `(user_agent_hash, cf_asn)` pair with a verified operator row
inside 30 days. Every *future* `metrics_daily` write picked it up. Rows already written did
not, and `GET /api/admin/metrics/timeseries` serves snapshot-first for completed days, so
the human-traffic chart carried the old definition permanently until this ran.

## The order is fixed, and it is the whole reason this file exists

```
1. scripts/ops/backfill-page-view-bots.sql              (AECI-582 — is_bot)
2. scripts/ops/2026-08-operator-page-view-backfill/     (AECI-683 D13 — is_operator)
3. pnpm --filter @aeci/api ops:backfill-metrics-daily   (this run)
```

Step 3 aggregates whatever steps 1 and 2 left behind, and `metrics_daily` is retained
indefinitely, so running it early freezes a wrong answer rather than delaying a right one.
Step 1 is enforced — the script refuses a range containing `is_bot IS NULL` rows without
`--force`. **Step 2 is not enforced by anything.** Check it by hand before step 3:

```bash
scripts/ops/2026-08-operator-page-view-backfill/run.sh --env production
```

Every pair reporting `would_change: 0` means that tier is applied.

## What was run

```bash
pnpm --filter @aeci/api ops:backfill-metrics-daily -- --env production \
  --from 2026-06-23 --to 2026-09-08
pnpm --filter @aeci/api ops:backfill-metrics-daily -- --env production \
  --from 2026-06-23 --to 2026-09-08 --apply --allow-production
```

**Pass `--to` explicitly.** Omitted, it defaults to `max(day)` across `page_views`,
`audit_log`, `products` and `profiles` — which is *today* on any tier with traffic today.
That writes a partial UTC day into a table kept forever, and the 00:15 cron is queue-less,
so a missed run never corrects it.

## Result

| Tier | Range | `page_views_human` | `page_views_bot` | `unique_visitors` | Self-verify |
|---|---|---|---|---|---|
| production | 2026-06-23 → 2026-09-08 | 6 days, net **−51** | 2 days, −2 | 6 days, −6 | clean |
| staging | first-day → 2026-09-08 | 3 days, +10 (gap fill) | 4 days, +569 | 3 days, +8 | clean |
| demo | first-day → 2026-09-08 | 7 days, net −52 | 2 days, −2 | 7 days, −7 | clean |
| preview | 2026-06-23 → 2026-09-08 | 78 days, **+624 rows** (all gap fill) | — | — | clean |

Production, day by day:

| Day | Before | After |
|---|---|---|
| 2026-08-19 | 30 | 29 |
| 2026-08-20 | 95 | 94 |
| 2026-08-24 | 109 | 87 |
| 2026-08-25 | 80 | 77 |
| 2026-08-26 | 102 | 80 |
| 2026-08-31 | 224 | 222 |

`catalog.products_created` and `accounts.sign_ins_new` did not move on production — the
cron's audit-derived values already agreed with the `created_at` reconstruction, so the
side effect a full-range run risks did not materialise. Staging's figures are gap fills,
not corrections: it had days with no stored row at all.

**Preview could not be run here — done 2026-09-09 under AECI-828.** Its D1 was at migration
`0015` against a repo head of `0029`, so `page_views.is_operator` did not exist and every
statement in the predicate failed. That was the standing preview-migration gap, not a
property of this backfill. AECI-828 closed it: ledger repair, 12 migrations, both page-view
backfills, then this one. See `scripts/ops/2026-09-preview-d1-catchup/README.md`.

## Verifying it, then and later

The dry run reports every value it would change, per series and per day (added by
AECI-688). **A run that reports no change on all eight series is the verification** — it is
the mechanical form of "the chart has no step at the boundary", and it beats reading a
chart, because day-to-day traffic varies anyway.

Read the second block separately. Days printed under `stored day(s) NOT corrected by this
run` have no source rows left, so the series' `SELECT` skips them entirely: the aggregate
writes nothing and the zero-fill is `DO NOTHING`, and the stored value stays. The run
deliberately does not collapse them to zero, because §7.4 prunes raw `page_views` once
`metrics_daily` has captured the day — a zeroing run would erase the long memory for every
aged-out day. Such a day is corrected by hand or not at all, and it will keep appearing in
every dry run. The block was added after the 2026-09-09 runs, so re-check for it on the next
dry run rather than reading the tables above as evidence there are none.

```bash
pnpm --filter @aeci/api ops:backfill-metrics-daily -- --env production \
  --from 2026-06-23 --to <yesterday>
```

## It will go stale again — AECI-827

One of the six production days corrected, **2026-08-31, postdates the AECI-683 fix**. It
was snapshotted correctly and then went stale, because the retro-join is anchored on each
row's own timestamp: whether a view is internal depends on operator rows that may not exist
yet. Every completed day inside the trailing 30 days is provisional, and the 00:15 cron
never revisits it. The drift is small and self-limiting, but it does not converge on its
own and nothing detects it. Tracked in AECI-827.

## What this run deliberately did NOT do

Correct the historical duplicate `page_views` rows (AECI-743). The counts are `count(*)`
before and after. Deduplicating in the backfill alone would put a second definition of
"duplicate" in the tree and make reconstructed days disagree with every live surface —
the defect AECI-688 existed to remove, reintroduced at a different date. Purging has no
defensible keep-rule. The reasoning and the measured residual are in
`docs/ADMIN_PANEL_SPEC.md` §7.1; the read-only report is
`scripts/ops/2026-09-page-view-duplicates/find-duplicates.sql`.
