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
| **Datadog** (org `us5`, `app:aeci`, `env:production`, email `@chrisw@thewbsproject.com`) | **Everything that pages today.** All 26 monitors are live here. Field Core Web Vitals (RUM). Browser search latency/error rate. Production metric history predating the PostHog transport | Anything person-linked; anything after AECI-651 |
| **PostHog** (`aec-integrations`, **354071**, production only) | Person-linked logs (`posthogDistinctId`), `$exception` grouping, deploy `deployment` events, and the product funnels in `ANALYTICS.md` | **Alerts — none are applied to production yet.** Dashboards are applied to the **non-production** project (525793) only. Do not read a prod number off a 525793 board |
| **`/admin/*`** (`job_runs`, `page_views`, `metrics_daily`) | Cron run records, the consent-independent traffic count, D1 footprint | Absence ("it never ran" writes no row, by construction) |
| **The CI liveness sweep** (`posthog-liveness-sweep.yml`, every 3 h) | Cron **absence**, across all twelve crons — **already running** and worth reading during the dual-run | Anything about *why* a cron failed |
| **Cloudflare** (Workers observability, Security → Events) | Edge cache HIT-rate, absolute request volume, per-IP WAF detail | Application-level anything |

The rule for this pass: **read Datadog for production numbers, read the liveness sweep
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
  fire yet, and **field Core Web Vitals are Datadog-RUM-only today.** This is the one
  signal where letting AECI-651 run before the toggle is flipped would leave a real
  hole.
- **Error tracking (exception autocapture)** must be enabled on both projects too.
  **Manual capture is not gated** — `PosthogErrorHandler` → `captureException` already
  delivers `$exception` events — so the browser error path works; it just has no
  Error Tracking console to read it in until the toggle is on.

The rest of the outstanding operator checklist (the `phx_` personal key, the internal-user
exclusion, running `apply.sh` against production, deleting the two unused
`POSTHOG_KEY_*` GitHub secrets) is in `observability/posthog/README.md`. **Until the
personal key exists, the liveness sweep exits 2 on every run — "unchecked", which is
not a pass**, and deploy annotations and source-map upload warn-skip.

---

## 1. Daily monitoring checklist

A ~5-minute glance across the shipped dashboards + alerts. Nothing here should require action on a
healthy day — the point is to catch a regression before an alert's sustained-window threshold does.
**That framing matters more now than it did:** PostHog alerts evaluate **hourly**, so the daily
eyeball is the compensating control for a detection window that got four to twelve times longer.

The "Where to look" column names the Datadog surface first because that is what carries production
data today, with the PostHog successor in brackets.

