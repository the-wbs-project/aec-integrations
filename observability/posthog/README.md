# PostHog observability plane (AECI-647 / PH-6)

Spec: `docs/POSTHOG_MIGRATION_SPEC.md` §AW6 (+ §3.4, §5, §8). This directory is the
committed source of truth for the PostHog dashboards, insights and alerts. It replaced
`observability/datadog/`, which **AECI-651 deleted** — so the disposition table below is
now the only record of the retired monitors' thresholds anywhere in the repo. The disposition table below is mirrored in
`docs/RUNBOOKS.md` (lifted there by AECI-648) — **this file is the origin**, so
change it here first and carry the edit across; keep the table clean and liftable.

| File | What it is |
|---|---|
| `project-config.json` | Topology (both projects, hosts, alert subscribers) + the thirteen-cron **liveness registry** the CI sweep reads. |
| `insights.json` | 7 dashboards, 43 insights (30 board + 13 alert-source), as data. |
| `alerts.json` | 13 PostHog alerts, each naming its source insight and carrying the **retired Datadog query verbatim**. |
| `apply.sh` | Thin applier over the three JSON files. Dashboards + insights to both projects, alerts to prod only. |
| `../../scripts/ci/posthog-liveness-sweep.sh` | The absence detector. Replaces all eight `notify_no_data` monitors. |
| `../../.github/workflows/posthog-liveness-sweep.yml` | Runs it every 3 hours, outside the Worker, and **fails red**. |

---

## Monitor disposition — all 26 retired Datadog monitors

Every monitor that landed anywhere **other** than a PostHog alert keeps its old Datadog
threshold in this table, so re-promoting one is a config change and not archaeology.
`observability/datadog/` was deleted at AECI-651, so this table (mirrored in
`docs/RUNBOOKS.md`) is the only place those thresholds survive.

