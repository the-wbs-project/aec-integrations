# ADR 0026: A `metrics_daily` snapshot is corrected, not final

**Status:** Accepted
**Date:** 2026-09-09
**Context owner:** chrisw@thewbsproject.com
**Relates to:** AECI-827 (this record), AECI-683 (the retro-join that made a stored day mutable), AECI-688 (the one-off re-backfill that found it), AECI-745 (the snapshot-only filtered key), AECI-581 (`metrics_daily` itself). Build contract: `docs/ADMIN_PANEL_SPEC.md` §7.1 and §13 **D15**. Extends ADR 0022's carve-out with a second class of write; does not amend it.

---

## Context

`metrics_daily` was built on an assumption nobody wrote down because it was true when it
shipped: **the value of a completed day does not change.** The 00:15 cron captures the prior
complete UTC day, writes twenty keys, and never returns. §7.4 keeps the table forever.
`GET /api/admin/metrics/timeseries` serves it snapshot-first for every day it covers.

AECI-683 broke that assumption three months later, and did so invisibly. `NOT_INTERNAL`'s
third half excludes any page view sharing a `(user_agent_hash, cf_asn)` pair with a verified
operator row within `OPERATOR_PAIR_LOOKBACK_DAYS` (30). It is a correlated `EXISTS` anchored
on **each row's own timestamp**, and the window is symmetric — deliberately, because an
operator's session lapse can precede their first flagged row as easily as follow their last.

So whether a view counts as human depends on operator rows that **may not exist yet**. An
admin browses across a token expiry, writes a run of unflagged rows, re-authenticates hours or
days later, and the anchor that proves those rows were theirs lands after the day was already
snapshotted.

**Measured, on production, 2026-09-09.** The AECI-688 re-backfill moved six days of
`traffic.page_views_human`. Five predate the AECI-683 deploy and are the expected one-off
correction. One does not:

| Day | Stored | Recomputed |
|---|---|---|
| 2026-08-31 | 224 | 222 |

That day was snapshotted correctly under the new predicate and then went stale. It is not
legacy drift; it is the mechanism still running. Every completed day inside the trailing 30 is
provisional, the drift does not converge on its own, and nothing detected it — the only reason
we know is that a human ran a backfill for an unrelated reason and read its dry run.

Three constraints bound the fix:

- **`NOT_INTERNAL` stays static.** §13 D15's scope note keeps it a self-contained constant so
  all five read surfaces inherit it without threading a window through, and so it binds a fixed
  two parameters regardless of how many operator pairs exist. A `notInternalFor(window)`
  function would trade a correctness problem for a much worse one.
- **The stock metrics cannot be recomputed at all.** Eleven of the twenty producers ignore
  their `day` argument and count `COUNT(*)` as of now. Re-running the capture for an old day
  would stamp today's totals onto it.
- **`traffic.page_views_human_after_automation` has no repair tool.** It is snapshot-only
  (`metricIsSnapshotOnly`) and in `NOT_BACKFILLABLE`, because a generated SELECT reproducing
  `detectSwarms` would be a second definition of "flagged".

## Decision

**The 00:15 cron gains a second pass that re-checks the trailing retro-join window and corrects
the days that moved.** `metrics_daily` therefore carries two classes of write: a *capture*,
which is what a day looked like when it closed, and a *correction*, which is what it looks like
now that the evidence is in.

The window is `OPERATOR_PAIR_LOOKBACK_DAYS + 1 + SNAPSHOT_RECHECK_SLACK_DAYS` days back,
ending at `today - 2`. Its far edge is clamped to the `page_views` retention window.

Three things about this decision are not obvious from the code, and are the reason this is an
ADR rather than a paragraph:

### 1. A day is provably final at `day + 31`, which is what bounds the pass

