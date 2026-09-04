# Post-launch Monitoring Runbook

**Version:** 1.1 · **Date:** 2026-08-24 (v1.0 2026-07-11) · **Owner:** Chris ·
**Issues:** AECI-279 (Phase 8.1); reworked for the dual-run by AECI-648 (§AW7 of
`POSTHOG_MIGRATION_SPEC.md`)

The repeatable **daily / weekly** procedure for watching real production traffic and stabilizing.
This is the *operate* companion to the record docs:

- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — the metric **catalogue**, the pipes, dashboards, and alerts (what each signal is).
- [`RUNBOOKS.md`](./RUNBOOKS.md) — the **incident** response guides (what to do when an alert fires), and the alert → runbook index.
- [`launch-cutover-runbook.md`](./launch-cutover-runbook.md) §5 — the **post-cutover verification** signals this pass re-observes.
- [`ANALYTICS.md`](./ANALYTICS.md) — the **product** side: event catalogue, funnels, identity, flags.
- [`ANALYTICS_BASELINE.md`](./ANALYTICS_BASELINE.md) — the traffic/signup/CWV **numbers** procedure.
- [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md) — the dated **health-report log** this procedure feeds.

## Which console you are reading — the dual-run

**During the ADR 0024 dual-run this pass reads two consoles, and they are not
interchangeable.** Be explicit about which one a number came from before you write it
into a health report, or the report will silently mix a census with a funnel.

| Surface | Authoritative for | Not authoritative for |
|---|---|---|
| **PostHog** (`aec-integrations`, **354071**, production only) | Person-linked logs (`posthogDistinctId`), `$exception` grouping, deploy `deployment` events, and the product funnels in `ANALYTICS.md` | **Alerts — none are applied to production yet.** Dashboards are applied to the **non-production** project (525793) only. Do not read a prod number off a 525793 board |
| **`/admin/*`** (`job_runs`, `page_views`, `metrics_daily`) | Cron run records, the consent-independent traffic count, D1 footprint | Absence ("it never ran" writes no row, by construction) |
| **The CI liveness sweep** (`posthog-liveness-sweep.yml`, every 3 h) | Cron **absence**, across all thirteen crons — **already running** and worth reading during the dual-run | Anything about *why* a cron failed |
| **Cloudflare** (Workers observability, Security → Events) | Edge cache HIT-rate, absolute request volume, per-IP WAF detail | Application-level anything |

The rule for this pass: **read PostHog for production numbers, read the liveness sweep
for cron absence, and read PostHog to build confidence in the plane you are about to
switch to.** A number present in one telemetry plane and absent in the other is a
finding — that is what the dual-run window is *for*.

---

## 0. Precondition — is telemetry actually flowing?

**Check this first every morning until it passes.** The browser globals inject only
when their Worker config exists.

```bash
curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'
```

- **Both printed** → the browser plane is live. **This is the current state** —
  re-verified 2026-08-24, correcting the "prod is dark" reading this section carried
  from 2026-07-11 (`ANALYTICS_BASELINE.md` carries the dated correction). Note the
  PostHog half no longer depends on an operator step at all: since **AECI-640**
  `POSTHOG_PROJECT_KEY` is a **committed wrangler var**, not a CI-pushed secret, so
  there is nothing left to forget to provision. `__AECI_DD__` still depends on the
  `DD_APPLICATION_ID` / `DD_CLIENT_TOKEN` secrets, and disappears at AECI-651.
- **Only `__AECI_DD__` printed** → a deploy regression in the PostHog bootstrap
  inject, not a provisioning gap. Treat it as a defect.
- **Neither printed** → the browser plane is not capturing. Server-side signals
  (Worker metrics + logs, `page_views` / `mailing_list` D1) are unaffected and still
  valid, and `/admin/audience` (AECI-586) keeps signup volume, churn and campaign
  attribution readable regardless.

### 0a. Two operator toggles gate PostHog signals that the code cannot

**Neither is a code problem and neither will be fixed by a deploy.** Until they are
flipped, do not chase the missing signal (`OBSERVABILITY.md` → "The remote-config
gate"):

- **Web vitals** must be enabled in **project settings** on both projects.
  `posthog-js` fetches `/array/{token}/config` on init and that response **overrides**
  the client's `capture_performance: { web_vitals: true }`. So `$web_vitals` does not
  fire yet. This is the one
  signal where letting AECI-651 run before the toggle is flipped would leave a real
  hole.
- **Error tracking (exception autocapture)** must be enabled on both projects too.
  **Manual capture is not gated** — `PosthogErrorHandler` → `captureException` already
  delivers `$exception` events — so the browser error path works; it just has no
  Error Tracking console to read it in until the toggle is on.

The rest of the outstanding operator checklist (the internal-user exclusion, running
`apply.sh` against production, deleting the two unused `POSTHOG_KEY_*` GitHub secrets)
is in `observability/posthog/README.md`. The `phx_` personal key is **done** —
`POSTHOG_CLI_API_KEY` was set as a GitHub repo secret on 2026-09-04, so the liveness
sweep, deploy annotations and source-map upload all run for real. **If it is ever
rotated away the sweep exits 2 on every run — "unchecked", which is not a pass** — and
annotations and source-map upload go back to warn-skipping.

---

## 1. Daily monitoring checklist

A ~5-minute glance across the shipped dashboards + alerts. Nothing here should require action on a
healthy day — the point is to catch a regression before an alert's sustained-window threshold does.
**That framing matters more now than it did:** PostHog alerts evaluate **hourly**, so the daily
eyeball is the compensating control for a detection window that got four to twelve times longer.

The "Where to look" column names the PostHog surface because that is what carries production
data today, with the PostHog successor in brackets.

| # | Signal | Where to look | Healthy | Fires as |
|---|---|---|---|---|
| 1 | **Errors** | Phase 2 — Traffic dashboard (4xx/5xx widget); `aeci.api.query.duration_ms` by `endpoint`/`status_class`; SSR logs `service:aeci-web status:error` *(PostHog: "AECi — Traffic (SSR + API)")*. **Note `status_class` only** — the raw `status`/`status_code` tags were dropped in AECI-642; the exact code is on the error log | 5xx rate < 1% | `AECi — Worker error rate high` (>1%/5m today → **hourly** after the cutover) |
| 2 | **Edge cache hit rate** | Cloudflare Workers observability dashboard (Workers & Pages → `aeci-web` → Observability) + `Cf-Cache-Status` — **in neither telemetry plane** (a native-cache HIT skips the Worker; WC-3/WC-8) | HIT majority on cacheable route classes (detail/browse/taxonomy/static) | *(no alert — `AECi — Cache hit rate low` was retired in WC-8/AECI-322)* |
| 3 | **Render latency** | Phase 2 — Traffic (p95 render per `route_class`) *(PostHog: prefer the **histogram-buckets** widget over the reconstructed p95 — see §2.7)* | p95 detail (MISS) < 1.5s | `AECi — Detail render slow` (>1.5s/10m, `cache_status:miss`) |
| 4 | **Algolia query latency / errors** | Phase 3 — Search (browser RUM `aeci.search.query`: latency p50/p95/p99, error rate) | error rate ~0; p95 within norm | *(no alert — dashboard-only)*. ⚠️ **This signal narrows at AECI-651**: the RUM action is consent-independent, its `search_performed` successor is consented-only. Read it as a funnel from then on, not a census |
| 5 | **Algolia sync + drift** | Phase 3 — Search; `aeci.algolia.sync`, `aeci.algolia.index_drift`. Also **`/admin/system`** — the sync watermark (per entity + last advance), and drift on demand via "Run data-quality checks" | drift 0; daily sync `outcome:ok` | drift / sync-failed / sync-not-running / orphan-cap monitors. **After the cutover:** sync-failed folds into the combined cron alert, drift becomes **dashboard-only**, liveness moves to the CI sweep, orphan-cap stays its own alert |
| 5a | **Data quality (10 §23.1 checks)** | **`/admin/system`** — the page opens on the **last stored 04:00 result** (AECI-583), labelled with the run's own timestamp, so the morning read needs no click and no email. "Run data-quality checks" re-runs the suite live to confirm a fix. Both are pure reads | every check *Passing*; `algolia_index_drift` *Skipped* is normal off production (no credentials) | check-error / check-warn. **After the cutover:** ERROR stays an alert (and *gains* the ability to see a check that **threw** — sentinel `-1`, which Datadog's `max(...) > 0` could not); WARN becomes dashboard + digest only |
| 6 | **Scheduled-job health (13 crons)** | **`/admin/system`** for the record — real last run, outcome and duration per job (AECI-583). **Something outside the Worker for absence** — a job that never starts leaves no row, so the no-data monitors (today) / the **CI liveness sweep** (already running) are the only signal for "it stopped firing" (see §1a) | every cron shows a recent recorded run, and emitted its heartbeat in window | the per-cron `… not running` / `… failed` monitors today; the **combined** cron-failure alert + the sweep after |
| 6a | **The CI liveness sweep itself** | GitHub Actions → `posthog-liveness-sweep` (every 3 h). Read the **latest run's conclusion**, not just the alert inbox | green | **exit 1** = a heartbeat MISSING or STALE, with a `::error::` naming the cron. **exit 2** = the sweep could not run — "UNCHECKED, **not** a pass". Expect exit 2 on every run until the `phx_` key is provisioned (§0a) |
| 7 | **Request → Linear pipeline** | Phase 6 — Requests / Moderation; `aeci.linear.issue`/`.sync`/`.reconcile.*`, `aeci.webhooks.linear.hmac_failure` *(PostHog: "AECi — Requests / Linear pipeline")* | failure rate < 50%; no persistent stuck; no HMAC burst | pipeline-failure / reconcile-stuck / reconcile-no-data / hmac monitors |
| 8 | **Moderation queue** | Phase 5 & 6 dashboards; `aeci.moderation.queue_depth` / `queue_oldest_age_hours`; `GET /api/admin/summary` (`pending_reviews`), `GET /api/admin/requests` | oldest pending < 48h (target 24h, §17) | `AECi — Moderation queue backlog` (>48h) — ⚠️ **this stops alerting at AECI-651** and becomes a dashboard read. **This row is why it is safe to drop the alert; do not skip it** |
| 9 | **Field Core Web Vitals** | PostHog **Web vitals** (production project 354071; p75 LCP / CLS / INP) | LCP ≤ 2.5s · CLS ≤ 0.1 · INP ≤ 200ms (`STAGE_1_PHASE_2_SPEC.md` §12) | *(no alert — read manually; see §2)*. The Datadog RUM source was deleted at AECI-651; `$web_vitals` has been live on every tier since the project toggle was flipped 2026-08-26 |
| 10 | **Deploy markers line up with step changes** | PostHog — the annotation line across every insight (once the `phx_` key exists), or a HogQL query over the `deployment` event, which works **today** on the publishable token | a step change in any of the above coincides with a marker | *(no alert)*. `deploy_kind: auto_rollback` is an **incident** marker, not a release one — if you see one you did not expect, start there |