| # | Datadog monitor | Old threshold | New home | Why |
|---|---|---|---|---|
| 1 | Worker error rate > 1% (5m) | `5xx / total * 100 > 1` over `last_5m` | **PostHog alert** — "Worker error rate > 1% (1 h)" | Fixed by spec §5. Cadence 5 min → hourly is the single biggest degradation in the set. |
| 2 | Algolia sync failed (daily cron) | `sum:aeci.algolia.sync{outcome:failed} > 0` over `last_1d` | **Combined alert** — "Cron job failed (any daily/hourly job)" | AW6 judgement, below. |
| 3 | Home stats compute failed | `sum:aeci.stats.compute.key{outcome:failed} + sum:aeci.stats.compute{outcome:failed,trigger:cron} > 0` over `last_1d` | **Combined alert** | AW6 judgement, below. |
| 4 | Data quality job failed | `sum:aeci.data_quality.job{outcome:failed} > 0` over `last_1d` | **Combined alert** | AW6 judgement, below. |
| 5 | Data quality check — ERROR severity | `max:aeci.data_quality.check{severity:error} by {check} > 0` over `last_1d` | **PostHog alert** — kept separate | AW6 judgement, below. |
| 6 | Retention prune failed | `sum:aeci.retention.prune{outcome:failed} > 0` over `last_1d` | **Combined alert** | AW6 judgement, below. |
| 7 | Linear reconcile: persistent stuck | `sum:aeci.linear.reconcile.persistent_failure > 0` over `last_1h` | **PostHog alert** — kept separate | AW6 judgement, below. |
| 8 | Retention prune runaway | `sum:aeci.retention.rows_deleted by {table} > 5000` over `last_1d` | **PostHog alert** — kept separate, threshold unchanged | AW6 judgement, below. |
| 9 | Algolia orphan sweep capped | `max:aeci.algolia.orphans_skipped_cap by {index} > 0` over `last_1d` | **PostHog alert** — kept separate | AW6 judgement, below. |
| 10 | Detail render slow (p95 > 1.5 s MISS) | `p95:aeci.page.render.duration_ms{route_class:detail,cache_status:miss} > 1500` over `last_10m` | **PostHog alert** — histogram p95 reconstructed | AW6 judgement, below. **Unverified until data flows** — manual step 2. |
| 11 | Auth sign-in error rate | `failed/total * 100 > 30` over `last_15m` | **PostHog alert (hourly)**, threshold 30% unchanged, **≥5-attempt floor added** | AW6 judgement, below. |
| 12 | Toxicity scoring outage | `failed/total * 100 > 50` over `last_15m` | **PostHog alert (hourly)**, threshold 50% unchanged, **≥5-call floor added** | AW6 judgement, below. |
| 13 | page_views write errors | `failed/total * 100 > 10` over `last_10m` | **PostHog alert (hourly)**, threshold 10% unchanged, **≥20-write floor added** | AW6 judgement, below. |
| 14 | Linear pipeline failure | `failed/(non-skipped) * 100 > 50` over `last_1h` | **PostHog alert (hourly)**, window + threshold unchanged, **≥3-attempt floor added** | AW6 judgement, below. |
| 15 | Linear webhook HMAC failures | `sum:aeci.webhooks.linear.hmac_failure > 3` over `last_1h` | **PostHog alert (hourly)**, unchanged | AW6 judgement, below. |
| 16 | WAF rate-limit spike | `sum:aeci.waf.ratelimit.blocked > 500` over `last_15m` | **PostHog alert (hourly)**, **threshold rescaled 500/15m → 2,000/1h** | AW6 judgement, below. |
| 17 | Retention prune skipped (non-paging) | `sum:aeci.retention.prune{outcome:skipped} > 0` over `last_1d` | **Digest** — dashboard "Cron health & retention" → *Retention — rows deleted, skipped and truncated runs* | Fixed by spec §5. The daily data-quality digest already carries it. |
| 18 | Data quality WARN severity (non-paging) | `max:aeci.data_quality.check{severity:warn} by {check} > 0` over `last_1d` | **Digest** — dashboard "Cron health & retention" → *Data quality — findings by check and severity* | Fixed by spec §5. The daily data-quality digest already carries it. |
| 19 | Algolia sync not running *(no-data)* | `sum:aeci.algolia.sync{outcome:ok,trigger:cron} < 1` over `last_2d`; `notify_no_data` @ 2880 min | **Liveness sweep** — `algolia-sync`, window **tightened 48 h → 26 h** | Fixed by spec §5. |
| 20 | Home stats not running *(no-data)* | `sum:aeci.stats.compute{trigger:cron} < 1` over `last_2d`; no-data @ 1560 min | **Liveness sweep** — `home-stats`, 26 h | Fixed by spec §5. |
| 21 | Data quality not running *(no-data)* | `sum:aeci.data_quality.job{trigger:cron} < 1` over `last_2d`; no-data @ 1560 min | **Liveness sweep** — `data-quality`, 26 h | Fixed by spec §5. |
| 22 | Reconcile sweep not running *(no-data)* | `min:aeci.linear.reconcile.stuck < 0` over `last_1h`; no-data @ 60 min | **Liveness sweep** — `request-reconcile`, window **relaxed 60 → 90 min** | Fixed by spec §5. The extra 30 min is margin for the *sweep's* lateness, not the job's. |
| 23 | WAF poll not running *(no-data)* | `sum:aeci.waf.poll{outcome:ok,trigger:cron} < 1` over `last_3h`; no-data @ 180 min | **Liveness sweep** — `waf-poll`, 180 min unchanged | Fixed by spec §5. |
| 24 | Retention prune not running *(no-data)* | `sum:aeci.retention.prune{trigger:cron} < 1` over `last_2d`; no-data @ 1560 min | **Liveness sweep** — `retention-prune`, 26 h | Fixed by spec §5. |
| 25 | Algolia index drift *(dual)* | value: `abs(max:aeci.algolia.index_drift) by {index} > 0` over `last_1d` · liveness: no-data @ 2880 min | **Dashboard (value)** — "Search" → *Algolia index drift and orphan sweep per index* · **Liveness sweep** (`algolia-drift`, 26 h) | Fixed by spec §5. Report-only value half; drift is repaired by the next 08:00 sync or the orphan sweep. |
| 26 | Moderation queue backlog *(dual)* | backlog: `max:aeci.moderation.queue_oldest_age_hours > 48` over `last_1d` · liveness: no-data @ 1560 min | **Dashboard (backlog)** — "Auth / Reviews / Moderation" → *Moderation queue depth and oldest pending age* · **Liveness sweep** (`moderation-snapshot`, 26 h) | Fixed by spec §5. |