| # | Signal | Where to look | Healthy | Fires as |
|---|---|---|---|---|
| 1 | **Errors** | Phase 2 — Traffic dashboard (4xx/5xx widget); `aeci.api.query.duration_ms` by `endpoint`/`status_class`; SSR logs `service:aeci-web status:error` *(PostHog: "AECi — Traffic (SSR + API)")*. **Note `status_class` only** — the raw `status`/`status_code` tags were dropped in AECI-642; the exact code is on the error log | 5xx rate < 1% | `AECi — Worker error rate high` (>1%/5m today → **hourly** after the cutover) |
| 2 | **Edge cache hit rate** | Cloudflare Workers observability dashboard (Workers & Pages → `aeci-web` → Observability) + `Cf-Cache-Status` — **in neither telemetry plane** (a native-cache HIT skips the Worker; WC-3/WC-8) | HIT majority on cacheable route classes (detail/browse/taxonomy/static) | *(no alert — `AECi — Cache hit rate low` was retired in WC-8/AECI-322)* |
| 3 | **Render latency** | Phase 2 — Traffic (p95 render per `route_class`) *(PostHog: prefer the **histogram-buckets** widget over the reconstructed p95 — see §2.7)* | p95 detail (MISS) < 1.5s | `AECi — Detail render slow` (>1.5s/10m, `cache_status:miss`) |
| 4 | **Algolia query latency / errors** | Phase 3 — Search (browser RUM `aeci.search.query`: latency p50/p95/p99, error rate) | error rate ~0; p95 within norm | *(no alert — dashboard-only)*. ⚠️ **This signal narrows at AECI-651**: the RUM action is consent-independent, its `search_performed` successor is consented-only. Read it as a funnel from then on, not a census |
| 5 | **Algolia sync + drift** | Phase 3 — Search; `aeci.algolia.sync`, `aeci.algolia.index_drift`. Also **`/admin/system`** — the sync watermark (per entity + last advance), and drift on demand via "Run data-quality checks" | drift 0; daily sync `outcome:ok` | drift / sync-failed / sync-not-running / orphan-cap monitors. **After the cutover:** sync-failed folds into the combined cron alert, drift becomes **dashboard-only**, liveness moves to the CI sweep, orphan-cap stays its own alert |
| 5a | **Data quality (10 §23.1 checks)** | **`/admin/system`** — the page opens on the **last stored 04:00 result** (AECI-583), labelled with the run's own timestamp, so the morning read needs no click and no email. "Run data-quality checks" re-runs the suite live to confirm a fix. Both are pure reads | every check *Passing*; `algolia_index_drift` *Skipped* is normal off production (no credentials) | check-error / check-warn. **After the cutover:** ERROR stays an alert (and *gains* the ability to see a check that **threw** — sentinel `-1`, which Datadog's `max(...) > 0` could not); WARN becomes dashboard + digest only |
| 6 | **Scheduled-job health (12 crons)** | **`/admin/system`** for the record — real last run, outcome and duration per job (AECI-583). **Something outside the Worker for absence** — a job that never starts leaves no row, so the no-data monitors (today) / the **CI liveness sweep** (already running) are the only signal for "it stopped firing" (see §1a) | every cron shows a recent recorded run, and emitted its heartbeat in window | the per-cron `… not running` / `… failed` monitors today; the **combined** cron-failure alert + the sweep after |
| 6a | **The CI liveness sweep itself** | GitHub Actions → `posthog-liveness-sweep` (every 3 h). Read the **latest run's conclusion**, not just the alert inbox | green | **exit 1** = a heartbeat MISSING or STALE, with a `::error::` naming the cron. **exit 2** = the sweep could not run — "UNCHECKED, **not** a pass". Expect exit 2 on every run until the `phx_` key is provisioned (§0a) |
| 7 | **Request → Linear pipeline** | Phase 6 — Requests / Moderation; `aeci.linear.issue`/`.sync`/`.reconcile.*`, `aeci.webhooks.linear.hmac_failure` *(PostHog: "AECi — Requests / Linear pipeline")* | failure rate < 50%; no persistent stuck; no HMAC burst | pipeline-failure / reconcile-stuck / reconcile-no-data / hmac monitors |
| 8 | **Moderation queue** | Phase 5 & 6 dashboards; `aeci.moderation.queue_depth` / `queue_oldest_age_hours`; `GET /api/admin/summary` (`pending_reviews`), `GET /api/admin/requests` | oldest pending < 48h (target 24h, §17) | `AECi — Moderation queue backlog` (>48h) — ⚠️ **this stops alerting at AECI-651** and becomes a dashboard read. **This row is why it is safe to drop the alert; do not skip it** |
| 9 | **Field Core Web Vitals** | Datadog **RUM → Optimize Vitals**, `aeci` app, `env:production` (p75 LCP / CLS / INP) | LCP ≤ 2.5s · CLS ≤ 0.1 · INP ≤ 200ms (`STAGE_1_PHASE_2_SPEC.md` §12) | *(no alert — read manually; see §2)*. ⚠️ **Datadog-only today**: PostHog `$web_vitals` is blocked by the project-settings toggle (§0a) |
| 10 | **Deploy markers line up with step changes** | PostHog — the annotation line across every insight (once the `phx_` key exists), or a HogQL query over the `deployment` event, which works **today** on the publishable token | a step change in any of the above coincides with a marker | *(no alert)*. `deploy_kind: auto_rollback` is an **incident** marker, not a release one — if you see one you did not expect, start there |

> **Datadog UI gotcha:** the org has three RUM apps (`aeci`, `pm-empower`, `earned-value`) and the UI
> defaults to the wrong one — select **`aeci`** (us5). CWV live under RUM → Optimize Vitals, not the
> Phase-2 dashboard (that tracks SSR `aeci.page.render.duration_ms`, not field CWV).

> **PostHog UI gotcha, the same shape:** the org has **five** projects. `aec-integrations`
> (**354071**) is production; `aec-integrations-dev` (**525793**) carries preview, staging, demo and
> stage2 together, and it is where the seven dashboards are currently applied. There is **no `env:`
> filter on any query** — the project *is* the tier boundary — so a board read in the wrong project
> is silently a different tier's numbers, with nothing on screen to say so. Also: production events
> from **before** AECI-640 carry mixed tiers (demo was pointed at the prod key), so filter by `$host`
> when reading history that far back.

### 1a. The 12 scheduled crons (row 6 detail)

Each cron emits an always-on heartbeat; **absence** of that heartbeat is the liveness signal. A green
board here means all twelve fired on schedule. Since AECI-583 each run **also** writes a `job_runs`
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
> **What owns absence, today and after.** Today: Datadog's six `notify_no_data` monitors. After
> AECI-651 — and **already running now** — the CI liveness sweep, which watches all **twelve**. It
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