An anchor at instant `T` reaches views in `[T-30d, T+30d]`, and anchors are only ever written
at `now` — `capturePageView` stamps `created_at` at insert and there is no backdating path in
the Worker. So once `now > day + 30d`, nothing can move that day again. The pass is a
*finalisation* with a known horizon, not an open-ended re-derivation, and it is why re-checking
a bounded window is complete rather than merely cheap.

The minimum window has **zero** margin: the last anchor that can move day `X` lands at
`(X+30)T23:59` and is seen only by the run on `X+31`. `SNAPSHOT_RECHECK_SLACK_DAYS` exists so
one missed night does not strand a day forever — which would be the same failure class this
ADR closes.

**The one exception, stated because it is a real operating procedure:**
`scripts/ops/2026-08-operator-page-view-backfill/` sets `is_operator = 1` on *historical* rows.
A run of it un-finalises days by exactly the amount it reaches. Its documented follow-up is
already "then re-run `ops:backfill-metrics-daily`" (§7.3), and that remains the vehicle.

### 2. §7.1's precedence rule gains a clause: a `measured` write may overwrite `measured`, but only where the source rows demonstrably survive

§7.1's original asymmetry — *a `measured` write always wins; a `reconstructed` write applies
only over an absent or already-`reconstructed` row* — is what makes the backfill re-runnable in
any order relative to the cron. It says nothing about one `measured` write overwriting another,
because until now only one producer wrote `measured` rows on a schedule.

An unattended pass needs more than that, because `metricSeries` returns a map that is **not**
zero-filled: a day with no matching rows simply does not appear in it. The natural
`perDay.get(day) ?? 0` therefore turns *every* cause of "the source rows are gone" — a prune, an
ops purge, a botched restore — into a diff of `stored → 0`, written over the only surviving
record of that day. `metrics-backfill.ts` already refuses that shape as the `stale` arm of its
dry run, for the same reason and in the same words.

So the pass probes `page_views` with **no predicates at all** and refuses any day absent from
the result. A genuinely quiet day is untouched by this: it has stored 0, recomputes 0, produces
no diff, and never reaches a write.

Two further refusals fall out of the same principle:

- **Values may only fall.** The retro-join can only *remove* rows from the admitted set, so the
  three re-checked keys are monotone decreasing under it. An increase cannot be convergence —
  it is a predicate change, an `is_bot` backfill, or restored rows.
- **A window-wide diff writes nothing.** Above ten moved days the pass reports and stops. Drift
  is a handful of days a month; a diff that size is a definition change, and rewriting a
  permanent record on that evidence, unattended and with no dry run, is precisely what
  `ops:backfill-metrics-daily --dry-run` exists to precede.

And one thing the clause explicitly does **not** license: promoting a row's `source`. The pass
carries each row's existing label through the write, so a corrected `reconstructed` row stays
`reconstructed`. Stamping `measured` on it would be a second, unannounced change — it drops the
flag `GET /api/admin/metrics/timeseries` reports per point, and it locks
`ops:backfill-metrics-daily` out of that row for good, since a `reconstructed` write may only
apply over an absent or already-`reconstructed` one. **A correction changes the value, never the
provenance.**

A refusal is reported, not silently dropped, and that reporting has one asymmetry worth stating.
On a `skipped` run the result still carries the corrections that *would* have been written —
that listing is the operator's whole basis for deciding whether to run the backfill — but
`aeci.metrics_snapshot.recheck.correction` counts only on a run that wrote. A counter that fired
on the one night the pass deliberately did nothing would be the same class of quiet
misstatement this ADR exists to end.

### 3. The pass deliberately never fixes coverage, and the reason is not the obvious one

It writes only where a stored row already exists. The tempting reading — "coverage is the
backfill's job" — is a policy statement a future PR can and will overrule. The real mechanism
is sharper: `findSnapshotGap` probes `metrics_daily` with `selectDistinct({day})` and **no
`metric` predicate**, so *any single row* tells the 03:00 retention prune that a day is
captured. Inserting one traffic key for a day the primary pass never covered would clear the
prune to delete that day's `page_views` while seventeen keys — including every stock, which is
unrecoverable retroactively — were still missing. That is permanent.