**Totals:** 13 PostHog alerts covering 16 monitors · 8 → liveness sweep · 2 → digest ·
2 dual monitors split across both. 26 accounted for, none dropped.

---

## The "AW6 judges" rows — decisions and reasoning

Spec §5 left rows 2–16 to this workstream. Here is what was decided and why.

### One combined alert for the daily-cron failures (rows 2, 3, 4, 6)

Four separate Datadog monitors — Algolia sync failed, home stats compute failed, data
quality job failed, retention prune failed — become **one** alert,
`AECi — Cron job failed (any daily/hourly job)`.

Combining is normally a loss: you learn *something* broke but not *what*. Here it is not,
because PostHog's `HogQLAlertConfig` has a `label_column`, and the query returns the
failing metric names in it. The breach email says *which* jobs failed. So the combined
alert carries strictly the same information as four separate ones, in one notification,
with one place to tune.

Two deliberate widenings ride along:

1. **Six more crons gain failure coverage.** Datadog watched four; the alert watches ten
   metrics covering all thirteen crons (metrics-snapshot, asn-registry, analytics-digest,
   attestation-notify, entitlement-expiry, waf-poll and the per-key half of home-stats
   were previously unwatched — several shipped after the Datadog monitors were written).
2. **The `trigger:cron` predicate is dropped.** `aeci.algolia.sync` and
   `aeci.stats.compute` also fire on `trigger:promote`, and a promote-path failure is a
   real failure. Datadog's Algolia monitor was already trigger-agnostic; its stats monitor
   was not, and that asymmetry was a gap rather than a decision.

Breakdown when it fires: dashboard "Cron health & retention" →
*Crons — failed runs by job (last 7 days)*.

### Five monitors stay separate, on merit

| Monitor | Why not folded in |
|---|---|
| Data quality ERROR-severity (5) | The job **succeeded**; the DATA is wrong. Different runbook (triage the finding, not restart the job). Also improved: the query uses `max(abs(value))`, so a check that **threw** (sentinel `-1`) now fires. Datadog's `max(...) > 0` could not see a thrown check — a real hole, closed here. |
| Retention prune runaway (8) | A **successful** run with the wrong effect. Its runbook is "find out what was deleted before it ages out", which shares nothing with "the job failed". Threshold unchanged at 5,000 rows/table/day. |
| Linear reconcile persistent stuck (7) | The sweep is healthy; a **user-visible vendor request** is stuck. Hourly, not daily. The operator action is to open that request. |
| Algolia orphan sweep capped (9) | Also a success-with-a-caveat — the healer refused a large purge. Folding a caveat into "job failed" would make that alert's meaning mushy, which is the failure mode that gets alerts ignored. |
| Linear webhook HMAC failures (15) | Security signal, not a job signal. Unchanged in every respect except evaluation cadence. |

### Detail render p95 (row 10) — ported as a real alert, with a caveat

Spec §5 left this as "alert or dashboard — AW6 judges vs Metrics-alpha insight support".
It is an **alert**, because the arithmetic turned out to be expressible.