> **Don't confuse field CWV with the SSR render metric.** PostHog's Web vitals page is field
> data from real browsers; `aeci.page.render.duration_ms` on the Traffic dashboard is the
> Worker's own render time. They answer different questions and will not agree.

> **PostHog UI gotcha, the same shape:** the org has **five** projects. `aec-integrations`
> (**354071**) is production; `aec-integrations-dev` (**525793**) carries preview, staging, demo and
> stage2 together, and it is where the seven dashboards are currently applied. There is **no `env:`
> filter on any query** — the project *is* the tier boundary — so a board read in the wrong project
> is silently a different tier's numbers, with nothing on screen to say so. Also: production events
> from **before** AECI-640 carry mixed tiers (demo was pointed at the prod key), so filter by `$host`
> when reading history that far back.

### 1a. The 13 scheduled crons (row 6 detail)

Each cron emits an always-on heartbeat; **absence** of that heartbeat is the liveness signal. A green
board here means all thirteen fired on schedule. Since AECI-583 each run **also** writes a `job_runs`
row that `/admin/system` renders (see the split below).

> **Read the record off `/admin/system`; read absence off something outside the Worker.** AECI-583
> landed the `job_runs` table, so the screen shows each job's real last run, outcome and duration —
> including the data-quality run's full ten-check result set, which used to exist only in the 04:00
> email. Start the daily pass there.
>
> **But `/admin/system` can never be the authority for "a job stopped firing."** A cron that never
> starts writes no `job_runs` row either, so its absence is invisible in D1 by construction. The
> screen is still built so it cannot render a green tick it hasn't earned: a job with no row reads
> *Unknown*, a run with no finish stamp reads *In flight* (never *ok*), and the two jobs that leave a
> `stats_cache` side effect can show an *Inferred* timestamp, which proves the job **ran**, not that
> it **succeeded**. Full reconciliation in `OBSERVABILITY.md`.
>
> **What owns absence.** Formerly Datadog's six `notify_no_data` monitors; since AECI-651,
> AECI-651 — and **already running now** — the CI liveness sweep, which watches all **thirteen**. It
> runs outside the Worker on purpose; a liveness check hosted inside the API Worker cannot detect
> the API Worker being dead. **PostHog alerts are explicitly not the answer:** no PostHog tier has
> `notify_no_data`, and a "count < 1" alert over an empty window returns no rows rather than
> breaching. The cost is a dependency the old model did not have — **absence detection now needs
> GitHub Actions to be up** — which is why the sweep's exit **2** means "unchecked, not healthy"
> rather than passing quietly.

The last column reads: *what alerts today* → *what alerts after the cutover*. "Combined" means the
single `AECi — Cron job failed (any daily/hourly job)` alert, whose breach email names the failing
job in its label column; "sweep" means the CI liveness sweep, with its staleness allowance.