### 4. The pair is written together or not at all

Correcting the raw human count while leaving `traffic.page_views_human_after_automation` stale
renders a *filtered* series above the *unfiltered* one on `/admin/traffic` — a §1.1 violation
produced by the fix. On the real 2026-08-31 case that is "222 humans, 224 humans after
automation".

The filtered key is therefore recomputed for any day whose raw half moved, plus the fourteen
days after it (`detectSwarms`' recurrence lookback is backward-only, so a moved day can only
change the filtered figure at or after itself). It is computed *before* either half is written,
because `computeHumanViewsAfterAutomation` throws when the detector did not run: a day left
consistently stale beats one left inconsistently fresh.

This is also the only convergence path that key will ever have.

### 5. The chart says the window is soft

`series_within_operator_lookback` is emitted on any `traffic.*` window overlapping the last 30
days. D15(b) reports the pair match rather than applying it silently, because it is an
inference about identity rather than a fact about the request; its **non-finality** is reported
for the same reason. It also covers the hours between drift and the next re-check, and the
manual-backfill exception above.

## Consequences

- **`computed_at` no longer means "roughly `day` + 15 minutes".** It is now what it always
  said — when this value was computed — and on a corrected day that can be weeks later. It has
  no runtime reader; the forensic record of what moved and when lives in `job_runs.detail` and
  the emitted counters.
- **A re-check failure turns the whole `metrics-snapshot` run red**, in step with §7.2's
  existing rule that any failed metric collapses the run. A silently-broken correction pass is
  the exact defect class this ADR closes, so it must not be able to hide behind a green tick. A
  *refusal* is not a failure — the guard working is not a fault — and surfaces through a `warn`
  log and `aeci.metrics_snapshot.recheck.run{outcome:skipped}`.
- **Steady-state cost is seven extra queries and zero writes, and it does scale with the window.**
  `EXPLAIN QUERY PLAN` against local D1, run before merge because the better-sqlite3 harness cannot
  answer this:

  ```
  MULTI-INDEX OR
    SEARCH page_views USING INDEX page_views_bot_idx (is_bot=? AND created_at>? AND created_at<?)
    SEARCH page_views USING INDEX page_views_bot_idx (is_bot=? AND created_at>? AND created_at<?)
  CORRELATED SCALAR SUBQUERY 1
    SEARCH op USING COVERING INDEX page_views_operator_pair_idx (user_agent_hash=? AND cf_asn=? …)
  ```

  Two readings, and the second corrects what an earlier draft of this ADR claimed. The retro-join
  **is** a covering-index seek, which is the load-bearing half: `page_views_operator_pair_idx`
  (migration `0019`) turns it from `SCAN op` per candidate row into a lookup — 8 ms against 4.3 s
  over 41k rows, and 14 s / 42.7M rows read on a 14-day window without it. But the outer read is
  **not** a full scan and does not cost what a single-day scan costs: `HUMAN` leads on `is_bot`, so
  the planner takes two `(is_bot, created_at)` ranges off `page_views_bot_idx`. So rows read scale
  roughly linearly with the window — about 33× a single day, or ~33k rows per query at today's
  ~1,000 rows/day, ~100k across the three keys. That is ~0.01% of D1's included monthly rows-read
  allowance, so the conclusion holds; the *reason* is "it is a bounded index range", not "width is
  free". Widening the slack is cheap, not free — budget ~3% more rows per extra day.

  The raw-row probe is the one query that does **not** scale with the window: being unpredicated it
  plans as `SCAN page_views USING COVERING INDEX page_views_bot_idx`, so its cost grows with the
  table (~400k index entries at retention steady state, once a night). It cannot be narrowed —
  deriving presence from the human and bot maps would read a day the operator browsed alone as
  absent, which is the one case the guard exists to distinguish from data loss.

  If the retro-join's seek ever disappears from that plan, this pass is the first thing to check.