PostHog stores our distributions as OTLP explicit-bucket histograms and exposes
`histogram_bounds` / `histogram_counts` as HogQL arrays. `sumForEach()` sums the count
arrays element-wise across data points, `arrayCumSum` + `indexOf` finds the bucket the
95th observation falls in, and the alert evaluates that bucket's **upper bound**. That is
a conservative over-estimate by at most one bucket width — the right direction for an
alert — and it never needs the Metrics-alpha insight builder.

Two guards that are not optional:

- `arrayPushBack(bounds, 999999.0)` gives the `+Inf` overflow bucket an edge.
  `histogram_counts` has `bounds.length + 1` entries; without the sentinel, a p95 above
  10 s indexes past the end of `bounds`, ClickHouse returns the `0` default, and **the
  worst case would silently fail to fire**.
- A 20-observation floor. Under WC-8 a cache HIT skips the Worker entirely, so this
  series is MISS-only and can be very sparse; a p95 built from three samples is noise.

**This is the one thing in this workstream that is unverifiable until data flows.** The
query compiles and executes correctly against an empty table; the arithmetic has never
seen a real histogram. Manual step 2 below is the spot-check.

For everyday reading, prefer the dashboard widget *Traffic — SSR render latency
distribution (histogram buckets)*: it is a straight read of the bucket counts with no
reconstruction at all, so it cannot be wrong.

### Ratio alerts (rows 11–14) — hourly, with denominator floors

All four keep their Datadog thresholds exactly. Two things change:

- **Cadence and window move to 1 hour.** Hourly is the PostHog floor (spec D3;
  `every_15_minutes` needs the Boost add-on). Row 14 already used a 1 h window, so only
  its evaluation cadence moved.
- **A minimum-denominator floor is added** to each (5 / 5 / 20 / 3). This is new and
  deliberate: at AECi's current volume, one failed sign-in out of two is 50% and would
  have paged. Datadog's shorter windows had the same exposure and simply got lucky. The
  floor is implemented as `if(total >= N, ratio, 0.0)`, so a quiet hour reads 0.

### WAF spike (row 16) — the one threshold that had to move

Datadog fired on **>500 blocked events in 15 minutes**. The equivalent hourly rate is
`500 x 4 = 2,000`, and that is the new threshold.

The underlying data did not change and neither did the sensitivity: the source is an
**hourly** cron (`WAF_CRON = 0 * * * *`) that reads the *previous clock hour* from
Cloudflare's GraphQL Analytics API in one shot. A 15-minute Datadog window over an
hourly-emitted series was always coarser than it looked — it just saw the whole hour's
count land inside one 15-minute bucket.

---

## Migration hazards — read before editing a query

Three things differ from Datadog in ways that fail **silently** (a query returns 0 rows
and looks exactly like a healthy system).

1. **Datadog lowercased tag values on ingest. PostHog does not.**
   `cache_status` is emitted as the literal `MISS` (`apps/web/src/server-runtime.ts:989`).
   A predicate copied from a Datadog query as `cache_status:miss` matches nothing.
   Every query here wraps such comparisons in `lower()`. `status_class` is already
   lowercase in source (`${Math.floor(status / 100)}xx`) but is wrapped too, because the
   cost is nil and the failure is invisible.

2. **There is no `env:` filter, on purpose.** Datadog scoped every query with
   `env:production`; here the **project is the tier boundary** (spec D4/§3.6). Adding
   `resource_attributes.env = 'production'` would be belt-and-braces with a real downside:
   if the transport ever tags `env` differently, every alert reads 0 forever and nothing
   fails. If a tier is ever mis-routed again (as demo was, pre-AECI-640), fix the routing,
   not the queries.

3. **There is no `aggregation_temporality` filter, on purpose.** Our counters and
   histograms are DELTA by construction (spec §2 pins `aggregationTemporality: 1`) and
   gauges carry none at all (§8.1). `sum(value)` is correct without the predicate, and a
   predicate whose literal casing is wrong would silently zero every counter alert. Add
   it only if a cumulative source is ever introduced.

