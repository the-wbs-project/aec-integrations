# Post-launch Monitoring Runbook

**Version:** 1.0 · **Date:** 2026-07-11 · **Owner:** Chris · **Issue:** AECI-279 (Phase 8.1)

The repeatable **daily / weekly** procedure for watching the first weeks of real production
traffic and stabilizing. This is the *operate* companion to the three record docs:

- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — the metric **catalog**, dashboards, and monitors (what each signal is).
- [`RUNBOOKS.md`](./RUNBOOKS.md) — the **incident** response guides (what to do when a monitor fires).
- [`launch-cutover-runbook.md`](./launch-cutover-runbook.md) §5 — the **post-cutover verification** signals this pass re-observes.
- [`ANALYTICS_BASELINE.md`](./ANALYTICS_BASELINE.md) — the traffic/signup/CWV **numbers** procedure (PostHog + RUM).
- [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md) — the dated **health-report log** this procedure feeds.

Everything below reads from the Datadog org **us5**, app tag `app:aeci`, filtered `env:production`.
The notification handle behind every monitor is `@chrisw@thewbsproject.com` (Datadog email).

---

## 0. Precondition — is analytics actually flowing?

**Check this first every morning until it passes.** Client analytics (PostHog) and field Core Web
Vitals (Datadog RUM) inject only when their Worker secrets exist. As of 2026-07-11 they are **dark**
in production (secret *values* unset — AECI-326 wired the CI push but not the values):

```bash
curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'
```