| Cron (UTC) | Job | `job_runs.job` | Failure / liveness coverage |
|---|---|---|---|
| `15 0 * * *` | `metrics_daily` snapshot of the prior complete UTC day (AECI-581 / `ADMIN_PANEL_SPEC.md` §7.1) — 19 metrics, the admin panel's long memory | `metrics-snapshot` | **today: nothing.** A known gap, and the worst one to have — queue-less, so a failed run is not retried, and the *stock* metrics of a missed day are unrecoverable (flow metrics recover via `pnpm --filter @aeci/api ops:backfill-metrics-daily`). → **combined + sweep (26 h)** — the port closes it |
| `0 2 * * 2` | **WEEKLY** (Mondays — Cloudflare's day-of-week is 1=Sunday, so Monday is `2`; this read `0 2 * * 1` and therefore fired on SUNDAY until AECI-661) — `asn_registry` refresh from PeeringDB (AECI-624 / `ADMIN_PANEL_SPEC.md` §7.6): the read-time network annotation behind the Activity feed | `asn-registry` | **today: nothing on this line.** It arrived with the AECI-750 reconcile, and its Datadog no-data monitor had already been deleted by AECI-651, so it landed with no absence signal at all. → **combined + sweep**, and the sweep's `lookbackHours` widened 72 → 360 for it: a WEEKLY heartbeat is absent from a 72 h window six days in seven, which would have read MISSING every day. A `failed` run is not urgent — nothing is ever deleted, so the panel keeps annotating from the last good rows and `/admin/system` marks the registry stale after two missed Mondays. Watch **coverage**, not freshness: it decays silently as new networks arrive |
| `0 3 * * *` | §7.4 retention prune (AECI-584 / `ADMIN_PANEL_SPEC.md` §7.4) — the system's only scheduled `DELETE`: `page_views` past 400 days, `job_runs` past 90, in bounded chunks, with one `retention.pruned` audit row per run. **Deletes nothing until ~2026-11 (`job_runs`) / ~2027-07 (`page_views`)**, so for now a healthy run is a zero-row run | `retention-prune` | prune-skipped / prune-runaway / prune-failed / prune-not-running (AECI-584) → **runaway stays its own alert** (unchanged 5,000 rows/table/day), failed → combined, not-running → sweep (26 h), **skipped → dashboard + digest, no alert** |
| `0 4 * * *` | Data-quality suite (10 §23.1 checks) + email digest | `data-quality` | check-error / check-warn / failed / not-running → **ERROR stays its own alert** (and now catches a check that *threw*), **WARN → dashboard + digest, no alert**, failed → combined, not-running → sweep (26 h) |
| `0 5 * * *` | Operator analytics digest (AECI-526) — **human** page views + top products, sign-ins, moderation depth, and a Crawler-activity breakdown (human/bot split classified at ingest by UA + ASN) | `analytics-digest` | **today: nothing** (`aeci.analytics_digest.email` heartbeat only) → **combined + sweep** |
| `0 6 * * *` | Moderation queue snapshot | `moderation-snapshot` | moderation-queue-age (threshold + no-data) → **the backlog threshold stops alerting** (dashboard read — daily checklist row 8), liveness → sweep (26 h) |
| `0 7 * * *` | Home-stats compute | `home-stats` | stats-compute-failed / stats-not-running → **combined** (now including the per-key half Datadog's monitor missed, and trigger-agnostic so a failed `trigger:promote` refresh alerts) + sweep (26 h) |
| `0 8 * * *` | Algolia incremental sync | `algolia-sync` | sync-failed / sync-not-running → **combined** + sweep (window **tightened 48 h → 26 h**) |
| `0 9 * * *` | Algolia drift + orphan sweep | `algolia-drift` | index-drift / orphan-sweep-capped → **drift value → dashboard, no alert** (report-only, self-healing); **orphan-cap stays its own alert**; liveness → sweep (26 h) |
| `0 10 * * *` | §7 attestation detector sweep + nudge email (AECI-302) — four detectors over the claim/attestation spine, deduped through an `audit_log` ledger | `attestation-notify` | **today: nothing** — read `aeci.attestation.detector` (a per-detector gauge, always emitted incl. 0) and `aeci.attestation.notify.job{outcome}`. **The zero series is the liveness signal**: the detectors match nothing until vendors start attesting, so "0 findings" is the healthy steady state and no-data is the failure → **combined + sweep** |
| `0 11 * * *` | §7 entitlement term-expiry sweep (AECI-613) — warning notices only; terms **never** auto-lapse | `entitlement-expiry` | **today: nothing** — `aeci.entitlement.expiry.job{outcome}` plus the `aeci.entitlement.expiry_due` gauge, emitted every run **including zero**. Same shape as the 10:00 sweep and for longer: every backfilled entitlement is perpetual (`period_end IS NULL`) and structurally invisible to this job, so **"0 due" is healthy and no-data is the failure** → **combined + sweep** |
| `*/15 * * * *` | Request→Linear reconciliation sweep | `request-reconcile` | reconcile-stuck / reconcile-no-data → **persistent-stuck stays its own alert**; liveness → sweep (window **relaxed 60 → 90 min**, margin for the *sweep's* lateness) |
| `0 * * * *` | WAF firewall-event poll | `waf-poll` | waf-ratelimit-spike / **waf-poll-not-running** (AECI-279) → spike stays its own alert with the **one rescaled threshold** (500/15 m → 2,000/1 h); poll liveness → sweep (180 min, unchanged) |

**Seven of these gain failure coverage they never had** — metrics-snapshot, analytics-digest,
attestation-notify, entitlement-expiry, asn-registry, waf-poll and the per-key half of home-stats. Several shipped
after the Datadog monitors were written and nobody went back. That is the migration's largest single
*improvement*, and it is worth weighing against the hourly-cadence regression rather than reading
either in isolation.

---

## 2. Weekly checklist

1. **Re-verify the launch-cutover §5 signals** ([`launch-cutover-runbook.md`](./launch-cutover-runbook.md)):
   dual `/api/version` + `/_version` SHA match; `www.` canonical + apex→www 301; indexable headers +
   sitemap/robots; IndexNow firing; a test transactional email; the welcome banner on a `?ref=waitlist`
   link. *(The SHA-match half is now also on **`/admin/system`** — AECI-580 renders both Workers'
   builds side by side and flags a mismatch, so the two `curl`s are a cross-check rather than the
   only way to see it.)*
2. **Review the launch-tunable thresholds** (§3) against the week's data — tighten any that missed a real
   issue, relax any that proved noisy. **Only the enforcement/threshold changes** — never relax a budget
   to make a signal pass (`TESTING_STRATEGY.md` §10.4).
3. **Core Web Vitals read**: PostHog → Web vitals, production project,
   `env:production`, p75 LCP / CLS / INP per page type, against the §12 budgets. The pre-launch lab audit
   ([`PERFORMANCE_AUDIT.md`](./PERFORMANCE_AUDIT.md)) flagged **CLS on detail/browse/taxonomy (0.145–0.326)**
   and **detail-page JS ~227 KB** as the likely field offenders — confirm whether the lab headroom (owned
   by **AECI-221**) actually surfaces in the field before acting. If Web vitals is empty, check the
   project-settings toggle first (§0a) — it gates `$web_vitals` server-side and there is no longer a
   Datadog RUM fallback.
4. **Audit the digest's human/bot split** (§3b) — the "Traffic (humans)" number is only as good as the
   ASN table behind it. One query, and widen the list when it turns up hosting networks reading as human.
5. **Glance at the D1 footprint** on **`/admin/system`** — total size and per-table row counts, which
   used to mean a `wrangler d1 execute` per table. Watch `page_views` in particular: it grows ~1,000
   rows/day and `ADMIN_PANEL_SPEC.md` §7.4 sizes the 400-day retention window against it. The table
   list is read from `sqlite_master` at request time, so a table added by a migration shows up without
   a code change.
6. **Append a health-report entry** to [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md)
   (weekly through the first month, then at the one-month mark). **Name the console beside each
   number** while the dual-run lasts.

### Dual-run additions (drop these once AECI-651 has run)

These were the migration-window checks. AECI-651 has since closed the window, so items 7–8 are
retained as **standing sanity checks** (the histogram-p95 reconstruction never got validated against
the Datadog original) and 9–10 as ordinary procedure.

7. **Sanity-check the reconstructed histogram p95.** This is the one piece of arithmetic in the
   whole PostHog plane that never got validated against the Datadog original before that plane was
   deleted (AECI-651 ran ahead of this check). Read the insight
   `AECi — ALERT — Detail page render p95, cache MISS (1 h)` against the dashboard widget
   *Traffic — SSR render latency distribution (histogram buckets)*, which is a raw bucket read with
   no reconstruction: the alert value should land within one bucket width above where the raw
   buckets put the 95th observation (bounds `5,10,25,50,75,100,250,500,750,1000,1500,2500,5000,7500,10000` ms).
   Implausibly low, or 0 while the widget shows traffic, means the reconstruction is wrong — check
   the `lower(cache_status)` predicate first, then whether `histogram_bounds` is uniform across
   points.
8. **Sanity-check one high-volume metric weekly and record the number.** Pick
   `aeci.api.query.duration_ms` by `endpoint`, or `aeci.ssr.render`. A number that moves for no
   deploy-shaped reason is the finding; the most likely causes are a `lower()`-casing miss, a query
   reading the wrong PostHog **project**, or a metric whose value is a row count being counted
   rather than summed.
9. **Read the liveness sweep's run history**, not just its notifications — specifically for **exit 2**
   runs, which mean cron liveness was *unchecked* for that window. A string of them is a provisioning
   or GitHub Actions problem, not a healthy period.
10. **Confirm telemetry is still arriving at all.** With one vendor there is no second plane to
    cross-check against, so a silent transport failure looks exactly like a quiet system. The
    cheapest check is the deploy marker: every deploy should produce a PostHog `deployment` event
    for that SHA. No marker means the pipe is down, not that nothing deployed.

---

## 3. Launch-tunable thresholds

Every threshold below is a documented **launch placeholder** — set before real traffic existed. Revisit
each weekly. Full rationale per alert is in [`OBSERVABILITY.md`](./OBSERVABILITY.md#alerts); the complete
26-row disposition with old thresholds is in [`RUNBOOKS.md`](./RUNBOOKS.md).

> **A threshold change is one edit: `observability/posthog/alerts.json`, then re-run `apply.sh`.**
> Never edit a PostHog alert in the UI — `apply.sh` is idempotent by name and the next run will
> silently revert you.

| Alert | Retired Datadog threshold | PostHog (live) | Retune signal |
|---|---|---|---|
| Worker error rate high | > 1% / 5m | > 1% / **1 h** | raise the floor only if single failures dominate at low volume. **The cadence, not the threshold, is the thing to watch here** |
| Detail render slow | > 1.5s / 10m (MISS) | > 1,500 ms / 1 h, **≥20-observation floor** | tighten if p95 settles well below. Verify the reconstruction first (§2.7) |
| page_views write errors | > 10% / 10m | > 10% / 1 h, **≥20-write floor** | lower toward 1% as volume grows |
| Auth sign-in error rate | > 30% / 15m | > 30% / 1 h, **≥5-attempt floor** | lower once sign-in volume is non-trivial. The floor already removes the "1 of 2 failed = 50%" false page |
| Toxicity scoring outage | > 50% / 15m | > 50% / 1 h, **≥5-call floor** | lower once review volume is non-trivial |
| Moderation queue backlog | > 48h | **no alert** — dashboard + daily checklist row 8 | tighten toward the 24h internal target (§17); move cron hourly if needed. **The daily read is the only control** |
| Linear pipeline failure | > 50% / 1h | > 50% / 1 h, **≥3-attempt floor** | lower once baseline request volume is known |
| Linear webhook HMAC failures | > 3 / 1h | > 3 / 1 h, unchanged | fine as-is (security signal) |
| WAF rate-limit spike | > 500 / 15m | **> 2,000 / 1 h** — the only rescaled threshold | set once baseline mitigation volume is known. The 4× is the window rescale, not a policy change — keep that in mind when re-tuning |
| Retention prune runaway | > 5,000 rows / table / 1d | unchanged | leave it until the prune actually starts deleting (~2026-11) |
| Data-quality check (warn) | any > 0, **non-paging** (AECI-279) | **no alert** — dashboard + digest | mute/relax individual warn checks that prove noisy (e.g. known duplicate candidates) |
| *(new)* Cron job failed — combined | n/a | any failure heartbeat > 0, hourly | do not add a floor. A cron failing once is a real event, and the `label_column` tells you which |
| *(new)* Per-cron staleness | n/a | 26 h daily jobs · 90 min the `*/15` reconcile · 180 min the hourly poll (`observability/posthog/project-config.json`) | these are the *sweep's* allowances and already include margin for the sweep's own lateness. Tighten only if a cron's schedule changes |

### Home stats-card content tunables (AECI-280 / Phase 8.2)

Unlike the monitors above, these are **compute constants** in `apps/api/src/lib/home-stats.ts` — the
source/weighting knobs for the home "Trending products this week" card. Change the constant and ship via a
normal deploy/promote; the daily `0 7 * * *` cron **and** every successful `POST /api/promote` recompute
`home.trending_products`. Values were set from the **2026-07-12 prod traffic pull** (see
[`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md)); revisit against ~30 days of traffic and
once the PostHog join lands.

| Constant | Current | Retune signal |
|---|---|---|
| `TRENDING_WINDOW_DAYS` | 7 | validated (7d had 646 product-page views across 124 products); widen only if trending routinely under-fills at steady state |
| `TRENDING_LIMIT` | 5 | validated (top-5 well-separated: 17/17/17/12/12); raising it also requires bumping the `home.trending_products` Zod `.max(5)` cap in `@aeci/shared` **and** the web fallback `.slice(0, 5)` |
| `TRENDING_MIN_VIEWS` | 3 | the honesty floor. **Since AECI-582 (2026-08-13) `computeTrendingProducts` filters on the digest's `HUMAN` predicate**, so the card and the operator's numbers rank the same population; before that it counted every view, and crawlers dominate — of 1,121 product views in the trailing 7 days, only **74** were human, so the card was ranking products by how hard they were being scraped. Consequence: the floor is **no longer inert**. On the day the filter landed exactly 9 products cleared it on human views (8/8/5/4/4/3/3/3/3) — enough to fill the top-5, but a quiet week now falls back to recently-added. Lower it if that fallback starts firing at healthy traffic |

Deferred to the AECI-280 ~30d follow-up: the PostHog-join weighting + recency decay, and the
card-resonance/swap review once PostHog + RUM have real volume.

### Trade publication floor (AECI-539 / AECI-546)

Also a compute constant rather than a monitor: `TRADE_PUBLISH_MIN_PRODUCTS` in
`packages/shared/src/api/taxonomy.ts`. `TRADES_VOCABULARY.md` §6 names it launch-tunable and points
here, so it is listed for real.

| Constant | Current | Retune signal |
|---|---|---|
| `TRADE_PUBLISH_MIN_PRODUCTS` | 1 | The floor a trade must clear before its `/trades/:slug` page is listed, indexed, sitemapped, and pinged. **Already retuned once: 3 → 1 on 2026-08-14.** The AECI-547 backfill landed and left 7 of the 34 terms carrying products (roofing 5, hvac-mechanical 3, electrical 2, sitework-utilities 2, and three at 1); a floor of 3 published only 2 of them, so the floor — not tagging coverage — was what suppressed the namespace. At 1 it withholds only the 27 zero-product terms, and single-product pages are deliberately admitted. **Raising it back** is justified if published trade pages read as thin *while tagging is healthy* — the §1.1 test is whether the page answers "what understands MY work" rather than duplicating the all-products list — or if the single-product pages measurably underperform in Search Console (impressions without clicks, or exclusion as "Crawled – currently not indexed"). Give them a full indexing cycle first. **Do not raise it to hide an under-tagged catalog**: an under-tagged catalog and an over-permissive floor look identical in the term count, but the fix for the first is tagging, and raising the floor only hides the symptom. There is no headroom left below — 1 is the minimum meaningful value, since 0 would publish all 34 terms including 27 empty pages. |

Changing it is a normal deploy — no migration, no redirect (an unpublished trade already resolves at
its permanent URL, so a term crossing the floor simply becomes indexable). Two follow-ups the deploy
does **not** do for you, both because a floor change moves terms across the gate without any promote
behind it:

1. **Purge `sitemap`, `index:trades`, and `taxonomy`**, or the edge serves the old membership until
   the TTLs lapse. The automatic purge is a promote hook; there is no promote here.
2. **Announce the newly indexable term URLs.** The IndexNow ping (Google's was removed in AECI-747 — it only ever accepted `JobPosting`/`BroadcastEvent`) is the same
   promote hook, so nothing tells an indexing service the pages exist. Run
   `pnpm --filter @aeci/api ops:submit-trade-urls -- --env production` (dry-run) to see the set, then
   re-run with `--apply --allow-production`. It verifies each page really serves without `noindex`
   before submitting, so run it **after** the purge — if the edge is still serving the old
   membership, it will correctly refuse rather than ping `noindex` pages.

### 3a-bis. Crawler visibility of the listing pages (AECI-746)

> **A listing page can look perfect in a browser and be empty to Google.** Until
> AECI-746, `/products` and every taxonomy browse page server-rendered their error
> branch — "Couldn't load products. Refresh to try again." — with zero product
> links. The grid fetched its data with a RELATIVE `/api/products` URL, which
> resolves fine in a browser (against the page origin) and does not fetch during
> SSR on the edge. Every crawler reads the raw HTML and does not run our
> JavaScript on its first pass, so every crawler saw the error.
>
> Measured cost, August 2026: **Googlebot reached 177 of the 1,445 sitemap URLs
> (12%)** while **Bingbot reached 940 (65%)**. Bing is fine because IndexNow pushes
> URLs to it directly and it never has to discover anything by crawling; Google
> has no working push channel (its Indexing API is documented for `JobPosting` /
> `BroadcastEvent` only), so it must crawl — and every hub page was a dead end.
> Googlebot spent 260 of its 983 monthly crawls on `/` alone and fetched the
> sitemap twice.
>
> **Check it with one command, against a DEPLOYED environment:**
>
> ```bash
> ./scripts/check-ssr-listings.sh https://www.aecintegrations.com
> ```
>
> It counts product links in the raw HTML of five listing pages and exits non-zero
> if any is a dead end. Run it after any change to `createPaginatedIndex`, the
> listing routes, or the SSR data path — and as a spot check when Search Console
> coverage looks wrong.
>
> **Local dev cannot answer this question.** Under `wrangler dev` the relative URL
> resolves to `http://localhost:<port>` and succeeds, so local passes with *and
> without* the fix (verified 2026-08-31). A green local run means "no regression",
> not "fixed". Use preview, staging, or production.

### 3b. Traffic classification — auditing the digest's "humans" (AECI-526 follow-up)

> **Since AECI-741 the digest's HEADLINE is the post-automation figure**, not the raw
> server-side count. Subject and primary stat both read *"N human views after automation"*, with
> the raw count demoted to a sub-line beside it. Read the sections below with that in mind: where
> they say "the headline is an upper bound" they now describe the **sub-line**.
>
> **Two properties of the new headline that are load-bearing.** Its day-over-day delta is computed
> **filtered-against-filtered** — `detectSwarms` runs over the prior day too, because comparing a
> filtered day against an unfiltered prior day would print a fabricated collapse every morning.
> And "the detector ran and flagged nothing" renders differently from "the detector did not run":
> the second prints the raw count *plus an explicit UNFILTERED warning*, because a failed detector
> must never be able to look like a clean day.
>
> **And since AECI-745 (2026-09-01) you do not have to open the email to read it.**
> `/admin/overview` leads with the same post-automation figure, from the same
> `humanViewsAfterAutomation()` call — the collector now runs the detector, so both surfaces
> subtract one number by construction rather than by two callers agreeing. The daily read below
> can be done on the panel; the email remains the push. Two differences to hold onto when you do:
> the panel's **7-day delta and 30-day chart are RAW** (filtering them means re-running the
> detector over every day they span, and the tile's caption says so), and the filtered *series*
> is the snapshot-only metric `traffic.page_views_human_after_automation`, which **starts the day
> the cron first wrote it** — it is not backfillable, so earlier days are absent rather than zero.
>
> **The raw figure remains an UPPER bound — and since 2026-08-26 the email says so
> itself.** AECI-658 / AECI-660 changed three things, so the number no longer has to be mentally
> corrected by whoever reads it:
>
> - The subject line qualifies the raw count (**"(N raw)"**, or **"up to N human views"** when the
>   filter did not run), and the body labels it an upper bound. `page_views` is written
>   server-side on every full-document load, so any crawler that does not run JavaScript is still
>   in it.
> - A **lower bound** is reported beside it: the PostHog count for the same UTC day and host
>   (`lib/posthog-query.ts`). PostHog fires only when JS runs *and* the visitor consented, so a real
>   person who declines is invisible. The truth is between the two, and a large gap means most
>   arrivals never ran our JavaScript. Needs `POSTHOG_QUERY_API_KEY` + `POSTHOG_PROJECT_ID`; absent,
>   the email says the floor is unavailable and never prints a fabricated `0`.
> - An **Automation signal** line appears when the swarm detector (below) flags anything.
> - Since **AECI-683** a **corroborated floor** is printed beside the two bounds: human views that
>   arrived with a NAMED external search or social referrer, and the §9.8 visitors behind them.
>   It is the only one of the three figures a rotating-proxy pool cannot inflate — a proxy sends
>   no `Referer` at all. Read it as a floor (Referrer-Policy strips real referrals into `Direct`)
>   and remember it rests on a **claim** (§9.7 — production holds one confirmed forgery).
>   A **third caveat, and the one that actually bit** (AECI-743): the floor counts ROWS, and until
>   2026-09-01 nothing guaranteed one document load wrote one row. The 2026-08-29 digest printed
>   "Google — 2 views" off a single arrival counted twice, 83 ms apart — a 100% error on the very
>   figure chosen because it could not be inflated. Ingest now refuses a duplicate
>   (`API_CONTRACTS.md` §6.9, "One document load, one row"), but **rows written before that date are
>   not repairable**, so any floor quoted from an earlier day needs checking against
>   `scripts/ops/2026-09-page-view-duplicates/find-duplicates.sql`. Two days are wrong:
>   2026-08-29 (2 → 1) and 2026-08-18 (4 → 3).
>
> The worked example that forced this: on **2026-08-23** the digest emailed "48 human views."
> PostHog for the same day recorded **5 pageviews from 1 person**, and those five were the
> operator's own session, which the digest had already excluded. The 48 produced **zero**
> client-side events.
>
> **And the example that forced AECI-683, three days later.** On **2026-08-26** the digest emailed
> "up to 102 human views" and the PostHog floor read "47 page views from 1 person" — so it looked
> like the pair was working. It was not: that *one person was the operator*, whose client tracker
> has no operator suppression. Decomposed against prod D1, the 102 were ~22 operator views a
> **lapsed admin session** left unflagged, 26 correctly-flagged swarm, ~35-40 automation sitting
> under the thresholds, and **8 views from 7 visitors** that a named external referrer corroborates.
> Both bounds were measuring the operator; only the third figure tracked people.

#### The rotating-proxy swarm detector (AECI-658)

`lib/swarm-detection.ts` groups a window's human views by `user_agent_hash` and flags a hash whose
views came overwhelmingly from *different networks*. The 2026-08-23 shape it was built from: 48 views
across **44 ASNs and 31 countries** but only **18 UA hashes**, with one hash reading nine different
pages from nine different countries on nine different networks and never repeating one.

`cf_asn` shatters a swarm like that into 44 apparent visitors; `user_agent_hash` reassembles it into
seven. It is the same join AECI-582's backfill used retroactively (`recover-ua-names.sql`), pointed
forward at live traffic.

**Since AECI-742 a hash is not re-adjudicated from scratch every morning.** The ratio test was
evaluated per-day and independently each day, so a swarm that happened to reuse one network on a
quiet day dropped under `SWARM_MIN_ASN_RATIO` and was counted as a person for that day.
`53304b2e...` was flagged on 8/29 at ratio 1.00 and escaped on 8/30 at 0.70; `02048353...` did the
exact inverse. Between them that was **18 of the 37 residual views** across those two days - the
largest single bucket left in the post-automation headline, and not a different client but the same
one on a quieter day.

`detectUaHashSwarms` now carries a **prior**: a hash flagged on `SWARM_PRIOR_MIN_FLAGGED_DAYS` of the
previous `SWARM_PRIOR_LOOKBACK_DAYS` days is held to `SWARM_RECURRING_ASN_RATIO` /
`SWARM_RECURRING_MIN_VIEWS` instead of the standing pair, and `SwarmCandidate.priorFlaggedDays`
records how much history justified it. **Three properties are load-bearing, and any retune has to
preserve all three:**

- **The prior is built at FULL strength only** - never from a relaxed flag. Otherwise the memory
  bootstraps itself: a relaxed flag would justify tomorrow's relaxed flag, and a hash that once
  crossed the line could never get back out however it behaved.
- **The lookback ends at the reported window's start**, so a day never counts toward its own prior.
- **The bar is lowered, not removed.** `SWARM_RECURRING_ASN_RATIO` must stay above zero, or the
  prior becomes a permanent one-way list.

It also **binds a fixed number of parameters** (ten in the emitted statement — the window bounds, the
path prefixes, and the retro-join's two offsets) regardless of how many hashes exist, for the reason
the operator retro-join is written the same way.

**The one thing that read is expensive without: `page_views_operator_pair_idx` (migration 0019).**
`NOT_INTERNAL`'s retro-join is a correlated `EXISTS`, so absent that partial index the planner runs a
full `SCAN op` per candidate row rather than a covering-index lookup. Measured over 41k rows that is
**8 ms with the index against 4.3 s without**; against prod-shaped data a 14-day window costs
**14 s and 42.7M rows read** with the index missing, versus 5 ms for the same grouping with the
retro-join removed entirely. The index ships in the same migration as the retro-join that needs it
and `promote-to-prod` applies migrations, so the two cannot separate in a promoted environment — but
**if this read ever looks slow, check `sqlite_master` for that index before tuning any threshold.**

**Swept over production for the 16 days to 2026-08-30** (read-only `SELECT` against prod D1), the
relaxed bar adds **82 views** and - this is the number that matters - **every hash it newly flags is
already one of the eight known swarm hashes.** No hash outside that set is admitted on any day. The
digest also says out loud when the lower bar applied, because a reader comparing the note against the
day's own rows would otherwise find a candidate sitting under the published threshold and conclude
the detector had drifted.

#### The user-agent rotator detector — the exact inverse (AECI-683)

A grouping is blind to whatever it groups **on**. Rotate the user-agent instead of the IP and the
detector above collapses: on **2026-08-26**, AS47544 (IQ PL Sp. z o.o., Poland) read five product
pages under **four distinct UA hashes**, so every group was a singleton, every one was under
`SWARM_MIN_VIEWS`, and the day counted five visitors.

`detectAsnRotators` is the mirror image — group by `cf_asn`, flag one network serving nearly a new
fingerprint per request. Between them the two groupings cover both ways a client dilutes itself:
many networks behind one fingerprint, or many fingerprints behind one network.

**The request-shape verdict is a HARD GATE here, and that is the difference.** For a UA hash,
spanning many networks is anomalous on its own and `nonBrowserViews` is corroboration a reader
weighs. For an ASN it is the reverse — a high UA-hash ratio is the *normal* shape of any shared
network (an office NAT, a campus, a café), so cardinality alone would flag real people constantly.
A rotator cannot launder the shape of its own requests. Without the gate this is a
shared-connection detector wearing a bot detector's name.

#### The verdict as sufficient evidence, with no floor (AECI-744)

Both groupings above check a **view-count floor before any evidence is weighed** (`SWARM_MIN_VIEWS` /
`ASN_ROTATOR_MIN_VIEWS`, enforced in SQL as `HAVING count(*) >= …`). A group under the floor never
reaches the code that reads its `client_verdict`, so a low-volume automated client was invisible no
matter how obviously non-human its requests looked.

Decomposed against production D1 on **2026-08-31**, that was **~7 of the 37 residual views** for
2026-08-29/30. The clearest case: `87012404…` — three views, three different US networks (Charter,
**Rockion LLC**, Airfiber), one fingerprint, seventeen hours apart, ASN ratio **1.00**, and every one
of the three carrying `client_verdict = 'inconsistent'`. Under the floor by exactly one view. Four
more singletons the same two days carried `non-browser` / `inconsistent` on cloud and hosting ASNs
(Shanghai UCloud AS23724, "365 Group" AS18450, a DE "Private Customer", a KR host).

**The floors are right for what they protect, and wrong here.** They exist because a *ratio* over a
tiny sample is meaningless — one view is trivially "1 ASN for 1 view". But `client_verdict` is not a
ratio and not an inference over a sample: it is a direct observation about the headers of *that*
request. It needs no sample size to mean something. So `detectNonBrowserClients` flags **per row**,
with no floor, no grouping and no ratio, and reports a descriptive by-network rollup
(`verdictCandidates`) purely so the operator can see which networks without querying D1.

That makes **three** uses of `client_verdict`, deliberately not interchangeable — the module header
names which call site uses which, and so does this table:

| Use | Where | Meaning |
|---|---|---|
| **Hard gate** | `detectAsnRotators` | Required. Cardinality alone is the normal shape of any shared network. |
| **Corroboration** | `detectUaHashSwarms` | Reported beside the ratios (`nonBrowserViews`); filters nothing. |
| **Sufficient** | `detectNonBrowserClients` | Decides on its own, per row, no floor. |

All three are **NULL-safe**, and that is a constraint not a detail: `IN` against a NULL verdict is
NULL, so every row written before the column shipped (and every `'browser'` / `'unknown'` row) counts
as **no evidence**, never as "not a browser". `analytics-digest.ts`'s `notFlagged()` complement
carries the same NULL-safety on the same axis — a NULL-verdict row counts in the headline, so it must
survive the tables.

**Still read-side only.** No `is_bot` write, and the commercial proxy/seedbox ASNs this surfaced
(RapidSeedbox AS214483, Web2Objects AS62874, UAB code200/Oxylabs AS27411, Rockion AS199737) did
**not** join `DATACENTER_ASNS` — see the standing rule below.

`swarmFlaggedViews` is a **union** across all three shapes, never a sum: a view can match more than
one, and adding the totals would report more suspicious views than the day contained.

**Launch-tunable thresholds** (§3 rules apply — change them here and in the module together):

| Constant | Value | Why |
|---|---|---|
| `SWARM_MIN_VIEWS` | `4` | Below this the ratios are noise; one view is trivially "1 ASN for 1 view". |
| `SWARM_MIN_ASN_RATIO` | `0.8` | "Nearly every view came from a different network." A real browser sits on one network; a proxy pool cannot. |
| `ASN_ROTATOR_MIN_VIEWS` | `4` | Same floor, same reason. A separate constant even though the values match: the two groupings have different false-positive profiles and will be tuned apart. |
| `ASN_ROTATOR_MIN_UA_RATIO` | `0.8` | "Nearly every request wore a different fingerprint." A UA changes on browser update, not between page loads. **Validated at exactly this value**: the AS47544 shape is 4 hashes over 5 views = 0.80, so `0.85` would have missed it. |
| *(the verdict signal)* | *none* | `detectNonBrowserClients` has **no threshold by design** (AECI-744) — listed here so its absence reads as a decision rather than an oversight. Adding a floor would reintroduce the defect. The only tunable is the vocabulary itself, `NON_BROWSER_VERDICTS`, and a value added there must be added to the digest's `AutomationExclusion.verdicts` in the same change. |
| `SWARM_MAX_CANDIDATES` | `25` | Caps each candidate list, because the union count binds one parameter per flagged hash/ASN and D1's parameter ceiling is far below stock SQLite's. `swarmNote` says when it bit; the cap is never silent. The cap is applied BEFORE the union read, so AECI-742's longer candidate list makes truncation more likely and never the bound looser. It also caps `verdictCandidates`, but only for display: those views are flagged per row in SQL, so slicing the list cannot remove one from the count. |
| `SWARM_PRIOR_LOOKBACK_DAYS` | `14` | How far back the recurrence read looks for a hash's flagged history (AECI-742). Ends at the reported window's start, never inside it. Long enough to survive a client pausing over a weekend, short enough to forgive a hash that reformed within a fortnight. `page_views` is retained 400 days, so the ceiling here is judgement, not retention. |
| `SWARM_PRIOR_MIN_FLAGGED_DAYS` | `2` | Flagged days inside the lookback before a hash counts as recurring. Two, not one: one flagged day is the evidence the per-day test already acted on, so requiring one would merely re-apply yesterday's verdict. The eight hashes this was built from ran **every** day of 2026-08-21..30. |
| `SWARM_RECURRING_ASN_RATIO` | `0.5` | The ratio a recurring hash is held to instead of `SWARM_MIN_ASN_RATIO`. Both measured escapes sit above it (0.70 and 0.63) and below the standing 0.8. **Must stay above zero** - a prior lowers the bar, it does not remove it. |
| `SWARM_RECURRING_MIN_VIEWS` | `2` | The view floor a recurring hash is held to instead of `SWARM_MIN_VIEWS`. The 4-view floor exists because ratios over 1-3 views are noise *when nothing else is known*; a fortnight of flagged history is something else being known. Still two rather than one: a single view is trivially ratio 1.0 and would let the prior decide alone. |
| `OPERATOR_PAIR_LOOKBACK_DAYS` | `30` | How far either side of a row the operator retro-join looks for an `is_operator = 1` anchor on the same `(user_agent_hash, cf_asn)` pair (below). Symmetric, because a lapse can precede the session's first flagged row as easily as follow its last. |

**Measured false-positive rate, and the honest caveat on it.** Swept across production for the 30
days to 2026-08-27, the ASN detector fires **exactly once** — AS47544 on 2026-08-26 — and flags no
other network. But `client_verdict` did not exist before the AECI-658 deploy landed on **2026-08-26**
(0 rows carry one on 08-25, 877 of 918 on 08-26), and the gate treats a NULL verdict as *no
evidence*. So that sweep is really **two days of evidence, not thirty**. Re-run it after a month of
verdict coverage before concluding the thresholds are right.

```bash
cd apps/api && pnpm exec wrangler d1 execute aeci-app-production --env production --remote \
  --command "WITH pop AS (SELECT * FROM page_views WHERE created_at >= date('now','-30 days')
                 AND is_bot = 0 AND path NOT LIKE '/admin%' AND path NOT LIKE '/account%'
                 AND (is_operator IS NULL OR is_operator = 0))
             SELECT substr(created_at,1,10) d, cf_asn, max(cf_as_organization) org, count(*) views,
                    count(DISTINCT user_agent_hash) uas,
                    sum(CASE WHEN client_verdict IN ('inconsistent','non-browser') THEN 1 ELSE 0 END) nb
               FROM pop WHERE cf_asn IS NOT NULL GROUP BY 1,2
              HAVING views >= 4 AND (uas*1.0/views) >= 0.8 AND nb > views/2.0 ORDER BY 1 DESC"
```

#### The operator session-lapse retro-join (AECI-683)

`is_operator` is decided **once, at ingest**, and `lib/operator-session.ts` resolves every failure to
`false` — deliberately, so an auth hiccup costs a flag rather than the page-view row. **An expired
access token is one of those failures.** An operator browsing across a token expiry therefore writes
flagged rows, then unflagged rows, then flagged rows again, and nothing on the unflagged ones
distinguishes them from a visitor. On 2026-08-26 that was **22 views in one 105-minute gap**, ending
on `/auth/login` — which is what a lapse looks like from the outside.

`NOT_INTERNAL` (`lib/analytics-digest.ts`) now carries a third half: a correlated `NOT EXISTS` that
excludes a row sharing a `(user_agent_hash, cf_asn)` pair with a verified operator row within
`OPERATOR_PAIR_LOOKBACK_DAYS`. Four things about it are load-bearing:

- **The pair, never either half.** Measured 2026-08-19 (`operator-pairs.sql`): the operator's second
  browser hash spans **6 ASNs across 5 countries**, so flagging the hash deletes real visitors in
  four countries; and "everything from Indonesia" was 44% false positives at 50% recall. The pair is
  also exactly the tuple §9.8 already calls a "visitor".
- **Anchors come from `is_operator = 1` only.** The ops backfill could also prove a pair from an
  `/admin*` row, because no visitor reaches one. That is gone: since AECI-575's write-side guard,
  untracked routes are not written **at all**. `/account` would be wrong regardless — every
  signed-in member reaches it.
- **It is an INFERENCE, so it is reported.** The path and session halves are facts about the request
  and are excluded silently. This one is a judgement about identity, so the digest prints
  `operatorLeakViews`, `job_runs` records it, and `/admin/overview` returns
  `operator_leak_excluded` with an `operator_leak_is_an_inference` note. Silence here would be the
  same failure the headline number itself was guilty of.
- **It does not reach every leaked row, by design.** On 2026-08-26 the decomposition put ~26 views on
  the operator; the rule recovers **22**. The other four sit on UA hashes that never carried an
  `is_operator = 1` row of their own, so no pair proves them. Recovering those would mean widening to
  the ASN, which is the rule measured to be wrong in both directions.

It is served by the partial index `page_views_operator_pair_idx` (`(user_agent_hash, cf_asn,
created_at) WHERE is_operator = 1`), which stores entries only for operator rows — a few hundred of
~27k — so the write cost on the app's hottest table is effectively zero. Confirm with
`EXPLAIN QUERY PLAN`; it should read `SEARCH op USING COVERING INDEX page_views_operator_pair_idx`.

**Known ceiling — it works because we are small.** A `user_agent_hash` is a browser *build*
fingerprint, not a person: thousands of unrelated people share "Chrome 128 on Windows 10" exactly, so
at real volume a popular hash legitimately spans many ASNs and cardinality alone would light up
constantly. The signal that survives growth is the **combination** with `client_verdict` — a
high-cardinality hash whose rows are *also* mostly `inconsistent` / `non-browser`. That is what
`nonBrowserViews` and `isCorroboratedByRequestShape()` are for; read them alongside the ratios, never
the ratios alone. Revisit both thresholds when human volume passes a few hundred views/day.

**It never writes `is_bot`, and must not start.** The rule from AECI-582 is unchanged and applies
doubly here: do **not** widen `DATACENTER_ASNS` to catch a residential-proxy swarm. Those ASNs are
genuine consumer ISPs — that is the entire point of a residential proxy — and the map drives the
**live** classifier, so listing them would classify real people's ISPs as datacenters.


The digest's headline **Traffic (humans)** filters on `page_views.is_bot IS NOT 1`, written at ingest by
`classifyTraffic(ua, asn)` (`apps/api/src/lib/bot-classification.ts`). The UA half is reliable — crawlers
self-name. The **ASN half is a hand-maintained list** and is the weak point: CF Pro yields no bot score, so
a headless browser on a hosting IP with a spoofed Chrome UA reads as human until its ASN is on the list.
This is not hypothetical — the 2026-08-03 digest reported **166 "humans" of which ≥149 were
datacenter/VPN/scanner networks**, 107 from one unlisted colocation provider (AS47007).

**Since AECI-624 the panel does part of this audit for you — but only part.** The §7.6 `asn_registry`
annotates each Activity row and each `dimension=asn` group with what the network is *registered as*
(`/admin/traffic` → Networks; a group reading "not a browsing network" with real view counts is the
tell). It deliberately does **not** change `is_bot`, so the census below is still the thing that
decides whether an ASN joins `DATACENTER_ASNS`. Two limits worth holding in mind while reading the
annotation: PeeringDB has no usable signal for ~25% of our traffic, and `Content` includes Google and
Netflix — it means "not an eyeball network", never "hosting". The annotation narrows the list of ASNs
worth censusing; it does not replace the judgement.

**Weekly audit** — census the ASNs that came through as human, and name them:

```bash
cd apps/api && pnpm exec wrangler d1 execute aeci-app-production --env production --remote \
  --command "SELECT cf_asn, COUNT(*) n, COUNT(DISTINCT user_agent_hash) uas, COUNT(DISTINCT path) paths
             FROM page_views pv WHERE created_at >= date('now','-7 days') AND is_bot = 0
               AND path NOT IN ('/admin','/account') AND path NOT LIKE '/admin/%' AND path NOT LIKE '/account/%'
               AND (is_operator IS NULL OR is_operator = 0)
               AND NOT EXISTS (SELECT 1 FROM page_views op WHERE op.is_operator = 1
                                AND op.user_agent_hash = pv.user_agent_hash AND op.cf_asn = pv.cf_asn
                                AND op.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', pv.created_at, '-30 days')
                                AND op.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', pv.created_at, '+30 days'))
             GROUP BY 1 ORDER BY n DESC LIMIT 40"
# then, per suspicious ASN:
curl -s "https://stat.ripe.net/data/as-overview/data.json?resource=AS47007" | jq -r .data.holder
```

Tells that an "ASN" is really automation: one ASN dominating the day; a handful of UA hashes covering
dozens of paths; many single `/` hits from many countries inside one short window (a residential-proxy
sweep); a holder name containing hosting / cloud / server / VPS / colo / datacenter.

The `is_operator` clause (§13 D13) matters here more than anywhere else, because **the operator's own
ASN is the single most likely "one ASN dominating the day"** and misreading it as automation is how a
residential ISP ends up in `DATACENTER_ASNS` — the exact false positive the membership rule below
forbids. It only covers rows written from 2026-08-19 onward; on older windows the operator's own
network will still show up near the top and must be recognised rather than listed.

The `NOT EXISTS` clause beside it is the AECI-683 retro-join, and it matters here for the same
reason and then some: the rows it catches are the operator's, they carry no flag saying so, and a
census that counts them will rank the operator's ISP first on exactly the days their session
lapsed. Both clauses, always — `NOT_INTERNAL` is one predicate in code precisely so a hand-written
query is the only place they can come apart.

**Widening the list** (the fix): add `[asn, 'Datacenter (Holder)']` to `DATACENTER_ASNS`, then regenerate
`scripts/ops/backfill-page-view-bots.sql` to match — `bot-classification.spec.ts` parses that SQL and fails
CI on drift. The membership rule and the deliberate exclusions (Apple/Private Relay, Zscaler and other
corporate proxies, Tor, mixed consumer/IDC networks, tier-1 transit) are documented at the top of the map;
**a false positive silently deletes a real visitor, which is worse than counting a crawler** — verify the
holder before adding.

**Backfilling history — done 2026-08-13 (AECI-582), on all four tiers.** Rows captured before the
classifier shipped had `is_bot IS NULL` and read as **human**, so every historical day and every
day-over-day delta over-counted humans. Production's 17,784 such rows are now classified and its
"reads as human" total fell **18,322 → 2,096**. Re-run after a widening with the guarded runner, which
dry-runs, exports `page_views` and verifies around both SQL files:

```bash
scripts/ops/2026-08-page-view-bot-backfill/run.sh --env production            # dry-run
scripts/ops/2026-08-page-view-bot-backfill/run.sh --env production --apply --allow-production
```

Two things to know before relying on it again. **(1)** It only reaches rows that are still null, and the
2026-08-13 run swept every remaining row to `is_bot = 0` — so newly-listed ASNs now need a targeted
`UPDATE page_views SET is_bot = 1, bot_name = '…' WHERE is_bot = 0 AND cf_asn IN (…)`, and the
"never classified" signal no longer exists to find them by. **(2)** The runner applies
`2026-08-page-view-bot-backfill/recover-ua-names.sql` *first*, which recovers a crawler's **real name**
by matching `user_agent_hash` against rows the live classifier has since named. That works because
`classifyTraffic()` tests the UA before the ASN, so such a verdict is UA-derived and transfers across
ASNs — it is how 885 `Applebot` rows on **AS714 (Apple)** were classified without adding Apple to
`DATACENTER_ASNS`. Reach for that technique before widening the list against an ASN the map excludes
on purpose: the map drives the live classifier too, and the exclusions exist to protect real people.

The path-exclusion clauses above mirror the digest, which since **AECI-575** excludes the operator-only
routes (`/admin/*`, `/account`) from every `page_views` read. Leave them in or the census will rank the
operator's own ISP first and you will spend the audit chasing yourself — on the 2026-08-10 digest day
**67 of 92 "human" views were the operator** (AS23700, Jakarta). Drop them only when you deliberately want
the unfiltered table.

**Known ceiling**: the durable fix is not a longer list — it is capturing Cloudflare's `asOrganization`
(available on all plans, unlike the bot score) at ingest and matching on the holder name, plus the PostHog
join (AECI-239) as the human source of truth. AECI-575 removed the one slice of internal traffic that could
be excluded **precisely** (operator navigation on authed surfaces, zero false positives); what remains is
genuine visitors sharing the operator's ISP, which only `ANALYTICS_INTERNAL_ASNS`
(`ADMIN_PANEL_SPEC.md` §13 D10, unbuilt) or the holder-name fix can separate. Until then, treat the digest's
human count as an **upper bound**.

**Half of that fix has landed: `page_views.cf_as_organization`** (AECI-585 / §13 D10) captures the holder
name at ingest, so from that deploy forward the `curl stat.ripe.net` step above is only needed for
**older** rows — the census query can select `cf_as_organization` directly and read the holder off the
result. It changes nothing about the audit's doctrine: the name is a **read-side label**, it never feeds
`is_bot` at ingest, and widening `DATACENTER_ASNS` remains the only thing that writes a classification, with
the same "a false positive silently deletes a real visitor" rule. Two limits to keep in mind — it is null on
every row written before the deploy and is not backfillable, and matching *on* the holder name is still
unbuilt: this is the capture, not the classifier.

### Attestation detector + vendor-portal tunables (AECI-302 / `STAGE_2_ATTESTATIONS_SPEC.md` §7.1; AECI-516 / `STAGE_2_REALTIME_SPEC.md` §4.4)

Like the home-stats knobs, these are **compute constants**, not monitor thresholds — change the
constant and ship via a normal deploy/promote. The **first six** live in the API Worker and govern
the daily `0 10 * * *` sweep that emails vendors about one-sided, conflicting or stale attestations.
The **last two rows** cover **four named exports** from the **web** bundle that govern how often a
signed-in vendor portal revalidates itself: per ADR 0023 the portal **polls a freshness cursor
rather than holding a socket**, so the interval *is* the freshness contract and is deliberately
operator-visible here. They are exported (rather than module-private literals) specifically so the
component specs assert against the constant and an operator can grep one name.

**Read the detector rows against adoption, not against the calendar.** Every detector keys off a *vendor's*
attestation, and nothing in D1 has one yet (promote only ever writes `source='aeci'`), so all four
fire on **zero rows** until the vendor portal is genuinely in use. Do not tighten anything on the
evidence of a quiet first month.

**And read them against a corpus roughly 14% smaller than the catalogue.** Since AECI-705
(`STAGE_2_ATTESTATIONS_SPEC.md` §14) a **connector-powered** edge — `powered_by_product_id` set, or
`mechanism_kind = 'iPaaS'`, which was 132 of 946 production edges on 2026-08-31 — can neither be
attested nor generate a vendor nudge. Those edges never enter the funnel at all, so the first three
constants below govern a smaller population than a naive `claims` count suggests: on the numbers at
merge that is **179 claims across 67 edges and 41 vendors** that will never appear in any of them.
Ops-routed findings are unaffected.

| Constant | File | Current | Retune signal |
|---|---|---|---|
| `SILENT_COUNTERPARTY_DAYS` | `lib/attestation-detectors.ts` | 14 | How long a claim may sit `single_source` before the silent side is nudged. Lower if vendors are responsive and the lag is the bottleneck; raise if nudges land before vendors have plausibly seen the portal. |
| `OPEN_CONFLICT_DAYS` | `lib/attestation-detectors.ts` | 7 | An unresolved `conflict` past this nudges both disputants **and** raises AECi ops. Tightest of the three by design (lowest volume, highest signal). Raise only if ops finds it noisy. |
| `STALE_VERSION_MONTHS` | `lib/attestation-detectors.ts` | 12 | Age at which a stampless vendor attestation is asked to re-confirm. **Do not lower without thinking about the corpus**: nothing carries version stamps, so this effectively schedules a re-confirm ask for *every* vendor attestation N months after it was made. 12 = annual cadence. |
| `NOTIFICATION_SUPPRESSION_DAYS` | `lib/attestation-notify.ts` | 30 | The anti-nag control: how long a delivered notification blocks a repeat of the same (claim, detector, recipient). The single most important knob if vendors report feeling chased. |
| `NOTIFY_BATCH_CAP` | `lib/attestation-notify.ts` | 200 | Sends per run. A first-adoption backstop, not a design limit — the next daily sweep continues the backlog, and a capped run logs the dropped count (`aeci.attestation.notify.capped`, a **warn log** — there is no metric, so it is invisible to every alert on both planes). Raise if that log recurs. |
| `NOTIFICATION_HISTORY_DAYS` / `NOTIFICATION_PAGE_SIZE` | `routes/vendor-notifications.ts` | 90 / 50 | The in-portal list's window and cap. The window is deliberately longer than the suppression window so a vendor can see the nudge currently suppressing a repeat. |
| `VENDOR_SYNC_FOCUSED_INTERVAL_MS` / `VENDOR_SYNC_UNFOCUSED_INTERVAL_MS` (hidden = no timer) | `vendor/vendor-live-sync.ts` (web) | 20 s / 60 s / paused | How fast a live portal notices a change it did not make (AECI-629 / `STAGE_2_REALTIME_SPEC.md` §4.1). **The `aeci.api.vendor.updates{changed:none}` ratio is the evidence** — a high `none` share means the cadence outruns how often the portal actually changes, so **lengthen the interval first**; a high `some` share is the opposite finding and is ADR 0023's third re-open condition (adopt a Durable Object), not a reason to poll harder. **Read `some` as an upper bound** — the endpoint is stateless, so the tag means "a cursor moved within 60 s of this response", and one write can be tagged `some` on three consecutive polls of a focused client (`OBSERVABILITY.md`). Hidden is **paused with no timer** rather than slowed: the tab polls immediately on `visibilitychange`, so a resumed tab is correct in one round trip. `online` is answered immediately **only while visible** — a flapping connection would otherwise wake a hidden tab repeatedly. |
| `VENDOR_SYNC_BACKOFF_BASE_MS` / `VENDOR_SYNC_BACKOFF_CAP_MS` | `vendor/vendor-live-sync.ts` (web) | 20 s / 160 s | The error backoff: `min(20 s × 2ⁿ, 160 s)`, reset on the first success. **It is floored at the current poll interval** (`Math.max(base, backoff)`), so a *focused* tab sees 20 → 40 → 80 → 160 s while an *unfocused* one sees 60 → 60 → 80 → 160 s — without the floor the first backoff step (20 s) would be shorter than the unfocused cadence (60 s) and an outage would be answered with three times the healthy load. The cap is sized so a portal left open through an API outage settles at roughly one request every three minutes and still recovers on its own without the vendor reloading. Raise only if an outage's tail traffic is itself the problem; lowering it trades recovery latency for load during exactly the window the API is already unwell. |

---

## 4. Triage → ticket loop

When a signal regresses beyond a known launch item:

1. **Confirm it isn't expected** — e.g. a warn-severity data-quality finding (informational), a
   threshold known to be a low-volume placeholder (§3), or one of the **dual-run-specific**
   non-findings: `$web_vitals` absent (project toggle, §0a), the liveness sweep exiting 2 (no `phx_`
   key yet, §0a), a PostHog production dashboard being empty (`apply.sh` has not been run against
   354071), or a PostHog number reading lower than Datadog's on a **consent-scoped** signal — which
   is `search_performed` and every other Tier 3 event, by design.
2. **Capture evidence** — the metric name, **which plane and which PostHog project** it came from,
   the dashboard/alert link, and the time window. During the dual-run, *name the console*: "5xx rate
   1.4%" means two different things depending on where it was read, and a health-report entry that
   omits it cannot be re-checked later.
3. **Decide whether it is a product defect or a migration artefact.** These need different tickets
   and different owners. A migration artefact — a query that reads 0 because a `lower()` was missed,
   an alert that never fires because it landed in the wrong project, a number that halved because a
   signal became consent-scoped — belongs against the AECI-639 epic, not against the feature.
4. **Open a Linear issue** in the **AECi** team, label `infra`, referencing the evidence and the
   governing runbook section. Per the checkpoint convention, this pass **documents** regressions for
   Chris to file rather than auto-creating issues.
5. **Record it** in the current [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md) entry so
   the trend is visible week over week.

---

## 5. Applying alert changes (ops)

Neither plane is Terraform-managed, and the two have **opposite** conventions about where the truth
lives. Get this backwards and a change silently reverts.

### PostHog — the JSON is the truth

```bash
export POSTHOG_PERSONAL_API_KEY=phx_...       # or POSTHOG_CLI_API_KEY
./observability/posthog/apply.sh --dry-run    # plan only; no key needed
./observability/posthog/apply.sh              # apply
./observability/posthog/apply.sh --verify     # read-only drift report
```

Dashboards + insights go to **both** projects; **alerts go to production only**. Idempotent by name.
**Fix drift in `observability/posthog/*.json` and re-run — never in the UI**, because the next run
will not know. `--verify` reports a live query that no longer matches the committed one.

Two things it deliberately does not manage, each with a printed recreate recipe rather than a guessed
API call: **dashboard tile layout** (positions carry no contract) and **non-email alert delivery**
(`subscribed_users` is the only channel wired; AECi has no Slack).

**Not yet run against production (354071)** — that is operator step 3 in
`observability/posthog/README.md`, and it needs the `phx_` key. Until then the production PostHog
project has dashboards and alerts only in JSON.

### At AECI-651 — what "delete Datadog" actually means

`apply.sh` cannot and must not touch Datadog, so the teardown is manual and is an **operator** task,
not a code one. In order: delete the 26 live monitors and 5 dashboards in the Datadog UI; delete the
per-env `DD_API_KEY` Worker secrets; delete the `DATADOG_API_KEY` / `DD_APPLICATION_ID` /
`DD_CLIENT_TOKEN` GitHub secrets; then decide the Datadog account's fate. The code deletions
(transport legs, RUM, `observability/datadog/`, the `DD_SITE` vars, the CSP intake hosts) ride the
AECI-651 PR. **The gate is `stage-2 → main` plus a 2–4 week prod soak plus §2's dual-run checks
green** — in particular the histogram-p95 spot-check (§2.7) and `$web_vitals` actually arriving after
the project toggle is flipped (§0a).