Two more, less dangerous but easy to trip over:

4. **HogQL table namespacing is asymmetric.** `logs` is at the ROOT; metrics and spans
   need the prefix (`posthog.metrics`, `posthog.trace_spans`). A bare `FROM metrics`
   errors with "Unknown table".

5. **Value semantics vary per metric.** Most counters submit `1`, but
   `aeci.algolia.sync.records`, `aeci.waf.ratelimit.blocked`,
   `aeci.linear.reconcile.attempt` and `aeci.linear.reconcile.persistent_failure` submit
   the **row/event count** as the value. They are summed, not counted.
   `docs/OBSERVABILITY.md` flags each one.

---

## What is verified and what is not

Verified live against project **354071** (production, read-only) and **525793**
(non-production) on 2026-08-24:

- ✅ All 43 HogQL queries compile and execute. Each was run individually.
- ✅ All 13 alert-source queries return **exactly one row** on an empty table
  (`0` / `''`), which is the shape that makes a threshold alert safe.
- ✅ The `dashboard-create` → `insight-create` (DataVisualizationNode + HogQLQuery) →
  `alert-create` (HogQLAlertConfig, `evaluation: last_row`, `label_column`,
  `calculation_interval: hourly`) chain works end to end. Probed and then deleted.
- ✅ A saved insight computes when read back (not just as an ad-hoc query).
- ✅ 7 dashboards + 43 insights created live in **525793**.
- ✅ `apply.sh --dry-run` runs end to end (14 dashboards, 86 insights, 13 alerts planned),
  `bash -n` and `shellcheck` clean, no bash-4-only constructs.
- ✅ The liveness sweep's failure path is **drilled** — see below.

**Not verified, and cannot be until AECI-642 ships and data flows:**

- ❌ Every query returns zero rows today. `posthog.metrics` is empty on both projects.
  Correct *shape* is proven; correct *numbers* are not.
- ❌ The histogram p95 reconstruction (manual step 2).
- ❌ `search_performed` in production currently carries only
  `query` / `results_count` / `filters_applied`. The §3.9 properties
  (`status`, `duration_ms`, `results_bucket`) are on the `searchPerformed()` signature in
  source but not yet in the production taxonomy — PostHog's taxonomy warning on those
  columns is the expected pre-AW2 state, not a bug in the query.
- ❌ Nothing was created in production (354071). `apply.sh` does that; it is operator
  step 3 below.

---

## The liveness sweep drill

`docs/POSTHOG_MIGRATION_SPEC.md` §6 item 8 requires proving the failure path fires. A real
cron cannot be killed to order, so the drill runs the sweep's real code — real `curl`,
real `jq`, real staleness comparison, real exit codes and GitHub annotations — against a
local stub that speaks the verbatim PostHog query-API envelope
(`{"results": [[metric, last_seen, age_minutes], ...], "columns": [...]}`).

Run on 2026-08-24 via `PH_APP_HOST=http://127.0.0.1:<port>`:

| Scenario | Stub behaviour | Result |
|---|---|---|
| `all-fresh` | all thirteen heartbeats, age 12 min | table of 13 `ok` rows, `all 13 cron heartbeats fresh`, **exit 0** |
| `one-dead` | `aeci.algolia.sync` **absent from the result set** | that row prints `MISSING`, `::error title=Cron heartbeat MISSING: algolia-sync::No 'aeci.algolia.sync' data point in the last 72 h…`, **exit 1** |
| `one-stale` | `aeci.waf.poll` present, age 400 min (max 180) | that row prints `STALE`, `::error title=Cron heartbeat STALE: waf-poll::'aeci.waf.poll' last reported 400 minutes ago; the '0 * * * *' schedule allows 180.`, **exit 1** |
| `http-500` | PostHog returns 500 | `Cron liveness is UNCHECKED for this run — treat it as unknown, not as healthy`, **exit 2** |
| no key | `POSTHOG_CLI_API_KEY` unset | `Cron liveness is UNCHECKED until then — this is not a pass`, **exit 2** |