- **No migration, no new cron, no new binding.**

## What this does NOT fix

**Tuning a swarm constant silently obsoletes the stored filtered series.** Changing
`SWARM_MIN_VIEWS`, `SWARM_MIN_ASN_RATIO` or the `ASN_ROTATOR_*` thresholds changes `flagged(X)`
for every stored day with **no** change to any raw count — so the trigger set is empty, the
pass does nothing, and `traffic.page_views_human_after_automation` quietly mixes two
definitions. No automatic pass can detect this, and the key has no backfill. It is recorded as
an operational obligation beside those constants in `POST_LAUNCH_MONITORING.md` §3.

**A day with no stored row is a blind spot.** Its population change cannot be detected, because
there is nothing to compare against. Those days are reported as `uncoveredDays` and fixed by
filling coverage with the backfill — the same tool the prune's snapshot-gap abort points at.

**A definition change is still a human decision.** The refusals above route it to
`ops:backfill-metrics-daily`, deliberately. This pass converges drift; it does not rewrite
history on its own authority.

## Alternatives not taken

- **Make `NOT_INTERNAL` window-relative.** Rejected by §13 D15 before this issue existed, and
  the reasoning holds: five read surfaces inherit one static expression, and the bound-parameter
  count stays fixed regardless of pair count.
- **Resolve it at read time** — serve live for the trailing 30 days instead of the snapshot.
  Nearly free for three keys, since the endpoint already runs a whole-window `metricSeries`
  whenever any day is uncovered. It fails on the fourth: the snapshot-only key has no live path
  and `metricSeries` throws on it by design, so the panel's headline series is exactly the one
  this cannot reach. And the stored row stays wrong forever, which §7.4 converts from
  "recomputable" to "permanent" once `page_views` ages out. Its *note* was adopted; its
  behaviour was not.
- **A fifteenth cron.** Same computation, same clock, same writer, same `job_runs` row, and a
  wiring bill across `cron-schedules.ts`, three `wrangler.jsonc` blocks, the dispatcher, the
  liveness sweep and the runbooks. Its one real argument — isolating a slow correction from the
  unrecoverable stock capture — is answered by ordering the pass last inside the existing job.
- **Mark rows dirty at ingest.** Precision buys nothing: the recompute is one grouped query at
  any width, and the diff already reduces writes to zero when nothing moved. To be precise at
  all it would need a read on the hottest write path, and `capturePageView` swallows every
  failure — so a lost marker is a permanently wrong row with nothing to detect it.
- **Store provisional-ness as a third `source` value.** The marker is derivable (`day + 31`, for
  four keys), and the CHECK constraint on `source` cannot be `ALTER`ed on SQLite — drizzle-kit
  emits a table recreate, which is the last thing anyone should want on the indefinite-retention
  long memory.
- **Document the caveat and stop.** §13 D15 and the ops README already said it, in detail, with
  this evidence. The issue exists *because* they said it and it still did not converge.

## Re-open trigger

Re-open if any of these becomes true:

1. **`OPERATOR_PAIR_LOOKBACK_DAYS` rises materially.** The window is derived from it, so the
   pass follows automatically — but past roughly 90 days the nightly `EXISTS` evaluation stops
   being free and the cost model above needs re-measuring.
2. **A backdating path appears** — anything that writes a `page_views` row with a historical
   `created_at`, or an ops procedure that sets `is_operator` on old rows as routine rather than
   exceptional. Finality at `day + 31` is the load-bearing claim, and it rests on insert-time
   stamping.
3. **The refusal ceiling starts firing in normal operation.** That would mean drift is no longer
   a handful of days a month, and the shape of the problem has changed.
4. **A second producer starts writing `measured` rows on a schedule.** The precedence clause in
   §2 is stated for two writers; a third needs it re-derived, not re-used.