- **Nothing printed** → PostHog + RUM are **not capturing**. Skip the RUM-CWV and PostHog-funnel rows
  below; they have no data. Server-side signals (Worker metrics, `page_views` / `mailing_list` D1) are
  unaffected and still valid. Un-dark by setting `DD_APPLICATION_ID`, `DD_CLIENT_TOKEN`, and
  `POSTHOG_KEY` (see [`OBSERVABILITY.md` → Credentials](./OBSERVABILITY.md#credentials)); this is an
  ops action, not code.
- **`__AECI_POSTHOG__` + `__AECI_DD__` both printed** → analytics is live; the RUM-CWV and PostHog rows
  are meaningful. Record the flip date in [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md).

---

## 1. Daily monitoring checklist

A ~5-minute glance across the shipped dashboards + monitors. Nothing here should require action on a
healthy day — the point is to catch a regression before a monitor's sustained-window threshold does.

| # | Signal | Where to look | Healthy | Fires as |
|---|---|---|---|---|
| 1 | **Errors / APM** | Phase 2 — Traffic dashboard (4xx/5xx widget); `aeci.api.query.duration_ms` by `endpoint`/`status_class`; SSR logs `service:aeci-web status:error` | 5xx rate < 1% | `AECi — Worker error rate high` (>1%/5m) |
| 2 | **Edge cache hit rate** | Phase 2 — Traffic (cache-hit per `route_class`); `aeci.page.render.duration_ms{cache_status}` | HIT majority on cacheable route classes (detail/browse/taxonomy/static) | `AECi — Cache hit rate low` (<70%/15m) |
| 3 | **Render latency** | Phase 2 — Traffic (p95 render per `route_class`) | p95 detail (MISS) < 1.5s | `AECi — Detail render slow` (>1.5s/10m, `cache_status:miss`) |
| 4 | **Algolia query latency / errors** | Phase 3 — Search (browser RUM `aeci.search.query`: latency p50/p95/p99, error rate) | error rate ~0; p95 within norm | *(no monitor — dashboard-only; add if noisy)* |
| 5 | **Algolia sync + drift** | Phase 3 — Search; `aeci.algolia.sync`, `aeci.algolia.index_drift` | drift 0; daily sync `outcome:ok` | drift/sync-failed/sync-not-running/orphan-cap monitors |
| 6 | **Scheduled-job health (8 crons)** | the liveness/no-data monitors (see §1a) | every cron emitted its heartbeat in window | the per-cron `… not running` / `… failed` monitors |
| 7 | **Request → Linear pipeline** | Phase 6 — Requests / Moderation; `aeci.linear.issue`/`.sync`/`.reconcile.*`, `aeci.webhooks.linear.hmac_failure` | failure rate < 50%; no persistent stuck; no HMAC burst | pipeline-failure / reconcile-stuck / reconcile-no-data / hmac monitors |
| 8 | **Moderation queue** | Phase 5 & 6 dashboards; `aeci.moderation.queue_depth` / `queue_oldest_age_hours`; `GET /api/admin/summary` (`pending_reviews`), `GET /api/admin/requests` | oldest pending < 48h (target 24h, §17) | `AECi — Moderation queue backlog` (>48h) |
| 9 | **RUM Core Web Vitals** *(gated on §0)* | Datadog **RUM → Optimize Vitals**, `aeci` app, `env:production` (p75 LCP / CLS / INP) | LCP ≤ 2.5s · CLS ≤ 0.1 · INP ≤ 200ms (`STAGE_1_PHASE_2_SPEC.md` §12) | *(no monitor — read manually; see §2)* |

> **Datadog UI gotcha:** the org has three RUM apps (`aeci`, `pm-empower`, `earned-value`) and the UI
> defaults to the wrong one — select **`aeci`** (us5). CWV live under RUM → Optimize Vitals, not the
> Phase-2 dashboard (that tracks SSR `aeci.page.render.duration_ms`, not field CWV).

### 1a. The 8 scheduled crons (row 6 detail)

Each cron emits an always-on heartbeat; the "not running" monitor's no-data is the liveness signal.
A green board here means all eight fired on schedule.

| Cron (UTC) | Job | Liveness / failure monitors |
|---|---|---|
| `0 4 * * *` | Data-quality suite (10 §23.1 checks) + email digest | check-error / check-warn / failed / not-running |
| `0 5 * * *` | Operator analytics digest (AECI-526) — **human** page views + top products, sign-ins, moderation depth, and a Crawler-activity breakdown (human/bot split classified at ingest by UA + ASN) | `aeci.analytics_digest.email` heartbeat (no dedicated monitor yet) |
| `0 6 * * *` | Moderation queue snapshot | moderation-queue-age (threshold + no-data) |
| `0 7 * * *` | Home-stats compute | stats-compute-failed / stats-not-running |
| `0 8 * * *` | Algolia incremental sync | sync-failed / sync-not-running |
| `0 9 * * *` | Algolia drift + orphan sweep | index-drift / orphan-sweep-capped |
| `*/15 * * * *` | Request→Linear reconciliation sweep | reconcile-stuck / reconcile-no-data |
| `0 * * * *` | WAF firewall-event poll | waf-ratelimit-spike / **waf-poll-not-running** (AECI-279) |

---

## 2. Weekly checklist

1. **Re-verify the launch-cutover §5 signals** ([`launch-cutover-runbook.md`](./launch-cutover-runbook.md)):
   dual `/api/version` + `/_version` SHA match; `www.` canonical + apex→www 301; indexable headers +
   sitemap/robots; IndexNow firing; a test transactional email; the welcome banner on a `?ref=waitlist`
   link.
2. **Review the launch-tunable thresholds** (§3) against the week's data — tighten any that missed a real
   issue, relax any that proved noisy. **Only the enforcement/threshold changes** — never relax a budget
   to make a signal pass (`TESTING_STRATEGY.md` §10.4).
3. **Core Web Vitals read** *(once §0 passes)*: Datadog RUM → Optimize Vitals for the `aeci` app,
   `env:production`, p75 LCP / CLS / INP per page type, against the §12 budgets. The pre-launch lab audit
   ([`PERFORMANCE_AUDIT.md`](./PERFORMANCE_AUDIT.md)) flagged **CLS on detail/browse/taxonomy (0.145–0.326)**
   and **detail-page JS ~227 KB** as the likely field offenders — confirm whether the lab headroom (owned
   by **AECI-221**) actually surfaces in the field before acting.
4. **Append a health-report entry** to [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md)
   (weekly through the first month, then at the one-month mark).

---

## 3. Launch-tunable thresholds

Every threshold below is a documented **launch placeholder** — set before real traffic existed. Revisit
each weekly; change the value in the named monitor JSON and re-apply (§4). Full rationale per monitor is
in [`OBSERVABILITY.md`](./OBSERVABILITY.md#monitors).

| Monitor | Current threshold | Retune signal |
|---|---|---|
| Worker error rate high | > 1% / 5m | raise the floor only if single failures dominate at low volume |
| Cache hit rate low | < 70% / 15m | set to observed steady-state hit rate once known |
| Detail render slow | > 1.5s / 10m (MISS) | tighten if p95 settles well below |
| page_views write errors | > 10% / 10m | lower toward 1% as volume grows |
| Auth sign-in error rate | > 30% / 15m | lower once sign-in volume is non-trivial |
| Toxicity scoring outage | > 50% / 15m | lower once review volume is non-trivial |
| Moderation queue backlog | > 48h | tighten toward the 24h internal target (§17); move cron hourly if needed |
| Linear pipeline failure | > 50% / 1h | lower once baseline request volume is known |
| Linear webhook HMAC failures | > 3 / 1h | fine as-is (security signal) |
| WAF rate-limit spike | > 500 / 15m | set once baseline mitigation volume is known |
| Data-quality check (warn) | any > 0, **non-paging** (AECI-279) | mute/relax individual warn checks that prove noisy (e.g. known duplicate candidates) |

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
| `TRENDING_MIN_VIEWS` | 3 | the honesty floor + the only bot guard **on trending** (CF Pro has no bot score, so `PAGE_VIEWS_MIN_BOT_SCORE` is inert). Note: `page_views` now carries an ingest-time `is_bot` flag (UA+ASN, AECI-526) that the digest filters on, but `home.trending_products` does **not** yet — it still counts all views, so this floor remains trending's only guard until trending adopts `is_bot IS NOT 1`. Inert at healthy traffic; raise if bots/self-views inflate low-traffic windows, lower if legit low-traffic products get over-suppressed |

Deferred to the AECI-280 ~30d follow-up: the PostHog-join weighting + recency decay, and the
card-resonance/swap review once PostHog + RUM have real volume.

---

## 4. Triage → ticket loop

When a signal regresses beyond a known launch item:

1. **Confirm it isn't expected** — e.g. analytics dark (§0), a warn-severity data-quality finding
   (informational), or a threshold known to be a low-volume placeholder (§3).
2. **Capture evidence** — the metric name, the Datadog dashboard/monitor link, and the time window.
3. **Open a Linear issue** in the **AECi** team, label `infra`, referencing the evidence and the
   governing runbook section. Per the checkpoint convention, this pass **documents** regressions for
   Chris to file rather than auto-creating issues.
4. **Record it** in the current [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md) entry so
   the trend is visible week over week.

---

## 5. Applying monitor changes (ops)

Monitors are committed JSON, **not** Terraform-managed — apply via the curl recipe in
[`OBSERVABILITY.md` → Applying the dashboard + monitors](./OBSERVABILITY.md#applying-the-dashboard--monitors)
(substitute `@NOTIFICATION_CHANNEL_TBD` → `@chrisw@thewbsproject.com` at apply time).

**AECI-279 changed/added three monitors — apply these:**

- `monitor-data-quality-check.json` — *edited*, now scoped `severity:error` (was all severities).
- `monitor-data-quality-check-warn.json` — *new*, `severity:warn`, informational. Uses the
  `@NOTIFICATION_CHANNEL_LOW_TBD` placeholder: substitute a low-urgency handle when one exists, or leave
  it literal so the monitor stays **UI-only / non-paging** (the daily digest already carries these rows).
- `monitor-waf-poll-no-data.json` — *new*, liveness for the hourly WAF poll (`aeci.waf.poll{outcome:ok}`).
  **Precondition:** the poll only emits `outcome:ok` once `CF_ANALYTICS_API_TOKEN` (+ `CF_ZONE_ID`) is
  provisioned for the env; until then it emits `outcome:skipped_no_creds` every hour and never `outcome:ok`,
  so this no-data monitor will fire continuously. Apply it after the token is set (or expect it to fire
  meanwhile) — the same "dark until the secret exists" caveat the §0 gate applies to the analytics monitors.