The stub also echoed back what the script sent, confirming
`POST /api/projects/354071/query/`, `Authorization: Bearer phx_…`, and the twelve-metric
SQL. That same SQL, verbatim, was separately executed against the **live production**
project and returned the expected empty result set.

Exit 1 and exit 2 are deliberately distinct: **"the sweep could not run" is not "the crons
are fine".** Both are red; the annotations say which.

---

## Numbered manual steps

Nothing below is missing silently — each is a TODO with its recreate recipe.

1. **Dashboard tile layout.** `apply.sh` does not manage tile positions. Insights land on
   their board in creation order; drag them where you want them. Layout carries no
   contract and pinning it in JSON would make every cosmetic tweak a repo change.

2. **Spot-check the histogram p95 against Datadog, during the dual-run window.**
   The one piece of arithmetic here that has never seen real data. While both vendors are
   emitting, compare:
   - Datadog: `p95:aeci.page.render.duration_ms{route_class:detail,cache_status:miss,env:production}`
   - PostHog: the insight `AECi — ALERT — Detail page render p95, cache MISS (1 h)`
   The PostHog number should be **≥** the Datadog p95 and within one bucket width of it
   (bounds: `5,10,25,50,75,100,250,500,750,1000,1500,2500,5000,7500,10000` ms). If it is
   *lower*, or 0 while Datadog shows traffic, the reconstruction is wrong — check the
   `lower(cache_status)` predicate first, then whether `histogram_bounds` is uniform
   across points. Do not delete the Datadog monitor (AECI-651) until this is checked.

3. **Run `apply.sh` against production.** Requires the `phx_` key (operator checklist
   below). `./observability/posthog/apply.sh --dry-run` first, then without the flag, then
   paste the dashboard URLs into `docs/OBSERVABILITY.md` (spec §7).
   Non-prod is already applied — the applier is idempotent by name and will skip it.

4. **Consider log alerts if hourly proves too slow.** PostHog's *other* alert type
   (`POST /api/projects/:id/logs/alerts/`) supports **5/10/15/30/60-minute** windows —
   tighter than the hourly insight-alert floor, and without the Boost add-on. Not used
   here because our failure signals are metrics, and the equivalent log lines are not
   emitted on every path. If the Worker error-rate alert's 5 min → 1 h regression bites,
   this is the upgrade path. Max 20 log alerts per project.
   Shape: `{"name", "filters": {"severityLevels": ["error"], "serviceNames": ["aeci-api"]},
   "threshold_count", "window_minutes", "cooldown_minutes"}`.

5. **Non-email alert delivery is not wired.** `subscribed_users` (email) is the only
   channel `apply.sh` configures. Slack/Discord/webhook delivery is a separate
   `cdp-functions` object. Deliberately skipped: AECi has no Slack (CLAUDE.md), and email
   to the operator is the established channel. If that changes: look up the channel with
   `integrations-channels-retrieve`, then create a cdp-function filtered on the alert id.

6. **Consider `aeci.ssr.render` for the error-rate numerator.** The alert keeps Datadog's
   source (`aeci.page.render.duration_ms`), which is only emitted on the cacheable-render
   branch. `aeci.ssr.render` is a counter emitted on **every** branch the SSR Worker runs
   and would give strictly better coverage. Not changed here because a port should not
   quietly change what a number means; revisit once the dual-run confirms parity.

---

## Operator checklist (User Input required)

None of these block the code. Each gates a capability, and each is currently outstanding
(verified 2026-08-24; consistent with spec §8.7).

