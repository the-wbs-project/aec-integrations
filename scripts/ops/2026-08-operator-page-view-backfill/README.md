# Operator page-view backfill (§13 D13)

Retroactively sets `page_views.is_operator = 1` on rows written before D13 shipped, for
the subset of historical traffic that can be identified as the operator after the fact.

D13 states that the live flag is **not** retroactive — nothing stored on an older row
implies a session — and that this leaves a step down in every traffic figure at the ship
date. This script narrows that step. It does not eliminate it, and the numbers below say
by how much.

```bash
# look, change nothing
scripts/ops/2026-08-operator-page-view-backfill/run.sh --env production

# write
scripts/ops/2026-08-operator-page-view-backfill/run.sh --env production --apply --allow-production

# take it back
scripts/ops/2026-08-operator-page-view-backfill/run.sh --env production --rollback --apply --allow-production
```

## The rule, and the two simpler ones it replaces

The cohort is a list of **`(user_agent_hash, cf_asn)` visitor pairs** in
[`operator-pairs.sql`](./operator-pairs.sql), which also records the evidence for each
pair. Both simpler rules were measured against production on 2026-08-19 and rejected:

| Rule | Flags | Actually the operator | Misses | Verdict |
|---|---|---|---|---|
| `cf_country = 'ID'` | 333 | 185 | 183 | **44% false positives, 50% recall** |
| `user_agent_hash = '365d59…'` | 368 | 368 | 90+ | Safe for *this* hash, unsafe as a method |
| `(user_agent_hash, cf_asn)` pairs | 679 | 679 | some | Shipped |

**Why not Indonesia.** It is wrong in both directions at once. Indonesian traffic carries
25 distinct browsers, only one of which is the operator's — so 148 of the 333 rows are
other people. And the operator only moved there on 2026-08-03: the 183 views from their
US period (AS23089, Jun 23 → Jul 30) are not in Indonesia at all. This is the same
objection D13 already recorded against `ANALYTICS_INTERNAL_ASNS`, and it does not improve
by swapping an ASN for a country — a country is just a coarser network.

**Why not a bare UA hash.** It happens to be safe for `365d59…`, whose six
network/country pairs are all explainable as one person (two home ISPs plus VPN exits).
It is *not* safe as a method: the operator's second browser, `d37ac4d2…`, spans **6 ASNs
across 5 countries**, because a UA hash is a browser *build* shared by strangers.
Flagging that hash outright would have deleted real visitors in four countries.

**Why the pair works.** It is precise in both directions, and it is deliberately the
exact tuple `ADMIN_PANEL_SPEC.md` §9.8 already calls a "visitor" — so this flags operator
*visitors* in the same terms the panel counts everyone else.

## How the pairs were found

`page_views` still contains rows for `/admin*` and `/account` — operator-only surfaces no
visitor reaches — so any `(ua_hash, asn)` pair appearing on one is **proven** to be the
operator. Four of the six pairs carry that proof directly. The remaining two are the same
browser hash as a proven pair reaching us through a VPN, and a second browser admitted on
stated behavioural evidence and narrowed to the operator's home ISP. Per-pair reasoning
is in `operator-pairs.sql`; `run.sh` prints a `proof_rows` column per pair so a reviewer
can check each one rather than trusting a total.

## What it is careful about

- **Only `is_operator`, only from NULL.** Never touches `is_bot` — §13 D10 constraint 1
  keeps network-shaped verdicts out of that column, and the same reasoning applies here.
  Never deletes. Never overwrites a value the live ingest decided.
- **Exactly invertible.** Because it only writes over NULL, `--rollback` is a true
  inverse rather than a best effort. That is why this backfill needs no `page_views`
  export, unlike the AECI-582 bot backfill, whose second statement destroyed the
  "never classified" signal.
- **Idempotent.** A second run changes nothing.
- **One source of truth.** `run.sh` parses the cohort out of `operator-pairs.sql`, so the
  projection, the write, and the rollback cannot disagree about who the operator is.

## Two things it does not do

1. **It does not recompute `metrics_daily`.** That table is the long memory the panel
   prefers over live aggregation for completed days, so the Traffic screen keeps showing
   pre-backfill counts until you re-run `ops:backfill-metrics-daily` over the range. The
   script prints the command. Safe to re-run — the traffic series is written as
   `measured`, and §7.1's precedence rule is that a measured write always wins.

2. **It does not make the history exact.** Two candidates on the operator's home ISP were
   examined and deliberately left counted (an 11-view hour and a 7-views-in-one-second
   burst) because neither can be distinguished from a visitor, and a browser the operator
   used only on public pages before 2026-08-03 would leave no proof row at all. The human
   figure stays an **upper bound**; it is simply a much tighter one.

## Result

Applied to production it flags roughly **679 rows**, of which **~458 are in the human
public-page population** — taking all-time human page views from **2,494 to ~2,036**, a
**~18% correction**. The rest are rows already classified as datacenter crawls
(the operator's own WARP/VPN traffic, currently mislabelled as bots) which stop being
counted as crawler activity.

## Run log

Added 2026-09-09 by AECI-688, which needed to know whether this had run and could not
tell. `ADMIN_PANEL_SPEC.md` §7.3 read **PENDING** for three weeks after production was
already done. The dry run answers it in one command — every pair reports
`would_change: 0` on a tier that is applied — but a table costs nothing and a wrong
status cost an ordering decision.

| Tier | Applied | Rows written | Verified by |
|---|---|---|---|
| production | on or before 2026-09-09 (exact date unrecorded) | 679 per §7.3 | dry run 2026-09-09: 10 pairs, `would_change: 0` |
| demo | on or before 2026-09-09 (exact date unrecorded) | — | dry run 2026-09-09: 10 pairs, `would_change: 0` |
| staging | **2026-09-09** (AECI-688) | **81** | re-run dry: `would_change: 0` |
| preview | **2026-09-09** (AECI-828) | **51** | 2 ASNs matched; human-public 125 → 93. Blocked until then — its D1 sat at migration `0015`, so `is_operator` did not exist. See `scripts/ops/2026-09-preview-d1-catchup/README.md` |

Record the date and the row count here when you apply it. `--rollback` is a true inverse,
so an entry that turns out wrong is recoverable; an absent entry is not.