**Six of these gain failure coverage they never had** — metrics-snapshot, analytics-digest,
attestation-notify, entitlement-expiry, waf-poll and the per-key half of home-stats. Several shipped
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
3. **Core Web Vitals read**: Datadog RUM → Optimize Vitals for the `aeci` app,
   `env:production`, p75 LCP / CLS / INP per page type, against the §12 budgets. The pre-launch lab audit
   ([`PERFORMANCE_AUDIT.md`](./PERFORMANCE_AUDIT.md)) flagged **CLS on detail/browse/taxonomy (0.145–0.326)**
   and **detail-page JS ~227 KB** as the likely field offenders — confirm whether the lab headroom (owned
   by **AECI-221**) actually surfaces in the field before acting. **Datadog is the only source for this
   today** — PostHog `$web_vitals` is blocked by the project-settings toggle (§0a), so this row is the
   standing reason not to let AECI-651 run before that toggle is flipped and a week of `$web_vitals` has
   landed.
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

These four exist only for the migration window and are the evidence base for deciding it is safe to
close. They are not permanent procedure.

7. **Spot-check the reconstructed histogram p95 against Datadog's.** This is the one piece of
   arithmetic in the whole PostHog plane that has never seen real data. Compare
   `p95:aeci.page.render.duration_ms{route_class:detail,cache_status:miss,env:production}` in Datadog
   against the insight `AECi — ALERT — Detail page render p95, cache MISS (1 h)`. **PostHog should
   read ≥ Datadog and within one bucket width** (bounds `5,10,25,50,75,100,250,500,750,1000,1500,2500,5000,7500,10000` ms).
   Lower, or 0 while Datadog shows traffic, means the reconstruction is wrong — check the
   `lower(cache_status)` predicate first, then whether `histogram_bounds` is uniform across points.
   **AECI-651 must not delete the Datadog monitor until this has been checked at least once against
   real traffic.**
8. **Compare one metric per plane, weekly, and record both numbers.** Pick something with volume
   (`aeci.api.query.duration_ms` by `endpoint`, or `aeci.ssr.render`). Divergence is the finding; the
   most likely causes are a `lower()`-casing miss, a query reading the wrong PostHog **project**, or a
   metric whose value is a row count being counted rather than summed.
9. **Read the liveness sweep's run history**, not just its notifications — specifically for **exit 2**
   runs, which mean cron liveness was *unchecked* for that window. A string of them is a provisioning
   or GitHub Actions problem, not a healthy period.
10. **Confirm the fan-out is still two-legged.** A regression that silently drops one leg looks
    exactly like a healthy system on the other. The cheapest check is the deploy markers: every deploy
    should produce **both** a Datadog `/api/v1/events` marker and a PostHog `deployment` event for the
    same SHA. One without the other means a leg went dark.

---

## 3. Launch-tunable thresholds