- [ ] **Personal `phx_` API key → `POSTHOG_CLI_API_KEY`.** Not provisioned. Needed by
  `apply.sh` (operator keychain, as `POSTHOG_PERSONAL_API_KEY` or `POSTHOG_CLI_API_KEY`),
  by the liveness-sweep workflow (GitHub secret), by deploy annotations, and by source-map
  upload. **One key needs the union of scopes** (spec §7 + §8.3):
  insight write · dashboard write · alert write · project read · **query read** ·
  error tracking write · organization read.
  Create at <https://us.posthog.com/settings/user-api-keys>.
  *Until it exists, the liveness sweep exits 2 on every run — "unchecked", not a pass.*

- [ ] **Repo variables `POSTHOG_PROJECT_ID_PROD=354071` / `POSTHOG_PROJECT_ID_NONPROD=525793`.**
  Not set (confirmed via `gh variable list`). The workflows fall back to the literals, so
  this is a repoint convenience rather than a blocker.

- [ ] **Error tracking (exception autocapture) enabled on both projects.** Disabled on
  both. It is a product toggle, not an API object — the personal-API-key scope set does
  not include `product_enablement:write`, so this is dashboard-only:
  <https://us.posthog.com/project/354071/settings/error-tracking> and the same for 525793.
  Until it is on, browser and Worker exception capture has nowhere to land.

- [ ] **Internal-user exclusion configured on 354071.** Not configured. Add
  `chrisw@thewbsproject.com` under project settings → Internal users. Until then
  production product analytics carry operator traffic while `page_views` excludes it via
  verified admin session — the two surfaces disagree for a reason that looks exactly like
  a bug.

- [ ] **Run `apply.sh` against production** (manual step 3) and paste the dashboard URLs
  into `docs/OBSERVABILITY.md`.

- [ ] **Delete the `POSTHOG_KEY_STAGING` / `POSTHOG_KEY_PRODUCTION` GitHub secrets.**
  Now unused (spec §8.7).

- [ ] **At AECI-651 only:** delete the 26 live Datadog monitors and 5 dashboards in the
  Datadog UI. `apply.sh` cannot and must not touch Datadog.

---

## Live objects (non-production, project 525793)

Created 2026-08-24 from this committed JSON. Production is empty pending manual step 3.

| Dashboard | id | URL |
|---|---|---|
| AECi — Traffic (SSR + API) | 2025785 | <https://us.posthog.com/project/525793/dashboard/2025785> |
| AECi — Search (Algolia + browser) | 2025786 | <https://us.posthog.com/project/525793/dashboard/2025786> |
| AECi — Home / Stats | 2025787 | <https://us.posthog.com/project/525793/dashboard/2025787> |
| AECi — Auth / Reviews / Moderation | 2025788 | <https://us.posthog.com/project/525793/dashboard/2025788> |
| AECi — Requests / Linear pipeline | 2025789 | <https://us.posthog.com/project/525793/dashboard/2025789> |
| AECi — Cron health & retention | 2025790 | <https://us.posthog.com/project/525793/dashboard/2025790> |
| AECi — Alert signal sources | 2025791 | <https://us.posthog.com/project/525793/dashboard/2025791> |

43 insights, ids `11280545`–`11280671`. No alerts exist in 525793 by design.

## Preflight: required vs optional scopes

`preflight()` probes six endpoints and classifies each as **required** or
**optional**. Only required misses block a project.

| Probe | Class | Why |
|---|---|---|
| project read | required | every lookup needs it |
| dashboard read+write | required | this applier creates dashboards |
| insight read+write | required | this applier creates insights |
| alert read+write | optional | alerts are prod-only; a miss surfaces as a per-object failure in the summary rather than skipping the whole project |
| annotation write | **optional** | **nothing here writes annotations.** Deploy markers do, from `scripts/ci/posthog-deploy-marker.sh`, using the same key. Probed so a missing scope is reported once, here, instead of being found later by CI |
| log-alert read+write | **optional** | the §5 tighter-cadence re-home path, deliberately unused (recipe 4) |

The first version collected every miss into one list and failed on any of them,
which made the classification decorative and skipped **both** projects over two
scopes the applier never calls. If you add a probe, set its class deliberately.
