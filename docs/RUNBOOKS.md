# Runbooks

Operational response guides for AECi's alerts.

> **Status: stubs (AECI-66).** Each runbook below has enough to triage during Phase 2.
> Full incident procedures (severity matrix, comms, post-mortem template) land in
> Phase 6. **Linked from the alert messages on both planes — keep the heading anchors
> stable.**

## Which console just paged you

**PostHog.** It is the only observability plane: AECI-651 deleted the 26 Datadog
monitors, the five dashboards, and both Worker transport legs. The alert set is
committed as `observability/posthog/alerts.json` and applied to the **production**
project (`aec-integrations`, 354071); alerts are deliberately production-only, so a
preview deploy failing a cron does not page anyone.

Two properties of the current model matter mid-incident and are different from what
the Datadog monitors did:

- **Alerts evaluate hourly.** Not every 5 minutes. If you are looking at a graph that
  is clearly bad and no alert has fired, that is expected within the hour — do not
  assume the alert is broken.
- **Nothing in PostHog detects absence.** "The 08:00 cron never ran" is caught by the
  **CI liveness sweep** (`.github/workflows/posthog-liveness-sweep.yml`, every 3 h),
  which fails red in GitHub Actions and emails. If a cron is silent, check that job's
  run history, not PostHog.

### Reading logs

Every `service:<worker> source:<subsystem>` filter used in the runbooks below maps
onto PostHog Logs as follows:

| | PostHog Logs |
|---|---|
| Which service | filter the OTLP **resource** attribute `service.name` (the explorer's service filter reads only the dotted key — `service` alone will not find it) |
| Which subsystem | the `source` attribute — same values the runbooks quote |
| Severity | `severity_number >= 17` for error (`warn` is 13) |
| Which tier | **the project is the tier** — `aec-integrations` (354071) is production; every other tier shares `aec-integrations-dev` (525793) |
| Which person | `posthogDistinctId`, on genuinely-authed requests only (AECI-644) |

Two log-shaped things are worth knowing about mid-incident: **`posthogDistinctId`**
(an unhandled 500 is one click from the person it happened to) and the **`deployment`
event** (`deploy_kind` ∈ `deploy` / `promote` / `preview` / `auto_rollback`), which is
how you answer "did a deploy cause this" with a join rather than a guess.

## Alert → runbook

Every one of the 26 retired Datadog monitors, where it landed, and
which runbook below covers it. **The old Datadog threshold is recorded for every
monitor that landed anywhere other than a PostHog alert**, so re-promoting one is a
config change and not archaeology — this table and
`observability/posthog/README.md` are now the **only** places those thresholds
survive, `observability/datadog/` having been deleted.

| # | Retired Datadog monitor | Old threshold | Where it landed | Runbook |
|---|---|---|---|---|
| 1 | Worker error rate > 1% (5m) | `5xx / total * 100 > 1` over `last_5m` | **PostHog alert** — "Worker error rate > 1% (**1 h**)" | [High Worker error rate](#high-worker-error-rate) |
| 2 | Algolia sync failed (daily cron) | `sum:aeci.algolia.sync{outcome:failed} > 0` over `last_1d` | **Combined alert** — "Cron job failed (any daily/hourly job)" | [Algolia sync failed](#algolia-sync-failed) |
| 3 | Home stats compute failed | `sum:aeci.stats.compute.key{outcome:failed} + sum:aeci.stats.compute{outcome:failed,trigger:cron} > 0` over `last_1d` | **Combined alert** | [Home stats stale or compute failed](#home-stats-stale-or-compute-failed) |
| 4 | Data quality job failed | `sum:aeci.data_quality.job{outcome:failed} > 0` over `last_1d` | **Combined alert** | [Data quality job failed or not running](#data-quality-job-failed-or-not-running) |
| 5 | Data quality check — **ERROR** severity | `max:aeci.data_quality.check{severity:error} by {check} > 0` over `last_1d` | **PostHog alert — kept separate.** Also *improved*: the query uses `max(abs(value))`, so a check that **threw** (sentinel `-1`) now fires. Datadog's `max(...) > 0` could not see a thrown check — a real hole, closed in the port | [Data quality job failed or not running](#data-quality-job-failed-or-not-running) |
| 6 | Retention prune failed | `sum:aeci.retention.prune{outcome:failed} > 0` over `last_1d` | **Combined alert** | [Retention prune skipped, failed, or not running](#retention-prune-skipped-failed-or-not-running) |
| 7 | Linear reconcile: persistent stuck | `sum:aeci.linear.reconcile.persistent_failure > 0` over `last_1h` | **PostHog alert — kept separate** (a user-visible vendor request is stuck; the sweep itself is healthy) | [Linear reconciliation — stuck requests](#linear-reconciliation--stuck-requests) |
| 8 | Retention prune runaway | `sum:aeci.retention.rows_deleted by {table} > 5000` over `last_1d` | **PostHog alert — kept separate, threshold unchanged** (a *successful* run with the wrong effect) | [Retention prune skipped, failed, or not running](#retention-prune-skipped-failed-or-not-running) |
| 9 | Algolia orphan sweep capped | `max:aeci.algolia.orphans_skipped_cap by {index} > 0` over `last_1d` | **PostHog alert — kept separate** (success-with-a-caveat; folding it into "job failed" would make that alert mushy) | [Algolia index drift](#algolia-index-drift) |
| 10 | Detail render slow (p95 > 1.5 s, MISS) | `p95:aeci.page.render.duration_ms{route_class:detail,cache_status:miss} > 1500` over `last_10m` | **PostHog alert** — p95 reconstructed from OTLP histogram buckets. ⚠️ **unverified until data flows** | [High p95 detail render](#high-p95-detail-render) |
| 11 | Auth sign-in error rate | `failed/total * 100 > 30` over `last_15m` | **PostHog alert (hourly)**, threshold 30% unchanged, **≥5-attempt floor added** | [Auth sign-in error-rate spike](#auth-sign-in-error-rate-spike) |
| 12 | Toxicity scoring outage | `failed/total * 100 > 50` over `last_15m` | **PostHog alert (hourly)**, threshold 50% unchanged, **≥5-call floor added** | [Toxicity scoring outage](#toxicity-scoring-outage) |
| 13 | page_views write errors | `failed/total * 100 > 10` over `last_10m` | **PostHog alert (hourly)**, threshold 10% unchanged, **≥20-write floor added** | [Page-view writes failing](#page-view-writes-failing) |
| 14 | Linear pipeline failure | `failed/(non-skipped) * 100 > 50` over `last_1h` | **PostHog alert (hourly)**, window + threshold unchanged, **≥3-attempt floor added** | [Linear pipeline failure](#linear-pipeline-failure-issue-creation--sync) |
| 15 | Linear webhook HMAC failures | `sum:aeci.webhooks.linear.hmac_failure > 3` over `last_1h` | **PostHog alert (hourly)**, unchanged in every respect except cadence (security signal, not a job signal) | [Linear webhook HMAC failures](#linear-webhook-hmac-failures) |
| 16 | WAF rate-limit spike | `sum:aeci.waf.ratelimit.blocked > 500` over `last_15m` | **PostHog alert (hourly)**, **threshold rescaled 500/15 m → 2,000/1 h** | [WAF rate-limit / challenge spike](#waf-rate-limit--challenge-spike) |
| 17 | Retention prune skipped *(non-paging)* | `sum:aeci.retention.prune{outcome:skipped} > 0` over `last_1d` | **Digest + dashboard** — "Cron health & retention" → *Retention — rows deleted, skipped and truncated runs*. **No alert.** The daily data-quality digest already carries it | [Retention prune skipped, failed, or not running](#retention-prune-skipped-failed-or-not-running) |
| 18 | Data quality **WARN** severity *(non-paging)* | `max:aeci.data_quality.check{severity:warn} by {check} > 0` over `last_1d` | **Digest + dashboard** — *Data quality — findings by check and severity*. **No alert** | [Data quality job failed or not running](#data-quality-job-failed-or-not-running) |
| 19 | Algolia sync not running *(no-data)* | `sum:aeci.algolia.sync{outcome:ok,trigger:cron} < 1` over `last_2d`; `notify_no_data` @ 2880 min | **Liveness sweep** — `algolia-sync`, window **tightened 48 h → 26 h** | [Algolia sync failed](#algolia-sync-failed) |
| 20 | Home stats not running *(no-data)* | `sum:aeci.stats.compute{trigger:cron} < 1` over `last_2d`; no-data @ 1560 min | **Liveness sweep** — `home-stats`, 26 h | [Home stats stale or compute failed](#home-stats-stale-or-compute-failed) |
| 21 | Data quality not running *(no-data)* | `sum:aeci.data_quality.job{trigger:cron} < 1` over `last_2d`; no-data @ 1560 min | **Liveness sweep** — `data-quality`, 26 h | [Data quality job failed or not running](#data-quality-job-failed-or-not-running) |
| 22 | Reconcile sweep not running *(no-data)* | `min:aeci.linear.reconcile.stuck < 0` over `last_1h`; no-data @ 60 min | **Liveness sweep** — `request-reconcile`, window **relaxed 60 → 90 min** (the extra 30 is margin for the *sweep's* lateness, not the job's) | [Linear reconciliation — stuck requests](#linear-reconciliation--stuck-requests) |
| 23 | WAF poll not running *(no-data)* | `sum:aeci.waf.poll{outcome:ok,trigger:cron} < 1` over `last_3h`; no-data @ 180 min | **Liveness sweep** — `waf-poll`, 180 min unchanged | [WAF rate-limit / challenge spike](#waf-rate-limit--challenge-spike) |
| 24 | Retention prune not running *(no-data)* | `sum:aeci.retention.prune{trigger:cron} < 1` over `last_2d`; no-data @ 1560 min | **Liveness sweep** — `retention-prune`, 26 h | [Retention prune skipped, failed, or not running](#retention-prune-skipped-failed-or-not-running) |
| 25 | Algolia index drift *(dual)* | value: `abs(max:aeci.algolia.index_drift) by {index} > 0` over `last_1d` · liveness: no-data @ 2880 min | **Dashboard (value)** — "Search" → *Algolia index drift and orphan sweep per index* · **Liveness sweep** (`algolia-drift`, 26 h). **The value half stops alerting** — it is report-only and self-heals | [Algolia index drift](#algolia-index-drift) |
| 26 | Moderation queue backlog *(dual)* | backlog: `max:aeci.moderation.queue_oldest_age_hours > 48` over `last_1d` · liveness: no-data @ 1560 min | **Dashboard (backlog)** — "Auth / Reviews / Moderation" → *Moderation queue depth and oldest pending age* · **Liveness sweep** (`moderation-snapshot`, 26 h). **The backlog half stops alerting** — read it on the dashboard | [Moderation queue backlog](#moderation-queue-backlog) |

**Totals: 13 PostHog alerts covering 16 monitors · 8 → the liveness sweep · 2 → the
digests · 2 dual monitors split across both.** 26 accounted for, none dropped.

**Six crons gain failure coverage they never had** (metrics-snapshot,
analytics-digest, attestation-notify, entitlement-expiry, waf-poll, and the per-key
half of home-stats — several shipped after the Datadog monitors were written), and
the liveness sweep watches **twelve** crons where Datadog watched six.

### The combined cron-failure alert — where the detail is

Rows 2, 3, 4 and 6 above are **one** PostHog alert:
`AECi — Cron job failed (any daily/hourly job)`.

Combining is normally a loss — you learn *something* broke but not *what*. It is not
one here, because PostHog's `HogQLAlertConfig` has a **`label_column`** and the query
returns the **failing metric names** in it. **The breach email tells you which jobs
failed.** Read the label column first, then open the matching runbook below.

If the email is truncated or you want history, the breakdown is on the PostHog
dashboard **"AECi — Cron health & retention" → *Crons — failed runs by job (last 7
days)***. `/admin/system` carries the same record in-product (`job_runs`, 90-day
window, with the data-quality job's full result set), and it does not require a
telemetry login at all.

One deliberate widening rides along: **the `trigger:cron` predicate is dropped.**
`aeci.algolia.sync` and `aeci.stats.compute` also fire on `trigger:promote`, and a
promote-path failure is a real failure. Datadog's Algolia monitor was already
trigger-agnostic; its stats monitor was not, and that asymmetry was a gap rather
than a decision.

### Two dependencies the old alert model did not have

State these before an incident, not during one.

1. **Alert cadence is hourly, uniformly.** PostHog's `every_15_minutes` needs the
   Boost add-on and `real_time` needs Scale/Enterprise. Four Datadog monitors
   evaluated at 5–15 minutes; **the Worker error-rate alert moves 5 min → 1 h**,
   which is the single largest degradation in the migration. Plan detection time
   accordingly: a 5xx spike can now run for an hour before anything pages. The
   escape hatch, if it bites, is PostHog's *log*-alert type — 5/10/15/30/60-minute
   windows, no add-on, max 20 per project (`observability/posthog/README.md`,
   manual step 4).
2. **Absence detection depends on GitHub Actions being up.** No PostHog tier has
   `notify_no_data`, so all eight no-data monitors are replaced by
   `.github/workflows/posthog-liveness-sweep.yml`, which runs every 3 hours
   **outside** the Worker — the property that made "Datadog owns absence" true, and
   one a Worker-hosted check cannot have. If GitHub Actions is degraded, cron
   liveness is **unchecked**, and the sweep says so rather than passing: **exit 0** =
   all twelve fresh, **exit 1** = a heartbeat is MISSING or STALE (with a
   `::error::` annotation naming the cron and its allowance), **exit 2** = the sweep
   could not run (PostHog 5xx, or no `POSTHOG_CLI_API_KEY`). **Exit 2 is red, not
   green — "the sweep could not run" is not "the crons are fine."** Never add
   `continue-on-error` to that workflow. The independent second record, when the
   sweep is dark, is `/admin/system` + the two daily digest emails.

Dashboard for the render / error-rate runbooks below: **AECi — Traffic (SSR + API)**
in PostHog (URLs in `docs/OBSERVABILITY.md`). Edge cache HIT-rate is in **neither** — it lives on the
Cloudflare Workers observability dashboard (WC-8; see below).

---

## Low cache hit rate

> **Retired as an alert (WC-8 / AECI-322).** There is no longer a `cache hit rate < 70%`
> monitor. Under native Workers Cache (WC-3) a HIT is served from the edge **without running the
> SSR Worker**, so no in-Worker telemetry can observe HITs — the
> `aeci.page.render.duration_ms{cache_status:hit}` numerator this alert used is permanently ~0. This section is kept for link stability and
> re-points you at the current HIT surface.

**Where HIT-rate lives now:** the **Cloudflare Workers observability dashboard** (Workers & Pages →
`aeci-web` → Observability) and the **`Cf-Cache-Status`** response header
(`HIT`/`MISS`/`EXPIRED`/`BYPASS`). Read edge HIT-rate there — **neither** telemetry plane has it.

**If HIT-rate looks low on the Cloudflare dashboard**

1. Did someone just run `POST /admin/purge` (or trigger a `POST /api/promote` purge cascade)? A
   broad/accidental purge causes a temporary, self-healing dip — check the "purge events by source"
   widget / `aeci.cache.purge`; confirm it recovers within a TTL window.
2. Recent deploy? Workers Cache is per-version (`cross_version_cache` off), so every deploy
   cold-starts the cache — expect a short dip as it refills. Correlate with `GET /api/version`.
3. Isolated to one `route_class`? A single class suggests a TTL or cache-key regression for those
   routes (see `docs/CACHE_STRATEGY.md` §4 / §4a).
4. Cache-key poisoning / `BYPASS`: verify cacheable responses are visitor-state-neutral (no
   `Set-Cookie`, no `Vary: Cookie`, theme cookie stripped) per `docs/CACHE_STRATEGY.md` §6 — a
   `Set-Cookie` on a cacheable route forces the native cache to `BYPASS`.

**Escalation:** If not explained by a purge/deploy and not recovering, treat as a
caching regression — page the on-call engineer (Phase 6 rotation TBD).

---

## High p95 detail render

**Alert:** `AECi — Detail page render p95, cache MISS (1 h)`, same 1,500 ms threshold, hourly.
**Metric:** `aeci.page.render.duration_ms{route_class:detail,cache_status:miss}` p95.

> **⚠️ The PostHog successor reconstructs p95 from OTLP histogram buckets, and that
> arithmetic has never seen real data.** It sums the bucket-count arrays element-wise,
> finds the bucket the 95th observation falls in, and reports that bucket's **upper
> bound** — a conservative over-estimate by at most one bucket width, which is the right
> direction for an alert. Two guards make it correct: an `+Inf` overflow sentinel (without
> it a p95 above 10 s indexes past the array, returns 0, and **the worst case silently
> fails to fire**) and a 20-observation floor (under WC-8 this series is MISS-only and can
> be very sparse; a p95 from three samples is noise).
>
> **This was never validated against the Datadog original before that plane was
> deleted (AECI-651), so treat the first firing as unproven.** Sanity checks if it
> looks wrong: the value should land within one bucket width above the true p95
> (bounds `5,10,25,50,75,100,250,500,750,1000,1500,2500,5000,7500,10000` ms). If it
> reads implausibly low, or 0 while the dashboard shows traffic, check the
> `lower(cache_status)` predicate first, then whether `histogram_bounds` is uniform
> across points. For everyday reading prefer the dashboard widget *Traffic — SSR
> render latency distribution (histogram buckets)*, which is a straight read of the
> bucket counts with no reconstruction at all.

**What it means:** Server render of detail pages on a cache MISS is slow. Scoped to
MISS because HITs are edge-served and don't reflect render cost. Under native Workers Cache a MISS
is exactly "the Worker ran", so this alert is **unaffected** by the front-of-Worker migration
(WC-3/WC-8) — it keeps measuring real render cost.

**First checks**

1. Is the API slow? Check `p95:aeci.api.query.duration_ms by {endpoint}` for the detail
   endpoints (`/api/products/:slug`, `/api/vendors/:slug`, `/api/integrations/:id`).
2. Supabase health: connection/latency via the logs (`service:aeci-api`) and the
   Supabase dashboard.
3. Recent deploy to `apps/web`? An Angular SSR regression (heavy resolver, blocking
   work) can inflate render time — correlate with `GET /api/version`.
4. Is it global or one entity? A single slow slug points at data shape, not the platform.

**Escalation:** Sustained > 1.5s with a slow API → investigate the query/DB. With a fast
API → investigate the SSR render path. Page on-call if user-facing.

---

## High Worker error rate

**Alert:** `AECi — Worker error rate > 1% (1 h)`, same 1% threshold, **hourly**.
**Metric:** combined SSR + API 5xx count / total across both Workers.

> **The cadence change is the one to internalise: 5 min → 1 h is the largest single
> detection-time regression in the migration**, on the highest-severity alert in the set.
> A 5xx spike can now run for up to an hour before anything pages, so
> the Cloudflare Workers dashboard and `wrangler tail` matter more, not less. If that
> proves unacceptable, PostHog's log-alert type supports 5-minute windows without the
> Boost add-on — the upgrade is written up as manual step 4 in
> `observability/posthog/README.md`. One further consideration recorded there: the alert
> keeps the original numerator (`aeci.page.render.duration_ms`, cacheable-render branch
> only); `aeci.ssr.render` fires on **every** branch and would give strictly better
> coverage. It was left alone deliberately — a port should not quietly change what a
> number means — and is worth revisiting once the dual-run confirms parity.

**What it means:** Users are hitting server errors. Highest-severity of the three.

**First checks**

1. Recent deploy? `GET /api/version` on both Workers; if a deploy lines up with the
   spike, consider rolling back (`promote-to-prod` / AECI-71).
2. Read the errors: the logs, `service:(aeci-api OR aeci-web) status:error` — the API
   error handler logs `trace_id` + stack.
3. Which side? Split the error-rate widget by `service`. API-dominant → D1/Drizzle
   or a handler bug. SSR-dominant → render crash or a bad upstream response.
4. Cloudflare platform: check the Workers dashboard for exceptions / CPU-limit errors.

**Escalation:** > 1% sustained is page-worthy. Capture a `trace_id` from the logs before
mitigating so the post-mortem can reconstruct the failure.

---

## Algolia index drift

**Alert:** none. The old `AECi — Algolia index drift (D1 ≠ Algolia)` monitor (value > 0
daily, plus `notify_no_data` @ 48 h) **does not alert any more**. The value half is a
**dashboard** read (PostHog "AECi — Search" → *Algolia index drift and orphan sweep per index*)
because it is report-only and negative drift self-heals; the liveness half becomes the
**CI liveness sweep** (`algolia-drift`, window tightened 48 h → 26 h). The companion
`AECi — Algolia orphan sweep capped` **does** stay a PostHog alert, on merit — it is a
success-with-a-caveat and has its own action (below).
**Metric:** `aeci.algolia.index_drift` — signed `D1 − algolia` count per `entity`/`index`
(AECI-140, §23.1 daily data-quality check). Companion sweep signals:
`aeci.algolia.orphans_removed` / `aeci.algolia.orphans_skipped_cap` (AECI-266; see below).

**What it means:** An Algolia index's object count no longer matches the promoted D1 rows it
should mirror. **Positive** drift = the index is *missing* rows (a sync didn't run or
half-failed). **Negative** = the index holds *orphans* (objects with no promoted D1 row —
hard-deleted/stranded rows the incremental sync structurally can't see to delete). The gauge
captures the **pre-heal** state: right after this report the same 09:00 UTC cron runs the orphan
sweep (`apps/api/src/lib/algolia-orphans.ts`), which deletes the orphans — so **negative drift
self-heals** (AECI-266) and the next day's run reads 0. **Positive** drift is *not* auto-repaired;
it is fixed by the 08:00 incremental sync.

**First checks**

1. Which index, and which sign? The alert is split `by {index}` — note `<env>_products` /
   `_vendors` / `_integrations` and the sign/magnitude (logged with the gauge). Negative =
   orphans (self-healing); positive = missing rows.
2. Recent promotes? Drift right after a `POST /api/promote` is expected until a sync runs.
3. Did the sweep heal it? For negative drift, check **`/admin/system` → Search index → Orphan
   sweep**, which since AECI-583 renders the last 09:00 run's per-index result — orphans found,
   objects removed, and whether the safety cap refused a purge (the `--force` trigger below).
   Before that the sweep reported only as telemetry: `aeci.algolia.orphans_removed` and the
   `source:algolia-drift-cron` log `aeci.algolia.orphans_removed on <env>` for the same run, both
   still emitted. The next day's `index_drift` should read 0.
4. No-data variant: if the alert is "no data for 48h", the daily cron
   (`apps/api/src/scheduled.ts`) didn't report — check the staging/production API Worker's
   scheduled invocation in the Cloudflare dashboard / `wrangler tail`, and that
   `ALGOLIA_APP_ID` / `ALGOLIA_ADMIN_KEY` are set on the Worker.

**Repair**

- **Negative drift (orphans):** normally self-heals via the post-report sweep. If the safety cap
  refused the purge (the `AECi — Algolia orphan sweep capped` alert / a non-zero
  `aeci.algolia.orphans_skipped_cap`), confirm the orphan count is legitimate, then force it. The
  script reads the deployed D1 over `wrangler d1 execute --remote`, so it needs the Cloudflare D1
  token (`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`), **not** `DIRECT_URL`:

  ```bash
  CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… ALGOLIA_APP_ID=… ALGOLIA_ADMIN_KEY=… \
    pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env <staging|production> --apply --force
  ```

  (production also requires `--allow-production`.)
- **Positive drift (missing rows):** repaired by the 08:00 incremental sync — a row updated
  within the watermark window is re-upserted on the next run; a record stuck outside the window
  re-syncs when it is next touched (e.g. re-promoted). The Node bulk-reindex CLI was retired under
  D1 (ADR 0016); a Worker-triggered full re-sync is a tracked follow-up.

To re-check (dry-run, deletes nothing) on demand without waiting for the 09:00 UTC (= 04:00 EST)
cron:

```bash
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… ALGOLIA_APP_ID=… ALGOLIA_ADMIN_KEY=… \
  pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env <staging|production>
```

**Escalation:** if the cap keeps refusing, or orphans reappear every day, that points at a
misconfigured promoted-id read (wrong env/DB) or a churning source; capture the
`source:algolia-drift-cron` sweep logs and page on-call before forcing a large purge.

---

## Algolia sync failed

**Alerts (PostHog, hourly):** `AECi — Algolia sync failed (daily cron)` (a failed push) and
`AECi — Algolia sync not running (no successful cron push)` (the cron stopped firing).
**After AECI-651:** the failure half folds into the **combined** `AECi — Cron job failed (any
daily/hourly job)` alert — read the `label_column` in the breach email to see it was this job —
and it becomes **trigger-agnostic**, so a failed `trigger:promote` sync now alerts too (it did
not in Datadog, which was a gap rather than a decision). The liveness half moves to the **CI
liveness sweep** (`algolia-sync`), whose window is **tightened 48 h → 26 h**.
**Metric:** `aeci.algolia.sync{outcome:failed}` — count of failed entity pushes; the
liveness alert watches `aeci.algolia.sync{outcome:ok,trigger:cron}` instead
(AECI-139 sync; AECI-141 monitors). Companion signals: `aeci.algolia.sync.records`
(`op:saved|deleted`) and `aeci.algolia.sync.duration_ms` per run.

**What it means:** A push to one of the env's Algolia indexes failed — the daily 08:00 UTC
(= 03:00 EST) incremental sync (`trigger:cron`) or the post-promote hook (`trigger:promote`). The affected
index keeps serving stale results until the next successful run; there is **no page-level
symptom**, which is why this monitor exists. On a cron failure the watermark for that entity
is held so the next cron retries it.

**First checks**

1. Which entity / trigger? Pivot the "AECi Phase 3 — Search" dashboard (or the metric) by
   `entity` (products/vendors/integrations) and `trigger`. A `trigger:promote` failure is a
   single promote; a `trigger:cron` failure affects the whole daily window.
2. Read the failure: the logs, `service:aeci-api` — `aeci.algolia.sync` (per-entity, with
   `reason` when failed), `aeci.algolia.sync.crashed` (the run threw before/around the push),
   or `aeci.api.promote.algolia_sync_failed` (promote hook). The `reason` field carries the
   Algolia error.
3. Credentials? Missing `ALGOLIA_APP_ID` / `ALGOLIA_ADMIN_KEY` show as `outcome:skipped_no_creds`
   (a graceful no-op, not a failure) — expected on local/preview, never on staging/production.
4. Algolia status? Check https://status.algolia.com — an Algolia outage surfaces as transient
   push failures that self-heal on the next run.
5. Liveness alert ("sync not running"): this is the no-data variant of the `outcome:ok`
   cron series — the 08:00 UTC (= 03:00 EST) cron (`apps/api/src/scheduled.ts`) hasn't reported a successful
   push for 48h, so it likely isn't firing. Check the staging/production API Worker's scheduled
   invocation in the Cloudflare dashboard / `wrangler tail`. (The "sync failed" alert does not
   use no-data — `outcome:failed` is absent on a healthy run.)

**Repair:** a failed entity is retried by the next daily cron (the watermark wasn't advanced).
To repair immediately, re-run the AECI-138 bulk reindex for the affected env (idempotent upsert):

```bash
pnpm --filter @aeci/api db:algolia-bulk-sync -- --env <staging|production>
```

**Escalation:** failures across multiple consecutive runs with Algolia healthy point at a data
shape / transform regression (`apps/api/src/lib/algolia-sync.ts`) or a rotated admin key — page
on-call and capture a failing `reason` from the logs for the post-mortem.

---

## Home stats stale or compute failed

**Alerts (PostHog, hourly):** `AECi — Home stats compute failed (daily cron)` (one or more `home.*`
keys failed) and `AECi — Home stats not running (no daily compute)` (the cron stopped firing — the
freshness alert). **After AECI-651:** the failure half folds into the **combined** cron-failure
alert (the `label_column` names it), and gains the per-key half that Datadog's stats monitor did
not watch; the freshness half moves to the **CI liveness sweep** (`home-stats`, 26 h).
**Metric:** `aeci.stats.compute.key{outcome:failed}` (failed per-key computes) **+** the job-level
`aeci.stats.compute{outcome:failed}` count — the job-level term covers a pre-compute crash that
emits no per-key points. The freshness/liveness alert watches the `aeci.stats.compute{trigger:cron}`
heartbeat (one point per completed run, any outcome) via `notify_no_data` instead (AECI-178 compute;
AECI-180 monitors).
Companion signals: `aeci.stats.compute{outcome:success|partial|failed}` (job rollup),
`aeci.stats.compute.duration_ms` + `aeci.stats.compute.key.duration_ms` per run.

**What it means:** The daily home-stats compute (`apps/api/src/scheduled.ts` → `lib/home-stats.ts`,
07:00 UTC = 02:00 EST) recomputes the seven `home.*` `stats_cache` rows the home page reads. Each
key computes/validates/upserts independently, so a single failed key leaves **that** cached value
stale (or absent) while the rest refresh — e.g. a failed `home.trending_products` keeps yesterday's
list. The home page never errors; it just serves the last good numbers. The "not running" freshness
alert means no completed run reported in ~26h — a **missed daily run**, so `computed_at` for the
`home.*` keys is going stale with no page-level symptom.

**First checks**

1. Which alert? "Compute failed" → the cron ran (or crashed pre-compute) and reported a failure: a
   key threw/failed validation, or the whole job crashed before any key ran. "Not running" → no
   completed run reported at all in ~26h (freshness). A pre-compute crash trips "Compute failed" (via
   the job-level `aeci.stats.compute{outcome:failed}`) but not "Not running" — the crash still emits
   the liveness heartbeat. "Not running" fires only when the cron never reports (it never fired, or
   never reached even the crash path), in which case there's no failure metric and "Compute failed"
   stays silent.
2. Which key? `aeci.stats.compute.key{outcome:failed}` is per key — pivot the "AECi Phase 4 — Home /
   Stats" dashboard by `key`, and read the logs, `service:aeci-api source:stats-cron`
   (`aeci.stats.compute <key> status=failed`, with `reason`; `aeci.stats.compute.crashed` is a
   pre-compute throw before any key ran).
3. DB health: the job reads/writes Cloudflare D1 via the Worker's `DB` binding. A D1 outage or a
   missing/misconfigured `DB` binding surfaces as `aeci.stats.compute.crashed` (pre-compute) or many
   failed keys — check the Cloudflare D1 dashboard and the Worker's `DB` binding (`apps/api/wrangler.jsonc`).
4. Recent deploy? A regression in `lib/home-stats.ts` (a producer) or a `stats_cache` schema drift
   that fails the shared `statsCacheValueSchemas` validation shows as `outcome:failed` with a
   `validation failed: …` reason. Correlate with `GET /api/version`.
5. "Not running" only: confirm the 07:00 UTC cron fired — check the staging/production API Worker's
   scheduled invocation in the Cloudflare dashboard / `wrangler tail`, and that the `STATS_QUEUE`
   binding + the `0 7 * * *` trigger are present (`apps/api/wrangler.jsonc`, staging + production
   only). (The "compute failed" alert does **not** use no-data — `outcome:failed` is absent on a
   healthy run.)

**Repair:** there is no manual trigger endpoint yet (ADR 0013 leaves a future REST/queue producer
out of scope). Fix the root cause; the **next daily cron self-heals** — `computed_at` advances and
the stale rows refresh on the next successful run. A failed key does not block the others, so a
single flaky key needs no immediate action beyond confirming it recovers next run.

**Escalation:** repeated failures of the same key across consecutive days (DB healthy) point at a
producer regression in `apps/api/src/lib/home-stats.ts` or a `stats_cache`/schema drift — page
on-call and capture a failing `reason` from the logs for the post-mortem. A persistent "not running"
alert with a healthy Worker is a cron/queue wiring problem (see check 5).

---

## Page-view writes failing

**Alert:** `AECi — page_views write error rate > 10% (1 h)` — PostHog, hourly. Same 10%
threshold as the retired 10-minute Datadog monitor, plus a **≥20-write minimum-denominator floor**
(`if(total >= 20, ratio, 0.0)`), so a quiet hour reads 0 instead of paging on one failure out of
three.
**Metric:** `aeci.pageviews.write{outcome:failed}` / `aeci.pageviews.write` (all) — the failed-insert
ratio over 10m (AECI-177 write; AECI-180 monitor). Companion signal: the `aeci.api.page_view.capture_failed`
log carries the `reason`.

**What it means:** `POST /api/page-views` validates the body, returns **204 immediately**, and
inserts one `page_views` row via `ctx.waitUntil()`. A failing insert is **user-invisible** (the 204
already went out) — but `page_views` is the **only** source for `home.trending_products`, so a
sustained insert regression silently **zeroes trending** at the next 07:00 UTC daily compute. This
monitor exists to surface the regression *before* the home page changes. (Distinct from "Home
stats compute failed": there the compute job breaks; here the upstream data the compute reads stops
arriving.)

Since AECI-280 the home never goes truly *blank*: an empty `home.trending_products` (whether from a
write regression **or** simply because no product cleared the `TRENDING_MIN_VIEWS` floor — currently 3 —
in a low-traffic window) falls back to the "Recently added products" grid. That fallback is by design,
but it also **masks a write regression visually** — which is exactly why this write-rate metric, not the
home's appearance, is the alerting signal. Corollary when triaging: a short or empty trending card is
**not** on its own evidence of a page-views regression; confirm against `aeci.pageviews.write{outcome:failed}`.

**First checks**

1. Read the failure: the logs, `service:aeci-api source:page-views` —
   `aeci.api.page_view.capture_failed` carries the `reason` (the D1/Drizzle error).
2. DB health: the insert goes to Cloudflare D1 via the Worker's `DB` binding. A D1 outage or a
   missing/misconfigured `DB` binding surfaces as a broad failure spike — check the Cloudflare D1
   dashboard and the Worker's `DB` binding.
3. Recent deploy? A regression in `apps/api/src/routes/page-views.ts` (or a `page_views` schema
   drift — a column/type the insert writes that no longer matches the table) shows as a step-change
   in the error rate. Correlate with `GET /api/version`.
4. All writes or a subset? If only entity pages fail, suspect `resolveEntity` (the product/vendor
   PK lookup) or an FK constraint; if every write fails, suspect the DB connection / schema.

**Repair:** fix the root cause (DB connectivity, a reverted bad deploy, or a schema mismatch). Writes
resume immediately — there is no backfill: views during the outage are lost, and the next daily
compute reflects whatever `page_views` holds at 07:00 UTC. If trending already zeroed, it self-fills
once writes resume and the next compute runs.

**Escalation:** a sustained > 10% error rate with the DB healthy points at a `page-views.ts` /
schema regression — page on-call, capture a `reason` from the logs, and consider rolling back the
correlated deploy. (The 10% threshold is a pre-launch starting point — see `docs/OBSERVABILITY.md`;
retune once production traffic is known.)

## page_views duplicate PK (prod data corruption) — historical (Postgres only)

> **No longer applicable.** This runbook is Postgres-specific (`BIGSERIAL` PK, sequences, `pg_dump`/`pg_restore`). `page_views` now lives in **Cloudflare D1** (ADR 0016), and `refresh-staging.yml` no longer does any `pg_dump`/restore (it was gutted in AECI-278). The symptom below can no longer occur. Kept for historical reference only.

**Symptom (historical):** the `refresh-staging` workflow failed at the **"Restore prod data into staging"** step
with:

```
pg_restore: error: could not create unique index "page_views_pkey"
DETAIL:  Key (id)=(N) is duplicated.
```

**What it means:** prod's `page_views` table physically contains rows with duplicate `id` values.
`page_views.id` is a `BIGSERIAL PRIMARY KEY` (`page_views_pkey`), so this is only possible if that
unique index is **not enforced in prod** (never created, dropped, or left `INVALID`). The `pg_dump`
COPY stream carries the dups verbatim; on restore, pg_restore loads the rows and then can't rebuild
the PK. (The app insert path — `apps/api/src/routes/page-views.ts` — never sets `id` explicitly; it
relies on the sequence default, so the corruption is a DB-level constraint/sequence problem, not an
application bug.)

**Why `refresh-staging` no longer breaks on it:** the "Dump prod" step excludes `page_views` *data*
(`--exclude-table-data='public.page_views'`) — the table structure still transfers and staging
self-heals from its own captured views. This runbook covers cleaning up the **prod** corruption,
which the exclusion only sidesteps.

**Repair (one-off, against prod via `DIRECT_URL_PRODUCTION`):** confirm the damage, dedup keeping the
newest row per id, re-sync the sequence, then (re)assert the PK so it can't recur.

```sql
-- 1. Confirm: which ids are duplicated, and is the PK actually enforced?
SELECT id, count(*) FROM page_views GROUP BY id HAVING count(*) > 1 ORDER BY id;
SELECT conname, convalidated FROM pg_constraint
  WHERE conrelid = 'public.page_views'::regclass AND contype = 'p';

-- 2. Dedup: keep one physical row per id (ctid is the physical row pointer).
DELETE FROM page_views a
  USING page_views b
  WHERE a.id = b.id AND a.ctid < b.ctid;

-- 3. Re-sync the BIGSERIAL sequence to max(id) so new inserts don't collide.
SELECT setval(pg_get_serial_sequence('public.page_views', 'id'),
              COALESCE((SELECT max(id) FROM page_views), 1));

-- 4. If the PK was missing/invalid, (re)create it so dups can't return.
--    (Skip if step 1 showed a valid page_views_pkey already present.)
ALTER TABLE public.page_views
  ADD CONSTRAINT page_views_pkey PRIMARY KEY (id);
```

**Verify:** re-run step 1 (no rows from the `HAVING` query; `convalidated = t`). After cleanup, the
`--exclude-table-data` guard in `refresh-staging` is belt-and-suspenders and can stay — staging has no
need for prod's eyeball-analytics rows regardless.

**Escalation:** if the dedup count is large or the PK can't be created because dups remain, stop and
investigate how unconstrained writes happened (a prod migration that didn't apply the baseline PK, or
a manual/restore load that bypassed it) before forcing the constraint.

---

## Auth sign-in error-rate spike

**Alert:** `AECi — Auth sign-in error rate > 30% (1 h)` — PostHog, hourly. Same 30%
threshold as the retired 15-minute Datadog monitor, plus a **≥5-attempt floor**. The floor is
new and deliberate: at current volume one failed sign-in out of two is 50% and would have
paged. Datadog's shorter window had the same exposure and simply got lucky.
**Metric:** `aeci.auth.signin{outcome:failed}` / `aeci.auth.signin` (all) — the failed-completion ratio
over 15m, `service:aeci-web` (AECI-206). `attempts = sum over outcomes`; failure `reason` ∈
`link_invalid` / `missing_code` / `auth_not_configured`.

**What it means:** A high share of sign-in *completions* at `/auth/callback` are failing. This is the
**SSR Worker** (`apps/web`), not the API. It is usually a config/provider problem, not user error:
a broken callback/redirect URL, a misconfigured or paused Supabase project, or a Google OAuth outage.
(Browser-side *initiation* — the magic-link send and the OAuth redirect-out — is a deferred RUM signal,
so a user who never returns to the callback isn't counted here.)

**First checks**

1. Which method / reason? Pivot the "AECi Phase 5 — Auth/Reviews" dashboard sign-in widgets by `method`
   (`google` / `magic_link`) and `reason`. A `google`-only spike points at OAuth (provider / client-id /
   redirect-URI); a both-methods spike points at the callback handler or Supabase project itself.
2. Read the failures: the logs, `service:aeci-web` around `/auth/callback`.
   - `reason:auth_not_configured` → the env has no Supabase config (`window.__AECI_SUPABASE__` / the
     server client). Check the SSR Worker's Supabase vars/secrets for that env.
   - `reason:link_invalid` → expired/reused magic link, user-denied OAuth, or a failed PKCE
     `exchangeCodeForSession` (clock skew, a rotated Supabase anon key, a redirect-URI mismatch).
   - `reason:missing_code` → callers hitting `/auth/callback` with no `code` (a broken redirect URL or a
     crawler) — confirm the configured Supabase redirect URLs match the deployed origin.
3. Recent deploy? Correlate with `GET /_version` on the SSR Worker — an `apps/web` auth change
   (`auth.service.ts` / `auth-callback.ts`) or a changed redirect URL lines up with the step-change.
4. Provider/platform: check Google Cloud OAuth consent/credentials and https://status.supabase.com.

**Escalation:** a sustained spike not explained by a single expired-link burst is page-worthy — sign-in
is the gate to every authenticated write (reviews, account, admin). Capture a failing `reason` from the
logs. (The 30% threshold is a pre-launch starting point — see `docs/OBSERVABILITY.md`; at low volume a
single failure can dominate the ratio. Retune once production traffic is known.)

---

## Toxicity scoring outage

**Alert:** `AECi — Toxicity scoring outage (> 50% errors, 1 h)` — PostHog, hourly. Same 50%
threshold as the retired 15-minute Datadog monitor, plus a **≥5-call floor**.
**Metric:** `aeci.toxicity.api{outcome:failed}` / `aeci.toxicity.api` (all) over 15m; failure
`reason` ∈ `http_error` / `malformed` / `timeout` / `network`. Companion: `aeci.toxicity.api.duration_ms`
(latency) and the `service:aeci-api source:toxicity` warn logs.

**What it means:** Anthropic Claude (review toxicity scoring, `lib/toxicity.ts`, AECI-258 — supersedes the
sunsetting Perspective API of AECI-198) is failing for most calls. Scoring is **fail-open and
flag-never-block**: a failed score stores `toxicity_score = null` and the review **still enters the
moderation queue** — so this is **not user-facing** and does **not** block submissions. The cost is that
the moderation queue temporarily loses its triage signal (the worst content no longer floats to the top
of `/admin/reviews`).

**First checks**

1. Which reason? Pivot the "AECi Phase 5 — Auth/Reviews" dashboard toxicity widgets / the metric by
   `reason`. `timeout`-dominated → the model is slow (the client caps at 4s); `http_error` → non-2xx
   (rate-limit/`429`, auth/`401`/`403`); `network` → connectivity or a body that won't parse; `malformed` →
   a 200 whose reply had no parseable integer (a prompt/response-shape change).
2. Read the failures: the logs, `service:aeci-api source:toxicity`, carry the message + status.
3. Credentials/quota? A **missing** `ANTHROPIC_API_KEY` is a silent no-op that emits **no** metric (so it
   can't trip this alert) — but a *revoked/over-quota* key shows as `http_error` `401`/`403`/`429`. Check
   the key and the Anthropic Console usage limits.
4. Provider status: an upstream Anthropic outage self-heals; confirm via https://status.anthropic.com.

**Repair:** none required for correctness — submissions keep working with `toxicity_score = null`. Once
scoring recovers, **new** submissions score normally; reviews submitted during the outage keep their null
score (there is no backfill — they're triaged manually in the queue). If the cause is a bad/revoked key or
exhausted quota, rotate the key / raise the limit and redeploy the secret.

**Escalation:** a prolonged outage isn't urgent (fail-open), but flag it so moderators know the queue's
toxicity ordering is degraded until it clears. A persistent `malformed` reason with Anthropic healthy
points at a prompt/response-shape change — open a follow-up against `lib/toxicity.ts`. (The 50% threshold
is a launch-tunable starting point — see `docs/OBSERVABILITY.md`.)

---

## Moderation queue backlog

**Alert:** none. The old `AECi — Moderation queue backlog (oldest pending > 48h)` monitor
(threshold plus a `notify_no_data` cron-liveness check) was retired with the Datadog plane.

> **The backlog does not alert.** It is a **dashboard** read
> (PostHog "AECi — Auth / Reviews / Moderation" → *Moderation queue depth and oldest pending
> age*), and the liveness half moves to the **CI liveness sweep** (`moderation-snapshot`, 26 h).
> That is a deliberate call — a chronic backlog is a staffing/process issue, not an incident —
> but it means **nobody is paged about it**, so it has to be *looked at*. It is a row in the
> daily pass in `POST_LAUNCH_MONITORING.md` §1 for exactly that reason.
**Metric:** `aeci.moderation.queue_oldest_age_hours` (gauge) — age of the oldest `status='pending'`
review; companion `aeci.moderation.queue_depth`. Snapshotted daily by the API Worker cron at 06:00 UTC
(= 01:00 EST), `lib/moderation-metrics.ts` (AECI-206). 0 for an empty queue.

**What it means:** A review has been waiting for moderation longer than the SLA threshold (48h) — the
backlog isn't being worked. Unlike the per-action `aeci.moderation.action` count, this gauge is a
**standing-state** signal: it exists precisely so a forgotten queue surfaces even when **no admin is
moderating** (when nothing fires the action metric). The reviews are invisible to the public until
approved, so there's no page-level symptom — just submitters waiting.

**First checks**

1. Which alert? **Threshold** (`> 48h`) → the queue is backing up; work it. **No-data** → the 06:00
   snapshot cron stopped (see check 3) — the age signal is stale, which is itself a problem.
2. Work the queue: open `/admin/reviews` (default = pending, oldest-first / `queue_age`) and
   approve/reject the oldest items. The gauge drops at the next 06:00 snapshot (or immediately reflects
   on the dashboard's `queue_depth` once you reload, but the **alert** clears on the next daily point).
   Pivot the dashboard "Moderation queue" widget for the depth + age trend.
3. No-data variant: confirm the 06:00 UTC cron fired — check the staging/production API Worker's
   scheduled invocation in the Cloudflare dashboard / `wrangler tail`, and that the `0 6 * * *` trigger is
   present (`apps/api/wrangler.jsonc`, staging + production only). The moderation job runs **inline** (no
   queue), so there's no `MODERATION_QUEUE` binding to check — only the trigger and the Worker's
   `DB` binding (a D1/Drizzle failure logs `aeci.moderation.queue.crashed`, `source:moderation-cron`).

**Repair:** there is no auto-remediation — moderators clear the backlog via `/admin/reviews`. The gauge
self-resolves to 0 once the queue is empty. A persistent no-data with a healthy Worker is a cron/trigger
wiring problem (check 3).

**Escalation:** a chronic backlog is a **staffing/process** issue, not an engineering one — route it to
whoever owns moderation rather than on-call. (The 48h threshold and the daily snapshot cadence — which
adds up to ~24h detection lag — are pre-launch starting points; see `docs/OBSERVABILITY.md`. Move the
cron to hourly if a tighter SLA is needed.)

---

## Linear pipeline failure (issue creation / sync)

**Alert:** `AECi — Linear pipeline failure rate > 50% (1 h)` (AECI-219 / Phase 6.12) —
PostHog, hourly. Window and 50% threshold **unchanged** from the Datadog original (it already
used 1 h, so only the evaluation cadence moved), plus a **≥3-attempt floor**. Traffic-driven, so
deliberately **no** `notify_no_data` — no submits/resolves (and the absent-key no-op) emit nothing, so
zero is the healthy pre-launch state.
**Metric:** the combined failure **rate** of the two outbound Linear write paths over **terminal**
attempts — `aeci.linear.issue{outcome:failed}` (request→Linear creation, §6.4) + `aeci.linear.sync{outcome:failed}`
(admin resolve/reject site→Linear push, §6.6), divided by the same metrics excluding `skipped_exists` /
`skipped_no_issue` (idempotent re-fires and no-op pushes aren't attempts and must not dilute the ratio).
Companion latency: `aeci.linear.issue.duration_ms`, `aeci.linear.sync.duration_ms`.

**What it means:** a **systemic** break in the Linear pipeline — most creations/syncs are failing, not a
one-off. Usual causes: a missing/revoked/over-scoped `LINEAR_API_KEY`; drifted board/label/assignee/project
ids in `lib/linear.ts`; or Linear itself being down. This is the **early-detection** complement to the
reconciliation `persistent stuck requests` alert (the per-row backstop that only fires after the ~60m
persistent threshold), and it is the **only** alert covering the **sync** path — a failed resolve/reject
has no reconciliation retry, so Linear silently diverges from Supabase until someone notices.

**First checks**

1. **Which path?** Pivot the 'AECi Phase 6 — Requests/Moderation' dashboard (or Metrics Explorer) to
   split `aeci.linear.issue{outcome:failed}` vs `aeci.linear.sync{outcome:failed}`. Both failing → a
   shared cause (key/Linear outage). Only `sync` failing → likely a state/transition-id problem specific
   to the resolve/reject push.
2. **Why?** Pivot the failing metric by `reason`: `http_error 401/403` → `LINEAR_API_KEY` missing/revoked/
   over-scope (`wrangler secret list` on the Worker); `graphql_error` → a bad label/assignee/project/state
   id — the board constants in `lib/linear.ts` drifted from Linear; `timeout`/`network` → Linear is
   slow/down (check the Linear status page); `db_error` → the Linear call succeeded but the link-back /
   `workflow_transition` write failed. Read `service:aeci-api` logs for detail.
3. **Blast radius:** for the creation path, failures land in the reconciliation sweep — check
   `aeci.linear.reconcile.stuck` for the growing backlog. For the **sync** path there is no backstop, so
   list recently resolved/rejected requests and confirm their Linear issues actually transitioned.

**Repair:** fix the root cause and the creation path self-heals via the next 15-min sweep (idempotent —
never double-creates). For a bad/revoked key, rotate it and re-push the secret + redeploy. For drifted
board ids (`graphql_error`), correct the constants in `lib/linear.ts` and redeploy. For a Linear outage,
no action — it clears when Linear recovers. **Sync-path failures don't auto-heal:** after the root cause
is fixed, manually re-resolve/reject the affected requests in `/admin/requests` (idempotent) to re-push
their Linear transitions, or fix them directly in Linear (the §6.3 inbound webhook then syncs the status
back).

**Escalation:** route a sustained pipeline failure to whoever owns the Linear integration. A revoked key
or drifted board ids are config issues (fix + redeploy); a Linear outage is vendor-side (monitor + wait).
The 50% threshold + 1h window are launch-tunable starting points (`docs/OBSERVABILITY.md`).

---

## Linear webhook HMAC failures

**Alert:** `AECi — Linear webhook HMAC failures > 3 (1 h)` (AECI-219 / Phase 6.12) —
PostHog, hourly. **Unchanged from the Datadog original in every respect except evaluation
cadence.** It stays
its own alert rather than folding into the combined cron-failure one, because it is a **security**
signal, not a job signal. Deliberately **no** `notify_no_data` — a bad signature is the only thing that emits this, so zero is healthy.
**Metric:** `aeci.webhooks.linear.hmac_failure` (count) — emitted by `POST /api/webhooks/linear`
(`routes/webhooks.ts`, AECI-212 / Phase 6.5) when the `Linear-Signature` header is missing or doesn't
match `LINEAR_WEBHOOK_SIGNING_SECRET`. The request is rejected **401 before any write** (fail-closed).
Companion: `aeci.webhooks.linear.receipt` (the verified-receipt throughput).

**What it means:** inbound Linear webhooks are bouncing signature verification. Two shapes: **(a)
mis-config** — the signing secret was rotated in Linear's webhook settings but the Worker's
`LINEAR_WEBHOOK_SIGNING_SECRET` wasn't re-pushed (or vice-versa); legitimate Linear deliveries are now all
401ing, so the **Linear → Site status sync silently stops** (admins resolving in Linear won't reflect on
the site). **(b) probing/replay** — someone is POSTing to the public endpoint with a bad/again signature.
The fail-closed 401 means **no data was written** either way; the risk in (a) is the lost sync, not a breach.

**First checks**

1. **(a) or (b)?** Check `aeci.webhooks.linear.receipt` over the same window: if verified receipts
   **dropped to zero** at the moment HMAC failures spiked, it's a **secret mismatch** (legit traffic is
   bouncing) — NOT an attack. If receipts are still flowing normally alongside the failures, it's external
   probing hitting the endpoint.
2. **Diff the secret:** compare the signing secret in Linear's webhook config (Linear → Settings → API →
   Webhooks) against the Worker's `LINEAR_WEBHOOK_SIGNING_SECRET` (`wrangler secret list` on
   `aeci-api-<env>`). A recent rotation on one side is the usual culprit.
3. **Read the source:** `service:aeci-api` logs around the endpoint show the request origin — confirm
   whether deliveries are coming from Linear or an unknown source.

**Repair:** for a mismatch, re-push the correct `LINEAR_WEBHOOK_SIGNING_SECRET` and redeploy — Linear
retries failed webhook deliveries, and the inbound webhook + the §6.4 reconciliation sweep are the two
directions of the same sync, so state re-converges. For external probing, no app change is needed (the
endpoint already fails closed); escalate to WAF rate-limiting on the public request endpoints if it's
abusive — that's a Phase 7 handoff item (§14).

**Escalation:** a secret mismatch is a config fix (owner of the Linear integration); persistent probing is
a security concern (route to whoever owns WAF/edge). The >3-per-hour threshold is a launch-tunable starting
point (`docs/OBSERVABILITY.md`).

---

## Linear reconciliation — stuck requests

**Alert:** `AECi — Linear reconciliation: persistent stuck requests` (PostHog, hourly). Two
Datadog monitors used to share this runbook — that one
(the persistent-failure signal; deliberately **no** `notify_no_data` — the count is emitted only when the
failure condition holds, so zero points is healthy) and its liveness companion `AECi — Linear
reconciliation sweep not running` (AECI-219 / Phase 6.12; a `notify_no_data` check on the always-emitted
`aeci.linear.reconcile.stuck` gauge — no point for ~1h ≈ 4 missed sweeps means the cron itself stalled).

> **After AECI-651** the persistent-failure half stays its **own** PostHog alert rather than folding
> into the combined cron-failure one — the sweep is healthy; a **user-visible vendor request** is
> stuck, and the operator action is to open that request, not to restart a job. The liveness half
> moves to the **CI liveness sweep** (`request-reconcile`), whose window is **relaxed 60 → 90 min**.
> The extra 30 minutes is margin for the *sweep's own* lateness, not the job's — the sweep runs every
> 3 hours, so a 60-minute allowance would false-positive on the checker rather than the checked.
**Metric:** `aeci.linear.reconcile.persistent_failure` (count) — requests stuck past the persistent
threshold (~60m) AND still failing after a retry; companion `aeci.linear.reconcile.stuck` (backlog
gauge) and `aeci.linear.reconcile.attempt` (`outcome:cleared|still_failing`). Emitted by the
reconciliation sweep, `lib/reconciliation-sweep.ts` (AECI-214 / Phase 6.7), every 15 min. The
`level:error` `source:reconcile` log carries the stuck `request_ids`.

**What it means:** A claim/correction was submitted but its Linear issue was never created — the §6.4
on-submit `createLinearIssueForRequest()` failed, and the §6.7 sweep has retried it for >~1h without
success. The `vendor_requests` row is sitting `open` / `linear_issue_id = null`. It is **not lost** —
it is visible in `/admin/requests` and being retried every 15 min — but the assignee (Chris/Bill) was
never notified by Linear, so it needs a human. **Not user-facing:** the submitter got their `201` and
"we'll follow up" message; the gap is internal routing.

**First checks**

1. **Which alert?** `sweep not running` (no-data) → the every-15-min sweep stalled outright; the backlog
   gauge `aeci.linear.reconcile.stuck` stopped reporting. `persistent stuck requests` → the sweep is
   running but a request is genuinely stuck. Either way, confirm the sweep is running: if the backlog
   gauge has flat-lined / stopped reporting, check the API Worker's scheduled invocations / `wrangler
   tail`, confirm the `*/15 * * * *` trigger is present in `apps/api/wrangler.jsonc` (staging +
   production only) and the `aeci-reconcile-<env>` queue + consumer exist. A stalled sweep means stuck
   rows aren't being retried (the §6.2 backstop is down).
2. Why is creation failing? Read the `service:aeci-api source:reconcile` error log for the
   `request_ids`, then pivot `aeci.linear.issue{outcome:failed}` by `reason`: `http_error 401/403` →
   the `LINEAR_API_KEY` is missing/revoked/over-scope (a **missing** key is a silent no-op that emits
   no `aeci.linear.issue` metric, but the sweep still counts the row as stuck — confirm the secret is
   set on the Worker); `graphql_error` → a bad label/assignee/project id (the board constants in
   `lib/linear.ts` drifted from Linear); `timeout`/`network` → Linear is slow/down; `db_error` → the
   issue was created but the link-back write failed (re-running links it).
3. How many / how old? `aeci.linear.reconcile.stuck` is the backlog size; the log's `request_ids` and
   `/admin/requests` (age column) show which.

**Repair:** fix the root cause and the next 15-min sweep self-heals (the retry is idempotent — it never
double-creates). For a bad/revoked `LINEAR_API_KEY`, rotate it and re-push the secret. For drifted
board ids (`graphql_error`), correct the constants in `lib/linear.ts` and redeploy. For a Linear
outage, no action — it clears when Linear recovers. If a single row is un-rebuildable (its target
product/vendor was deleted, or it has no workflow instance — logged `cannot rebuild request <id>`),
resolve it manually in `/admin/requests`.

**Escalation:** the admin email seam (`lib/admin-alert.ts`) now sends via Resend (AECI-240 / Phase 7.5)
to `ADMIN_ALERT_EMAIL` (`aeci.linear.reconcile.email{outcome:sent|failed|skipped}`), but it is fail-open:
when `RESEND_API_KEY` / `ADMIN_ALERT_EMAIL` are absent the outcome is `skipped`, so **this alert +
the `/admin/requests` queue remain the guaranteed notification** (§6.2). Make sure on-call routes a
persistent failure to whoever owns the Linear pipeline. (The 15-min cadence + ~60m persistent threshold are launch-tunable —
see `docs/OBSERVABILITY.md` and the constants in `lib/reconciliation-sweep.ts`.)

---

## Data quality job failed or not running

**Alerts (PostHog, hourly):**
- `AECi — Data quality check found ERROR-severity issues (by check)` — an integrity check (`broken_integration_refs`, `reviews_missing_anonymized_at`) found defects. **Pages.**
- `AECi — Data quality check found WARN-severity issues (by check)` — a hygiene check found issues. **Informational / non-paging** (AECI-279 severity split; the digest carries the rows).
- `AECi — Data quality job failed (daily cron)` — a check threw or a pre-run crash.
- `AECi — Data quality job not running (no daily run)` — the cron stopped firing.

**After AECI-651** the four split four ways, and the split is worth knowing before you triage:

- **ERROR severity stays its own PostHog alert** — the job **succeeded**; the DATA is wrong.
  Different runbook entirely (triage the finding, don't restart the job). It also gets *better*:
  the query uses `max(abs(value))`, so a check that **threw** (sentinel `-1`) now fires. Datadog's
  `max(...) > 0` could not see a thrown check — a real hole, closed in the port.
- **WARN severity stops alerting** — dashboard ("AECi — Cron health & retention" → *Data quality —
  findings by check and severity*) plus the daily digest, which already carries the rows.
- **"Job failed" folds into the combined** cron-failure alert; the `label_column` names it.
- **"Not running" moves to the CI liveness sweep** (`data-quality`, 26 h).

**Metrics:**
- `aeci.data_quality.check{check:<id>}` — per-check issue count (0 = clean; **-1** = the check threw).
- `aeci.data_quality.job{outcome:failed}` — run-level failure heartbeat.
- `aeci.data_quality.job{trigger:cron}` — liveness heartbeat (one per completed run).
- `aeci.data_quality.email{outcome:…}` — digest delivery (sent / failed / skipped).

**What it means:** The daily 04:00 UTC §23.1 data-quality job (AECI-241 / Phase 7.6) ran the ten
read-only integrity checks (orphan products/vendors, products stuck `ready` >30d, integrations pointing
at a pulled product, anonymized reviews missing `anonymized_at`, stale `stats_cache`, duplicate
vendor/product candidates, a Brandfetch logo-404 sample, and the reused AECI-140 Algolia drift). The job
**does not auto-repair** — humans triage. The email digest to Chris + Bill carries the offending rows.

**First checks**

1. **Which check?** The "found issues" alerts are split `by {check}` **and by `severity:`** — the
   **error** monitor pages, the **warn** monitor is informational (AECI-279). Pivot on the `check:` tag
   (or read the digest) to see the specific check and its count. The full offending rows are in the email and in
   the `source:data-quality-cron` logs (`aeci.data_quality.check <id> count=…`).

   **Since AECI-583, start at `/admin/system` instead.** The run stores its whole result set in
   `job_runs.detail`, and the page opens on it — same rows the email carried, no inbox needed, no
   `?recompute=1` click, and stamped with the run's own time so you can tell a stale result from a fresh
   one. "Run data-quality checks" re-runs the suite live once you have made a fix. The stored history
   also makes "when did `broken_integration_refs` start failing" answerable, which it was not before.
2. **A check errored (-1 / job failed)?** Read the `source:data-quality-cron` error logs
   (`aeci.data_quality.check <id>` with `reason`, or `aeci.data_quality.crashed` for a pre-run crash).
   A pre-run crash is usually a missing `DB` binding or a deploy regression — check `GET /api/version`.
3. **No-data (job not running)?** The cron isn't firing. Check the staging/production API Worker's
   scheduled invocation in the Cloudflare dashboard / `wrangler tail` (`source:data-quality-cron`), and
   that the `aeci-data-quality-<env>` queue exists.
4. **Digest not received?** If the run fired (metrics present) but Chris + Bill got no email, check
   `aeci.data_quality.email{outcome}`: `skipped` = `RESEND_API_KEY` / `DATA_QUALITY_EMAIL_FROM` /
   `DATA_QUALITY_EMAIL_TO` not set on the Worker (fail-open by design); `failed` = a Resend error — check
   the `source:data-quality-cron` log for the HTTP status and Resend's delivery log.

**Repair:** report-only — triage the digest and fix the underlying data (promote a stuck product, remove
a pulled product's integration, dedupe a vendor, re-run the Algolia bulk sync for drift, etc.); the next
daily run auto-detects the fix. A no-data/liveness failure is a Worker scheduling issue — escalate to
whoever owns the API Worker's crons.

## Cron runs missing or stuck in flight on `/admin/system`

**Alerts:** none of its own — this is a *triage* entry for what you see on the panel. The paging
signals remain the per-cron `… not running` / `… failed` monitors listed in
`POST_LAUNCH_MONITORING.md` §1a.

**Metrics:**
- `aeci.job_runs.write{phase,job,outcome}` — the **recorder's** own health (AECI-583). `outcome:failed`
  means a bookkeeping write failed; the job itself was unaffected.
- Each cron's existing liveness heartbeat (see the table in `OBSERVABILITY.md`).

**What it means:** Every cron writes a `job_runs` row on entry and completes it on exit
(`DATABASE_SCHEMA.md` §9.4). `/admin/system` renders the newest row per job. Three states are worth
telling apart, and the screen distinguishes them on purpose:

| On screen | Means |
|---|---|
| **Unknown** | No row at all. Either the job has not run **since run recording shipped**, or it was added since. This is *not* the same as "not running" |
| **Inferred** | No row, but a `stats_cache` side effect gives a plausible last-run time (`home-stats`, `algolia-sync` only). Proves the job **ran**, never that it **succeeded** |
| **In flight** | A row with `started_at` and no `finished_at`. Either genuinely mid-run, or the isolate was reclaimed (CPU/wall-clock limit, eviction) and never completed it |

**First checks**

1. **Unknown, and the job should have run by now?** Check the **heartbeat metric** *first* — it is
   the only thing that can distinguish "the cron never fired" from "the cron fired and the
   bookkeeping write failed". That means the CI liveness sweep's last run (and the same
   series on the PostHog "Cron health & retention" dashboard). If the heartbeat is present, look for `aeci.job_runs.write{outcome:failed}` and the
   `source:job-runs` error log `aeci.job_runs.write_failed`.
2. **In flight, and the stamp is older than the job's cadence?** (Quarter-hourly reconcile: >30 min.
   A daily job: >6h.) The run was interrupted. Confirm against the job's own `*.crashed` log and the
   Cloudflare invocation log. **Nothing self-heals a stale open row** — the next run simply writes a
   newer one and supersedes it. Since AECI-584 the 03:00 retention prune does eventually remove it,
   but only once it falls outside the 90-day `job_runs` window, so it is no help in the moment. A
   stale open row is cosmetic; the *newest* row is what the screen reports.
3. **A `*/15` job with several `failed` rows then an `ok`?** That is a queue retry working as
   intended. Each attempt is its own row; the successful one supersedes by `started_at`.
4. **All ten Unknown right after a deploy?** Expected for up to 24h on the daily jobs — they have
   not run yet under the new deploy. The `cron_liveness_unavailable` note on the response says how
   many, and the note clears itself as the rows arrive.

**Repair:** nothing here is repaired by hand. A genuinely-not-firing cron is a Worker scheduling
issue — escalate to whoever owns the API Worker's crons, exactly as for the individual cron runbooks
above. A failing *recorder* (`aeci.job_runs.write{outcome:failed}`) degrades the panel only: the
bookkeeping is failure-isolated by design, so the jobs keep running and the alerts keep firing. Treat
it as a defect to file, not an incident to page on.

## Metrics snapshot missing or incomplete

**Alerts:** **none — this cron never got a dedicated monitor** (`PHASE_8_COMPLETION.md` §F5).
It is watched by the CI liveness sweep (`metrics-snapshot`), but has no threshold alert, and it
was the worst gap to have: the job is **queue-less**, so a failed run is never retried, and a
missed day's *stock* metrics are **unrecoverable**. Today you find out from `/admin/system` (the
`metrics-snapshot` row), from a hole in an admin chart, or — worst case — from the 03:00 retention
prune skipping because of the gap.

> **The PostHog port closes this gap without anyone filing an issue for it.** `metrics-snapshot`
> is one of the six previously-unwatched crons picked up by the combined
> `AECi — Cron job failed (any daily/hourly job)` alert (its `aeci.metrics_snapshot.run{outcome:failed}`
> heartbeat is in the query, and the `label_column` names it), **and** it is one of the twelve crons
> in the CI liveness sweep's registry (`observability/posthog/project-config.json`, 26 h window).
> So after AECI-651 both halves — "it failed" and "it never ran" — are covered. Until then,
> `/admin/system` and the `aeci.metrics_snapshot.run` series remain the only signals, and the
> sweep is **already running**, so its red is worth reading even during the dual-run.

**Metrics:**
- `aeci.metrics_snapshot.run{outcome:ok|partial|failed}` — one per completed run; the always-emitted
  series is the liveness signal. Note `partial` exists **here but not in `job_runs`**, which records
  a partial run as `failed` (§7.2) — the metric is the finer-grained view.
- `aeci.metrics_snapshot.metric{metric,outcome:written|failed}` — per-key, 19 keys per run. This is
  what tells you *which* series is broken.
- `aeci.metrics_snapshot.run.duration_ms` — run duration.
- `aeci.metrics_snapshot.crashed` / `.enqueue_failed` — the handler threw, or dispatch failed.

**What it means:** The daily **00:15 UTC** §7.1 snapshot (AECI-581 / Phase 8.3 P2.1,
`apps/api/src/lib/metrics-snapshot.ts`) writes one `metrics_daily` row per `(day, metric)` for all
19 `ADMIN_SNAPSHOT_METRIC_KEYS`, capturing the prior **complete** UTC day. It is the only writer.

Three properties shape every response here:

| Property | Consequence |
|---|---|
| **Flows are recoverable, stocks are not** | Flow metrics (page views, `*.created` events, new profiles) can be reconstructed from `page_views` + `audit_log`. **Stocks** (catalog totals, queue depths, subscriber counts) are an instantaneous sample — a day not sampled is **gone permanently**. §4: 827 `integration.created` events back 496 live rows, so a cumulative sum would be wrong, not approximate |
| **Per-key isolation** | Each metric computes and writes in its own try/catch, outside any batch (mirroring `lib/home-stats.ts`). `runMetricsSnapshot` **never throws**. One failing producer is recorded; the other 18 still land. So `partial` is the expected shape of a problem, not `failed` |
| **Zero-fill is load-bearing** | §7.4 forbids pruning a day the snapshot never captured, so a gap here **aborts the whole 03:00 retention run** — `job_runs` half included. A snapshot problem surfaces as a retention alert |

Writes are idempotent per `(day, metric)`, which is what makes a missed day fixable: a re-run
corrects rather than duplicates. **No `audit_log` row** — derived bookkeeping, exempt under ADR 0022
/ §13 D11; forcing these writes into a batch to carry one would destroy the isolation above.

**First checks**

1. **`/admin/system` first.** The `metrics-snapshot` row gives last run, outcome and duration. The
   Unknown / Inferred / In-flight triage above applies unchanged.
2. **Which days are actually missing?** This is the same query the prune runs before it deletes:
   ```bash
   wrangler d1 execute aeci-app-production --env production --remote --command \
     "select distinct substr(created_at,1,10) as day from page_views
      where substr(created_at,1,10) not in (select day from metrics_daily)
      order by day desc limit 30"
   ```
3. **`partial`, not `failed`?** Read `aeci.metrics_snapshot.metric{outcome:failed}` to find the
   offending key. One broken producer does not need a full re-run — re-running is idempotent, so
   just re-run the day.
4. **Nothing at all since a deploy?** Check the cron is still scheduled: `"15 0 * * *"` must be in
   `apps/api/wrangler.jsonc`'s `triggers.crons` for the tier (it is in `staging`, `demo` and
   `production`; `preview` deliberately has none, so PR previews run no crons). Confirm against the
   Worker's scheduled invocations and `wrangler tail`.

**Repair:** re-run the affected range through the backfill. It is dry-run by default and refuses
production without `--allow-production`:

```bash
pnpm --filter @aeci/api ops:backfill-metrics-daily -- --env production \
  --from <first-missing-day> --to <last-missing-day> --apply --allow-production
```

Two things to know before you run it:

- **It only restores flows.** Stocks for the missing days stay absent, permanently and by design —
  the script does not pretend otherwise. Charts of stock series will keep their hole.
- **It refuses a range containing unclassified page views** (`is_bot IS NULL`) unless `--force`.
  Do not reach for `--force`: those rows read as human, and `metrics_daily` is the long memory, so
  forcing would freeze the wrong human/bot split in permanently (the exact defect AECI-582 fixed).
  Run the classifier on that tier first.

Precedence protects you: a `measured` write always wins, and a `reconstructed` write applies only
over an absent or already-`reconstructed` row — so a backfill can never overwrite what the cron
genuinely measured.

## Retention prune skipped, failed, or not running

**Alerts (PostHog, hourly):**
- `AECi — Retention prune skipped (metrics_daily gap)` — a day inside the `page_views` cut window has no snapshot, so **nothing was deleted from either table**. **Informational / non-paging** — the failure direction is safe — but do not sit on it.
- `AECi — Retention prune deleted an unexpected number of rows` — >5,000 rows in a day for one table. **Pages.**
- `AECi — Retention prune failed (daily cron)` — the job threw; the batch is atomic, so nothing was deleted.
- `AECi — Retention prune not running (no daily run)` — the cron stopped firing.

**After AECI-651**, also four ways: **runaway stays its own PostHog alert, threshold unchanged at
5,000 rows/table/day** (a *successful* run with the wrong effect — its runbook is "find out what was
deleted before it ages out", which shares nothing with "the job failed"); **failed folds into the
combined** cron-failure alert; **not-running moves to the CI liveness sweep** (`retention-prune`,
26 h); and **skipped stops alerting**, becoming a dashboard read ("AECi — Cron health & retention" →
*Retention — rows deleted, skipped and truncated runs*) alongside the digest that already carries
it.

**Metrics:**
- `aeci.retention.prune{outcome:ok|skipped|failed}` — one heartbeat per completed run; the always-emitted series is the liveness signal. `reason:metrics_daily_gap` on a skip.
- `aeci.retention.rows_deleted{table}` — rows removed per table, **emitted every run including zeros**.
- `aeci.retention.prune.truncated{table}` — the per-table run budget (10,000 rows) stopped the run short.
- `aeci.retention.prune.duration_ms` — run duration.

**What it means:** The daily **03:00 UTC** §7.4 retention prune (AECI-584 / Phase 8.3 P3.2,
`ADMIN_PANEL_SPEC.md` §7.4) deletes `page_views` older than **400 days** and `job_runs` older than
**90**, in bounded chunks. It is the system's only scheduled `DELETE`, and the only cron that writes
an `audit_log` row — exactly one `retention.pruned` summary row per run, in the same atomic batch as
the deletes (the ADR 0022 exception).

Two facts shape every response here. **Deletion is effectively permanent**: D1 Time Travel recovers
only ~30 days. And **`metrics_daily` is the only thing that survives a `page_views` prune**, which is
why the job verifies a `metrics_daily` row exists for *every* day inside its cut window before
deleting anything, and refuses the whole run — the `job_runs` half included — if one is missing.

`metrics_daily`, `audit_log`, `workflow_instances` and `workflow_transitions` are never touched
(§26.6 / §7.4 rule 3), asserted by test rather than by comment.

**First checks**

1. **Skipped?** Read the `source:retention-prune-cron` log `aeci.retention.skipped` — it carries
   `window_from`, `window_to`, `missing_count`, and the first ten `missing_days`. The fault is in the
   **snapshot** pipeline, not here — work "Metrics snapshot missing or incomplete" above (note it
   has no monitor of its own yet, so `/admin/system`'s `metrics-snapshot` row and
   `aeci.metrics_snapshot.*` are the signals). Backfill the gap, then the prune resumes on its own
   the next night:
   ```bash
   pnpm --filter @aeci/api ops:backfill-metrics-daily -- --env production \
     --from <first-missing-day> --to <last-missing-day> --apply --allow-production
   ```
2. **Unexpected row count?** Check the two overrides on the production Worker first — both should be
   **unset**; a `PAGE_VIEWS_RETENTION_DAYS` or `JOB_RUNS_RETENTION_DAYS` that someone shortened is
   the most likely cause. Then read the run's audit row, which records the cutoff and per-table
   counts:
   ```bash
   wrangler d1 execute aeci-app-production --env production --remote \
     --command "select created_at, metadata from audit_log where action = 'retention.pruned' order by created_at desc limit 5"
   ```
   A catch-up after downtime looks identical to a runaway in the metric; the audit row's `cutoff` is
   what tells them apart.
3. **Failed?** `source:retention-prune-cron`, `aeci.retention.crashed`. The batch is atomic, so
   nothing was deleted and nothing was logged — the next run re-probes from scratch.
4. **No-data (not running)?** The cron is not firing. Check the production API Worker's scheduled
   invocations in the Cloudflare dashboard, `wrangler tail`, and that `"0 3 * * *"` is still in
   `apps/api/wrangler.jsonc`'s production `triggers.crons`. Nothing is lost while it is down — the
   table just grows.
5. **`truncated` for several consecutive days?** The per-table budget is holding it back. That is
   fine for a catch-up (it will converge), and a real problem only if the window keeps shrinking.

**Repair:** there is nothing to un-delete, which is the whole design. A skip needs the *snapshot*
fixed, not the prune. A not-running cron is a Worker scheduling issue — escalate to whoever owns the
API Worker's crons. If a window must be shortened urgently, set the env override rather than shipping
a code change; values below **30 days** are ignored (D1 Time Travel's horizon) and logged as
`aeci.retention.invalid_window_override`.

### First production run — treat it as an operation, not a deploy

At the shipped windows the prune deletes **nothing** until ~**2026-11-11** (`job_runs`) and
~**2027-07** (`page_views`, whose data starts 2026-06-23). Before the first run that will actually
remove rows — or immediately after shortening a window — dry-run the counts and record before/after
on AECI-584.

```bash
# 1. What WOULD be deleted (both tables), at today's cutoffs.
wrangler d1 execute aeci-app-production --env production --remote --command \
  "select 'page_views' as t, count(*) from page_views where created_at < date('now','-400 day') || 'T00:00:00.000Z'
   union all
   select 'job_runs', count(*) from job_runs where started_at < date('now','-90 day') || 'T00:00:00.000Z'"

# 2. Is every day in the page_views cut window captured? Zero rows = the prune will proceed.
wrangler d1 execute aeci-app-production --env production --remote --command \
  "select distinct substr(created_at,1,10) as day from page_views
   where created_at < date('now','-400 day') || 'T00:00:00.000Z'
     and substr(created_at,1,10) not in (select day from metrics_daily)
   order by day"

# 3. After the run: the single summary row it wrote.
wrangler d1 execute aeci-app-production --env production --remote --command \
  "select created_at, metadata from audit_log where action = 'retention.pruned' order by created_at desc limit 1"
```

If step 2 returns any rows, the prune will skip — backfill those days first (First checks 1).

## WAF rate-limit / challenge spike

**Alerts (PostHog, hourly):**
- `AECi — WAF rate-limit / challenge spike (15m)` — `sum:aeci.waf.ratelimit.blocked` (`.as_count()`) > 500 over 15m on `env:production`.
- `AECi — WAF poll not running` — no successful hourly `aeci.waf.poll{outcome:ok}` for ~3h (cron liveness; AECI-279).

**After AECI-651:** the spike alert is the **one threshold in the whole set that had to move** —
**500/15 min → 2,000/1 h**. The sensitivity is unchanged and so is the underlying data: the source
is an **hourly** cron (`0 * * * *`) that reads the *previous clock hour* from Cloudflare's GraphQL
API in one shot, so a 15-minute Datadog window over an hourly-emitted series was always coarser than
it looked — it just saw the whole hour's count land inside one 15-minute bucket. `500 × 4 = 2,000`.
The poll-liveness half moves to the **CI liveness sweep** (`waf-poll`, 180 min unchanged).

**Metrics:**
- `aeci.waf.ratelimit.blocked{rule,action,host,source}` — Cloudflare WAF mitigations (blocks + challenges),
  **value is the event count → query with `sum:` / `.as_count()`**.
- `aeci.waf.poll{outcome:ok|failed|skipped_no_creds}` — the hourly poll's heartbeat (`outcome:ok` = liveness).

**What it means:** The §15.1 WAF rules (rate-limit Rule A `/api/requests/*`, Rule B `/api/reviews`, and the
scraper-UA Managed-Challenge custom rule — `docs/waf-rate-limits.md`) mitigated an unusual volume of requests.
The signal is collected by the API Worker's hourly WAF poll (AECI-262, `scheduled.ts` `runWafMetricsJob`),
which reads the previous clock hour of the zone's `firewallEventsAdaptiveGroups` over Cloudflare's GraphQL
Analytics API. **Detection lags up to ~1h** (it's an hourly poll). A spike is normally either a scripted
flood tripping the rate-limit rules or a scraper run hitting the UA challenge — rarely a real user.

**First checks**

1. **What fired?** Pivot `aeci.waf.ratelimit.blocked` by `action` (block vs managed_challenge), `rule`, `host`,
   and `source` (ratelimit vs firewallcustom) to localize. Cross-reference Cloudflare → **Security → Events**
   (filter by the same rule/action/host) for the offending IPs / paths / user agents — CF carries the per-IP
   detail neither telemetry plane carries.
2. **Real attack or false positive?** If the offending UA/IPs are obviously a scraper/flood, no action is
   needed — the rules are doing their job; consider whether the volume warrants a Cloudflare IP block. If a
   **legitimate** user or integration is being blocked/challenged, re-tune the rule in
   `docs/waf-rate-limits.md` (update the doc in the same change — it is the source of truth) and verify per §4.
3. **No data / heartbeat gaps?** The spike monitor has **no** `notify_no_data` (silence = no attacks). Poll
   health is the separate `aeci.waf.poll{outcome:ok}` series, now watched by the `AECi — WAF poll not running`
   liveness monitor (AECI-279, no-data over ~3h) — if it stopped, the cron isn't running; if it shows
   `outcome:skipped_no_creds`, `CF_ANALYTICS_API_TOKEN` is unset on that env's Worker (the metric is then
   absent by design until the token is provisioned). `outcome:failed` → read the `source:waf-metrics-cron`
   error log for the Cloudflare GraphQL `reason` (e.g. an expired/under-scoped token — it needs
   `Zone Analytics: Read`).

**Repair:** the WAF itself is already mitigating — this alert is **awareness**, not an outage. Escalate only
if a legitimate surface is being blocked (re-tune the rule) or if the volume suggests a targeted attack worth
a manual Cloudflare block. The threshold is a launch placeholder; re-tune it in
`observability/posthog/alerts.json` (2,000/1 h) once baseline volume is known. That figure is
the retired Datadog monitor's 500/15 m rescaled 4× for the hourly window — keep the rescale in
mind when re-tuning, or the alert will mean something different from what the runbooks assume.

---

## Promote job errored or stuck

**Signal:** `aeci.api.promote.job{outcome:errored}` (with a `code` tag), the
`aeci.api.promote.job_failed` error log, or `aeci.api.promote.job.duration_ms` running long.
There is **no alert on this on either plane** — promote volume is a handful per day, so the trigger
is usually a curator reporting "the promote never finished". It is not among the 26 dispositioned
monitors and it is not in `observability/posthog/alerts.json`, so the cutover changes nothing here.
(AECI-563 / ADR 0021.)

**What it means:** since AECI-563 `POST /api/promote` only *starts* the ingest. The commit runs
in the `PROMOTE_WORKFLOW` Cloudflare Workflow, one instance per promote, whose **instance id is
the review-app-supplied `promote_job_id`**. A failure never surfaces as an HTTP status to the
caller — it lands as `{ status: 'errored', error: { code } }` on `GET /api/promote/jobs/:id` and
as the log above. An `errored` job **wrote nothing**: the ingest is one atomic `db.batch`, so
there is no partial state to clean up.

**First checks**

1. **Get the job id.** From the curator (the Airtable row's `promote_job_id`), or from the
   `job_id` attribute on the `aeci.api.promote.job_failed` log
   (`service:aeci-api source:review-app-promote`).
2. **Read the job.** Either the API (`GET /api/promote/jobs/{jobId}` with the
   `REVIEW_APP_TOKEN` bearer) or the Cloudflare dashboard → **Workers & Pages → Workflows →
   `aeci-promote-<env>`** → the instance. The dashboard shows the per-step history, which the
   API does not.
3. **Which code?**
   - `SLUG_CONFLICT` — two first-time promotes raced for the same slug. Benign and
     caller-resolvable: re-push with a **new** job id and slug disambiguation (`-2`, `-3`) will
     settle it.
   - `VALIDATION_FAILED` — a product name that can't be turned into a slug (reserved or empty
     after normalization). Needs the name fixed in Airtable.
   - `INTERNAL_ERROR` — a real fault. Read the log's `reason` (D1 errors put the detail in the
     `cause` chain) and the step history.
4. **Stuck rather than failed?** A job sitting in `running` far longer than
   `aeci.api.promote.job.duration_ms`'s normal range is usually a slow plan phase on a
   heavily-integrated product (many sequential D1 reads) — not a hang. The commit step has a
   10-minute timeout, after which the instance errors. A job stuck in `queued` means the
   account is at its concurrent-instance ceiling, which our volume will not reach.
5. **Was it even started?** A poll returning `404` means AECi has no record of the id: either
   the kick-off never succeeded (check for a 4xx/5xx `source:review-app-promote` log with that
   window's `trace_id`) or the job is past its retention (30 days for the instance, 90 for the
   KV result mirror).

**Repair**

- **Normal path — let the review app re-push.** A new job id, same bundle. Because an `errored`
  job wrote nothing, this is safe and is the expected remedy for every code above.
  **One exception (AECI-571):** an `errored` job whose reason reads *"has already committed, but
  its stored result is unreadable"* **did** write. Its rows are live. Do **not** re-push — recover
  the ID map from the KV mirror (`promote:result:{jobId}`) or straight from D1
  (`SELECT result FROM promote_jobs WHERE job_id = '…'`) and hand it to the write-back. This is
  the only `errored` promote that ever committed, and it means the ledger row itself is corrupt;
  escalate it.
- **The IDs committed but the review app never collected them** (the exact class of damage this
  design exists to prevent): poll the job id; a `complete` job still serves its full ID map, so
  the write-back can be re-run. This is what the review-app reconcile sweep (AECI-570) automates.
- **`restart()` no longer risks a duplicate (AECI-571), but is still not a retry.** If the commit
  already succeeded, a restart replays it, trips the `promote_jobs` primary key, rolls back, and
  returns the recorded ID map — which makes it the fastest way to recover an instance that is
  wedged *after* a silently-successful commit. It is still **not** the remedy for a genuinely
  failed commit: the step is deliberately non-retried (`NonRetryableError`), and a failure that
  reproduces will simply fail again. Re-push with a new job id for that.
- **`terminate()`** an instance only to clear a genuinely wedged job, and note that the id is then
  permanently consumed for its retention window — the review app must use a new one.

**Escalation:** repeated `INTERNAL_ERROR`s across different products point at the ingest itself
(`apps/api/src/routes/promote.ts`) or at D1 — capture the job id, the `reason`, and the step
history. Repeated `SLUG_CONFLICT`s with no concurrency suggest a slug-generation regression, not
a race.

**Duplicate safety (AECI-571).** Workflows guarantee a step runs *at least* once, so an engine
crash between the `db.batch` committing and the step result being persisted replays the commit.
That used to be able to duplicate a **created** row; it can't any more. The ingest writes a
`promote_jobs` row keyed by the job id as the first statement of the promote's own batch, so a
replayed batch trips the primary key, D1 rolls the whole batch back, and the recorded ID map is
returned instead — same ids, same slug.

- `sum:aeci.api.promote.replay` is non-zero **exactly when the window fired and was absorbed**.
  This is informational, not actionable: the promote is correct. Capture the `job_id` from the
  `aeci.api.promote.replay_detected` log if you want the step history, and note the `via` tag
  (`pre-read` = the ordinary replay, `batch-conflict` = a replay that raced the original batch).
- A duplicated product whose promote job reported `complete` exactly once is now a **bug**, not
  the known gap. Capture the job id and the instance's step history and escalate.

**Pruning the ledger.** `promote_jobs` grows by a handful of ~10 KB rows a day and has no
automatic prune (deliberately — see `DATABASE_SCHEMA.md` §8.5). If it ever needs one:

```sql
DELETE FROM promote_jobs WHERE created_at < datetime('now', '-180 days');
```

**The floor is 90 days, hard.** Below that the guard expires before the `promote:result:{jobId}`
KV mirror it backstops, leaving a window where a poll still serves IDs while a re-push of that
job id would duplicate them.

---

## Promote strand audit is red

**Signal:** the daily `promote-strand-audit` GitHub Action (09:00 UTC, `.github/workflows/promote-strand-audit.yml`)
exits non-zero. There is no monitor on either plane — the workflow's own red **is** the alert, the
same pattern the AECI-647 cron liveness sweep now uses for absence detection, and for the same
reason: the check has to live outside the system it is checking. (AECI-568 / AECI-593.)

**What it means:** production D1 and the Airtable curation base disagree about which rows exist.
The only link between them is the `supabase_*_id` column Airtable holds — D1 stores no
curation-tool key (AECI-562 was rejected deliberately) — so one broken pointer makes a live row
permanently unreachable. Which bucket fired tells you which direction broke:

| Bucket | Meaning |
|---|---|
| `stray` | A D1 row no Airtable record points at. **The common one.** |
| `dangling` | An Airtable id whose D1 row is gone. |
| `stranded` | An Airtable record that looks promoted but carries no id. |
| `duplicatePointers` | One D1 id claimed by two Airtable records. |
| `pendingJobMarkers` | An uncollected `promote_job_id` — also the liveness check for the AECI-570 hourly reconcile sweep. |

**First checks**

1. **Re-run locally for the full per-bucket dump** (the CI log prints the table; the id lists are
   in the report file, which CI does not upload):
   ```bash
   AIRTABLE_TOKEN=<pat> CLOUDFLARE_API_TOKEN=<token> \
     node scripts/ops/2026-08-promote-strand-audit/audit.mjs
   ```
2. **`stray`: was this an editorial retraction?** Read the affected product's Airtable
   `research_notes` and `tool_integration_check_notes` *before* anything else. A curator who
   deleted an integration on purpose normally records the ruling there — that is exactly what
   AECI-593 turned out to be, and it flips the repair from "adopt" to "delete".
3. **`pendingJobMarkers`: never clear the marker by hand.** It is the recovery handle; a
   `complete` job still serves its full ID map. See "Promote job errored or stuck" above.

**Repair**

Every bucket's recipe lives in `scripts/ops/2026-08-promote-strand-audit/README.md` §Healing.
The audit itself has no `--apply` and never writes. Two things worth repeating here:

- **`stray` is a curation judgement, not a mechanical delete.** Adopt (recreate the Airtable
  record carrying the existing uuid) or delete (datatool `POST /api/prune-integrations`). A
  tripped guard means the row is *not* redundant residue — find the ruling rather than reaching
  for the override. With a ruling, acknowledge exactly the guards the dry run reported plus an
  `acknowledgeReason`; save `rollbackSql` first (`apps/datatool/README.md`).
- **A prune does not recompute `stats_cache`.** After deleting integrations the home-page totals
  read high until the next promote of any product runs `refreshHomeStatsAfterPromote`. Harmless
  and self-healing; only chase it if no promote is expected soon.

**Root cause, and why this job exists:** promote can create and update but **never delete**
(`docs/REVIEW_APP_PROMOTE_API.md` §5.1). A curator deleting an Airtable record therefore always
leaves a stray, and destroys the only pointer that could have found it. Nothing in the promote
path can guard that, so this scheduled audit is the backstop.

**Escalation:** a `stray` with no recorded ruling and no obvious curator action is a real unknown
— do **not** delete to make the audit green. Capture the ids and the affected pair pages, and
raise it with whoever owns the catalog.