Every threshold below is a documented **launch placeholder** — set before real traffic existed. Revisit
each weekly. Full rationale per alert is in [`OBSERVABILITY.md`](./OBSERVABILITY.md#alerts); the complete
26-row disposition with old thresholds is in [`RUNBOOKS.md`](./RUNBOOKS.md).

> **While the dual-run lasts, a threshold change is TWO edits.** Change the Datadog monitor JSON and
> re-apply (§5), **and** change `observability/posthog/alerts.json` and re-run `apply.sh`. Editing one
> and not the other leaves the two planes disagreeing about what "unhealthy" means — which will read
> as a PostHog bug at exactly the moment you are trying to decide whether PostHog is trustworthy.
> Never edit a PostHog alert in the UI: `apply.sh` is idempotent by name and the next run will not
> know.

| Alert | Datadog today | PostHog after AECI-651 | Retune signal |
|---|---|---|---|
| Worker error rate high | > 1% / 5m | > 1% / **1 h** | raise the floor only if single failures dominate at low volume. **The cadence, not the threshold, is the thing to watch here** |
| Detail render slow | > 1.5s / 10m (MISS) | > 1,500 ms / 1 h, **≥20-observation floor** | tighten if p95 settles well below. Verify the reconstruction first (§2.7) |
| page_views write errors | > 10% / 10m | > 10% / 1 h, **≥20-write floor** | lower toward 1% as volume grows |
| Auth sign-in error rate | > 30% / 15m | > 30% / 1 h, **≥5-attempt floor** | lower once sign-in volume is non-trivial. The floor already removes the "1 of 2 failed = 50%" false page |
| Toxicity scoring outage | > 50% / 15m | > 50% / 1 h, **≥5-call floor** | lower once review volume is non-trivial |
| Moderation queue backlog | > 48h | **no alert** — dashboard + daily checklist row 8 | tighten toward the 24h internal target (§17); move cron hourly if needed. **Once it stops alerting, the daily read is the only control** |
| Linear pipeline failure | > 50% / 1h | > 50% / 1 h, **≥3-attempt floor** | lower once baseline request volume is known |
| Linear webhook HMAC failures | > 3 / 1h | > 3 / 1 h, unchanged | fine as-is (security signal) |
| WAF rate-limit spike | > 500 / 15m | **> 2,000 / 1 h** — the only rescaled threshold | set once baseline mitigation volume is known. **Keep the 4× ratio between the two planes** while both are live, or they will disagree about what a spike is |
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
2. **Announce the newly indexable term URLs.** The IndexNow / Google Indexing pings are the same
   promote hook, so nothing tells an indexing service the pages exist. Run
   `pnpm --filter @aeci/api ops:submit-trade-urls -- --env production` (dry-run) to see the set, then
   re-run with `--apply --allow-production`. It verifies each page really serves without `noindex`
   before submitting, so run it **after** the purge — if the edge is still serving the old
   membership, it will correctly refuse rather than ping `noindex` pages.

### 3b. Traffic classification — auditing the digest's "humans" (AECI-526 follow-up)

The digest's headline **Traffic (humans)** filters on `page_views.is_bot IS NOT 1`, written at ingest by
`classifyTraffic(ua, asn)` (`apps/api/src/lib/bot-classification.ts`). The UA half is reliable — crawlers
self-name. The **ASN half is a hand-maintained list** and is the weak point: CF Pro yields no bot score, so
a headless browser on a hosting IP with a spoofed Chrome UA reads as human until its ASN is on the list.
This is not hypothetical — the 2026-08-03 digest reported **166 "humans" of which ≥149 were
datacenter/VPN/scanner networks**, 107 from one unlisted colocation provider (AS47007).

**Weekly audit** — census the ASNs that came through as human, and name them:

```bash
cd apps/api && pnpm exec wrangler d1 execute aeci-app-production --env production --remote \
  --command "SELECT cf_asn, COUNT(*) n, COUNT(DISTINCT user_agent_hash) uas, COUNT(DISTINCT path) paths
             FROM page_views WHERE created_at >= date('now','-7 days') AND is_bot = 0
               AND path NOT IN ('/admin','/account') AND path NOT LIKE '/admin/%' AND path NOT LIKE '/account/%'
             GROUP BY 1 ORDER BY n DESC LIMIT 40"
# then, per suspicious ASN:
curl -s "https://stat.ripe.net/data/as-overview/data.json?resource=AS47007" | jq -r .data.holder
```

Tells that an "ASN" is really automation: one ASN dominating the day; a handful of UA hashes covering
dozens of paths; many single `/` hits from many countries inside one short window (a residential-proxy
sweep); a holder name containing hosting / cloud / server / VPS / colo / datacenter.

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

### Datadog — the live object is the truth

Monitors are committed JSON **for record**; the live monitor is what pages. Apply via the curl recipe
in [`OBSERVABILITY.md` → Applying dashboards and alerts](./OBSERVABILITY.md#applying-dashboards-and-alerts)
(substitute `@NOTIFICATION_CHANNEL_TBD` → `@chrisw@thewbsproject.com` at apply time), and **re-export
any UI edit back into `observability/datadog/`** or the record goes stale.

**AECI-279 changed/added three monitors — apply these:**

- `monitor-data-quality-check.json` — *edited*, now scoped `severity:error` (was all severities).
- `monitor-data-quality-check-warn.json` — *new*, `severity:warn`, informational. Uses the
  `@NOTIFICATION_CHANNEL_LOW_TBD` placeholder: substitute a low-urgency handle when one exists, or leave
  it literal so the monitor stays **UI-only / non-paging** (the daily digest already carries these rows).
- `monitor-waf-poll-no-data.json` — *new*, liveness for the hourly WAF poll (`aeci.waf.poll{outcome:ok}`).
  **Precondition:** the poll only emits `outcome:ok` once `CF_ANALYTICS_API_TOKEN` (+ `CF_ZONE_ID`) is
  provisioned for the env; until then it emits `outcome:skipped_no_creds` every hour and never `outcome:ok`,
  so this no-data monitor will fire continuously. Apply it after the token is set (or expect it to fire
  meanwhile).

### At AECI-651 — what "delete Datadog" actually means

`apply.sh` cannot and must not touch Datadog, so the teardown is manual and is an **operator** task,
not a code one. In order: delete the 26 live monitors and 5 dashboards in the Datadog UI; delete the
per-env `DD_API_KEY` Worker secrets; delete the `DATADOG_API_KEY` / `DD_APPLICATION_ID` /
`DD_CLIENT_TOKEN` GitHub secrets; then decide the Datadog account's fate. The code deletions
(transport legs, RUM, `observability/datadog/`, the `DD_SITE` vars, the CSP intake hosts) ride the
AECI-651 PR. **The gate is `stage-2 → main` plus a 2–4 week prod soak plus §2's dual-run checks
green** — in particular the histogram-p95 spot-check (§2.7) and `$web_vitals` actually arriving after
the project toggle is flipped (§0a).
