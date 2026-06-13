# Observability

How AECi is monitored in Datadog. Source of truth for the custom-metric catalog,
the Phase 2 traffic dashboard, and the alert monitors.

Governing spec: `docs/STAGE_1_PHASE_2_SPEC.md` §14. Implemented in AECI-66 on top of
the Datadog plumbing from AECI-31.

## Pipes

AECI-31 stood up two Datadog pipes; AECI-66 added a third:

| Pipe | Where | Intake | Auth |
|---|---|---|---|
| Browser RUM | `apps/web` client (`app/datadog.provider.ts`) | `@datadog/browser-rum` | `DD_CLIENT_TOKEN` + `DD_APPLICATION_ID` (client-exposed) |
| Worker logs | both Workers (`logToDatadog`) | `https://http-intake.logs.{site}/api/v2/logs` | `DD_API_KEY` |
| Worker metrics (AECI-66) | both Workers (`submitDistribution` / `submitCount`) | `https://api.{site}/api/v1/distribution_points`, `https://api.{site}/api/v2/series` | `DD_API_KEY` |

All three are fire-and-forget (`ctx.waitUntil`), never block the response, and no-op
when their credential is absent (clean local dev).

The Worker-logs pipe's per-render `ssr.render` line is **gated** (AECI-103) so prod 2xx
traffic doesn't flood the logs intake — see "The `ssr.render` log is a gated smoke signal"
below. The bounded render-volume signal is the `aeci.ssr.render` count metric.

## Custom metric catalog (Phase 2 §14)

| Metric | Type | Emitted from | Tags |
|---|---|---|---|
| `aeci.page.render.duration_ms` | distribution | `apps/web/src/server-runtime.ts` (`handleSsr`, HIT + MISS branches) | `route_class` (detail/index/browse), `cache_status` (HIT/MISS), `status_code`, `status_class` (2xx/4xx/5xx) |
| `aeci.ssr.render` | count | `apps/web/src/server-runtime.ts` (`handleSsr`, **all** branches) | `cache_status` (hit/miss/non_cacheable), `status_class` (2xx/4xx/5xx) |
| `aeci.api.query.duration_ms` | distribution | `apps/api/src/metrics-middleware.ts` (top-level Hono middleware) | `endpoint` (matched route pattern, e.g. `/api/products/:slug`), `status`, `status_class` |
| `aeci.cache.purge` | count | `apps/web/src/server/routes/admin-purge.ts` | `source` (manual / future webhook), `outcome` (ok / cf_failed) |
| `aeci.api.data_gap` | count | `apps/api/src/lib/handler-utils.ts` (`reportMissingVendors`, called by the product-list-producing handlers) | `gap_type` (currently `missing_vendor`) |
| `aeci.algolia.sync` | count | `apps/api/src/scheduled.ts` (daily cron) + `apps/api/src/routes/promote.ts` (`syncAlgoliaAfterPromote`) | `trigger` (cron / promote), `entity` (products / vendors / integrations / all), `outcome` (ok / failed / skipped_no_creds) |
| `aeci.algolia.index_drift` | gauge | `apps/api/src/scheduled.ts` (daily cron) + `apps/api/scripts/reconcile-algolia-drift.ts` (CLI / deploy-staging hook) | `entity` (products/vendors/integrations), `index` (physical index name) |
| `aeci.algolia.sync.records` | count | `apps/api/src/lib/algolia-sync-metrics.ts` (`emitAlgoliaSyncMetrics`, from the cron + promote hook) | `trigger` (cron / promote), `entity` (products / vendors / integrations), `op` (saved / deleted) |
| `aeci.algolia.sync.duration_ms` | distribution | `apps/api/src/lib/algolia-sync-metrics.ts` (`emitAlgoliaSyncMetrics`, from the cron + promote hook) | `trigger` (cron / promote) |
| `aeci.search.query` | RUM action | `apps/web/src/app/search/search-rum.ts` (`emitSearchQuery`), called by `search-controller.ts` (per-index `connectStats` render + instance `error` event) and `autocomplete-controller.ts` (`runSearch`) — AECI-174; see "Browser search RUM" below | `index` (products/vendors/integrations/federated), `status` (ok/error), `results_bucket` (none/1-5/6-20/21+), `duration_ms` |
| `aeci.stats.compute` | count | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the daily cron) + an inline pre-compute-crash count in `apps/api/src/scheduled.ts` | `trigger` (cron), `outcome` (success / partial / failed) |
| `aeci.stats.compute.duration_ms` | distribution | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the daily cron) | `trigger` (cron) |
| `aeci.stats.compute.key` | count | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the daily cron) | `trigger` (cron), `key` (the `home.*` stats_cache key), `outcome` (written / skipped / failed) |
| `aeci.stats.compute.key.duration_ms` | distribution | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the daily cron) | `trigger` (cron), `key` (the `home.*` stats_cache key) |
| `aeci.pageviews.write` | count | `apps/api/src/routes/page-views.ts` (`capturePageView`, the deferred `POST /api/page-views` insert) | `outcome` (ok / failed) |
| `aeci.auth.signin` | count | `apps/web/src/server/routes/auth-callback.ts` (the SSR `/auth/callback` handler — **carries `service:aeci-web`**, AECI-206) | `method` (google / magic_link / unknown), `outcome` (success / failed), `reason` on failure (link_invalid / missing_code / auth_not_configured) |
| `aeci.review.submit` | count | `apps/api/src/routes/reviews.ts` (`createSubmitReviewHandler`, AECI-206) | `outcome` (ok / duplicate / product_not_found) |
| `aeci.moderation.action` | count | `apps/api/src/routes/admin-reviews.ts` (`createModerateReviewHandler`, AECI-206) | `action` (approve / reject), `outcome` (ok / invalid_state) |
| `aeci.perspective.api` | count | `apps/api/src/lib/perspective.ts` (`scoreToxicity`, AECI-206) | `outcome` (ok / failed), `reason` on failure (http_error / malformed / timeout / network) |
| `aeci.perspective.api.duration_ms` | distribution | `apps/api/src/lib/perspective.ts` (`scoreToxicity`, AECI-206) | `outcome` (ok / failed) |
| `aeci.moderation.queue_depth` | gauge | `apps/api/src/lib/moderation-metrics.ts` (`emitModerationQueueMetrics`, from the daily 06:00 UTC moderation cron) | — |
| `aeci.moderation.queue_oldest_age_hours` | gauge | `apps/api/src/lib/moderation-metrics.ts` (`emitModerationQueueMetrics`, from the daily 06:00 UTC moderation cron) | — |
| `aeci.linear.issue` | count | `apps/api/src/lib/linear.ts` (`createLinearIssueForRequest`, AECI-211 — the request→Linear `ctx.waitUntil` task) | `outcome` (ok / failed / skipped_exists), `kind` (claim / correction), `reason` on failure (http_error / graphql_error / timeout / network / empty_response / db_error) |
| `aeci.linear.issue.duration_ms` | distribution | `apps/api/src/lib/linear.ts` (`createLinearIssueForRequest`, AECI-211) | `outcome` (ok / failed) |
| `aeci.linear.sync` | count | `apps/api/src/lib/linear.ts` (`pushRequestResolutionToLinear`, AECI-213 — the site→Linear resolve/reject `ctx.waitUntil` push) | `outcome` (ok / failed / skipped_no_issue), `kind` (claim / correction), `to_status` (resolved / rejected), `reason` on failure (http_error / graphql_error / timeout / network / empty_response / db_error) |
| `aeci.linear.sync.duration_ms` | distribution | `apps/api/src/lib/linear.ts` (`pushRequestResolutionToLinear`, AECI-213) | `outcome` (ok / failed) |

`aeci.ssr.render` (AECI-103) is one count per SSR render, fired on **every** branch
of `handleSsr` — including the edge-cache HIT path and the non-cacheable branch, both of
which the `aeci.page.render.duration_ms` distribution skips. It is the bounded pipe-health /
render-volume signal that replaced the per-render `ssr.render` *log* firehose. Tags are kept
deliberately low-cardinality (`cache_status` + `status_class`, no path/slug) so cost can't
balloon. `cache_status:non_cacheable` is the slice for the `**` 404 wildcard and non-GET
requests.

Every metric also carries the base tags `env`, `app:aeci`, `service` (`aeci-web` /
`aeci-api`), `worker`, `locale` — the same vocabulary as the log `ddtags` string.

`aeci.api.data_gap` (AECI-115) surfaces curated-data gaps that used to be hidden by
silent fabrication. A product with no `ProductVendor` row now renders an empty state
instead of a fake `/vendors/unknown` link; the metric (plus a paired `warn` log naming
the product slug, `data_gap:missing_vendor`) makes the gap visible to operators. A
gap-free DB emits nothing.

`aeci.algolia.sync` (AECI-139) is one count per entity per run of the Algolia index
sync — the daily cron (`trigger:cron`) and the post-promote hook (`trigger:promote`).
`outcome:failed` means a batch push to Algolia failed (the watermark for that entity is
held for the next cron to retry; a failure is also logged — `aeci.algolia.sync.*` /
`aeci.api.promote.algolia_sync_failed`). `outcome:skipped_no_creds` is the graceful
no-op when the Worker has no Algolia credentials (local/preview). The dashboard widget +
the `outcome:failed` monitor (a daily cron that silently fails leaves a stale index with
no page-level symptom) are owned by AECI-141 (search observability); this issue only
emits the signal.

`aeci.algolia.index_drift` (AECI-140) is the §23.1 daily data-quality check: the signed
difference (`supabase − algolia`) between the promoted-row count per entity in Supabase
and the object count of the matching Algolia index. It is **emitted every run, including
when clean (value 0)** — one gauge point per `entity`/`index` — so the monitor below can
tell "ran clean" from "didn't run". Positive = the index is missing rows; negative =
orphans. Report-only: re-run the AECI-138 bulk sync to repair. Emitted as a **gauge** (a
level, not a delta) via the shared transport's `submitGauge` (AECI-140 added it alongside
`submitCount`); the daily 09:00 UTC (= 04:00 EST) run is the API Worker cron (`apps/api/src/scheduled.ts`),
and the deploy-staging hook + manual triage reuse the same comparison via
`apps/api/scripts/reconcile-algolia-drift.ts`.

`aeci.algolia.sync.records` and `aeci.algolia.sync.duration_ms` (AECI-141) round out the
sync-health picture the `aeci.algolia.sync` outcome count only hinted at. Both are emitted for
a **completed** run by the shared `emitAlgoliaSyncMetrics` (`apps/api/src/lib/algolia-sync-metrics.ts`),
called by both writers of the index — the daily cron and the post-promote hook — so the two
can't drift. `…records` is the count of objects pushed, split `op:saved` (upserts) / `op:deleted`
(removals), per `entity`; **its value is the record count, not 1, so query it with `sum:`, not
`count:`** (see gotcha 3). `…duration_ms` is one distribution point per run (wall-clock of the push
work), tagged only by `trigger`. The cron's pre-push early-returns (`outcome:skipped_no_creds`,
and the `outcome:failed` when the watermark read/write throws) stay as inline single counts — they
are not completed-run signals and don't flow through the helper.

`aeci.stats.compute*` (AECI-180, the 4.5 analogue) is the home-stats compute health picture for the
daily cron (AECI-178, 07:00 UTC = 02:00 EST). A **completed** run flows through the shared
`emitHomeStatsMetrics` (`apps/api/src/lib/home-stats-metrics.ts`): one job-level `aeci.stats.compute`
count (`outcome:success` = every key written/skipped cleanly, `partial` = some wrote + some failed,
`failed` = nothing wrote and ≥1 key failed), one job-level `aeci.stats.compute.duration_ms`
distribution, plus per-key `aeci.stats.compute.key` (`outcome:written|skipped|failed`) and
`aeci.stats.compute.key.duration_ms` so a dashboard/monitor sees *which* `home.*` key failed or
slowed without reading logs. The pre-compute crash path (a Prisma-init throw before `runHomeStats`)
stays an inline single `aeci.stats.compute{outcome:failed}` count — like the Algolia crash path, it
isn't a completed run. Because every completed invocation (and the crash path) emits exactly one
job-level `aeci.stats.compute{trigger:cron}` point regardless of outcome, that series is the
**liveness heartbeat** the "not running" monitor watches via `notify_no_data` (the same
always-reports pattern as the index-drift gauge).

`aeci.pageviews.write` (AECI-180) is the write-health signal for the `POST /api/page-views` insert
(AECI-177): one count per attempted insert, `outcome:ok` after a successful `page_views` write and
`outcome:failed` in the swallow-and-log catch. The bot-score sampled-out early return emits nothing
— it's an intentional skip, not a write, and must not pollute the error-rate denominator. The
endpoint already returned 204, so a failing insert is user-invisible; this metric makes the
regression visible as an error **rate** *before* it silently zeroes `home.trending_products` at the
next daily compute. Note it is monitored on error-rate **only**, never liveness/no-data: page_views
is traffic-driven, so zero writes (no visitors) is normal at pre-launch and a no-data alert would
fire constantly — unlike the fixed-cadence stats cron.

`aeci.auth.signin` / `aeci.review.submit` / `aeci.moderation.action` / `aeci.perspective.api*` /
`aeci.moderation.queue_*` (AECI-206, the Phase 5.15 auth + reviews analogue) cover the four new
write surfaces:

- **`aeci.auth.signin`** is emitted from the **SSR Worker** (`apps/web`, `service:aeci-web` — the only
  Phase 5 metric not on `aeci-api`) at `/auth/callback`, one count per sign-in *completion*,
  `method` (`google`/`magic_link`/`unknown`) × `outcome` (`success`/`failed`, with a failure `reason`
  reusing the user-facing error codes). **"Attempts" = the sum over `outcome`** (success + failed); the
  failure **rate** is the "auth error-rate spike" monitor. The `method` tag is plumbed as a `method`
  query param on the callback URL by the browser auth service (`app/auth/auth.service.ts`). Browser-side
  **initiation** attempts — the magic-link *send* and the OAuth *redirect-out* — happen direct
  browser→Supabase with no Worker hop, so they're a **deferred RUM** signal, not a Worker metric (the
  same deferral as the AECI-141 browser search-query metric → AECI-174). A user who requests a link but
  never returns to the callback therefore isn't counted; the server-observable signal is the completion.
- **`aeci.review.submit`** is one count per `POST /api/reviews` outcome (`ok` after the insert,
  `duplicate` for either dedup path — the app pre-check and the unique-index race — and
  `product_not_found`). `outcome:ok` is the AC's "review submit count". 5xx failures are already covered
  by `aeci.api.query.duration_ms{status_class:5xx}`.
- **`aeci.moderation.action`** is one count per `PATCH /api/admin/reviews/:id` attempt, `action`
  (`approve`/`reject`) × `outcome` (`ok` on a committed transition, `invalid_state` at the preload guard
  or the concurrent-race guard — both 422).
- **`aeci.perspective.api`** + **`aeci.perspective.api.duration_ms`** are the toxicity-scoring health
  pair (`lib/perspective.ts`, called once per review submit). Scoring is **fail-open** — an outage (or
  no key) stores `toxicity_score = null` and the review still enters the queue — so the count is an
  *outage/triage-loss* signal, never user-facing. The **absent-key** path is a silent no-op that emits
  **nothing** (an intentional skip, like Algolia's `skipped_no_creds`), so it can't pollute the
  error-rate denominator. `…duration_ms` is the latency distribution (enable percentile aggregations).
- **`aeci.moderation.queue_depth`** + **`aeci.moderation.queue_oldest_age_hours`** are **gauges** from
  the daily moderation cron (`scheduled.ts`, 06:00 UTC = 01:00 EST; `lib/moderation-metrics.ts`). The
  queue's standing state has no request to ride on — if nobody moderates, no action fires — so the cron
  snapshots `count(pending)` + the oldest pending review's age (0 when empty). Both report on **every**
  run, so the always-emitted point doubles as the cron-liveness heartbeat (the same always-reports
  pattern as the index-drift gauge). Runs **inline** (no ADR-0013 queue): a two-read gauge needs no retry.

`aeci.linear.issue` / `aeci.linear.issue.duration_ms` (AECI-211, Phase 6.4) are the first of the
Phase 6 request→Linear pipeline metrics. One count per request→Linear `ctx.waitUntil` attempt:
`outcome:ok` on a created+linked issue, `outcome:skipped_exists` when the request is already linked
(idempotent re-fire), `outcome:failed` (with a `reason` tag) when Linear or the link-back write fails —
the row then sits `open`/`linear_issue_id=null` for the §6.7 reconciliation sweep. The absent-key path
(no `LINEAR_API_KEY`, the expected non-prod state) emits **nothing**, mirroring `aeci.perspective.api`,
so it never pollutes the error-rate denominator. The Phase 6 dashboard + the pipeline-failure / stuck-row
alerts that build on these land in **AECI-211's sibling 6.12** (not this issue).

`aeci.linear.sync` / `aeci.linear.sync.duration_ms` (AECI-213, Phase 6.6) are the **outbound-resolution**
counterpart: one count per site→Linear `ctx.waitUntil` push when an admin resolves/rejects a request.
`outcome:ok` on a pushed state transition + comment + recorded `workflow_transition`; `outcome:skipped_no_issue`
when the request was never linked to a Linear issue (`linear_issue_id` null — nothing to push, a tolerated
no-op, not a failure); `outcome:failed` (with a `reason` tag) when the Linear `issueUpdate` or the transition
write fails. The `to_status` tag (`resolved` / `rejected`) splits the two terminal pushes. Same absent-key
silence as `aeci.linear.issue`. The dashboard widget + alert for this metric land with the Phase 6.12
observability issue (AECI-218), not this one.

### Three gotchas when querying

1. **Datadog lowercases tag values.** `cache_status:HIT` is stored and queried as
   `cache_status:hit`; `status_class:5xx` stays `5xx`. All dashboard/monitor queries
   use lowercase.
2. **Distribution percentiles must be enabled.** `aeci.page.render.duration_ms`,
   `aeci.api.query.duration_ms`, `aeci.algolia.sync.duration_ms`,
   `aeci.stats.compute.duration_ms`, `aeci.stats.compute.key.duration_ms`,
   `aeci.perspective.api.duration_ms`, `aeci.linear.issue.duration_ms`, and
   `aeci.linear.sync.duration_ms` are
   distribution metrics — to query `p50/p95/p99` you must enable percentile aggregations
   under **Metrics → Summary → (metric) → Manage distribution metrics → Add percentile
   aggregations**. Done once per metric.
3. **Count metrics whose value isn't 1 need `sum:`, not `count:`.** `count:` counts the
   number of submitted points; `sum:` sums their values. Most count metrics here submit
   `value 1` (so the two coincide — e.g. `count:aeci.cache.purge`), but
   `aeci.algolia.sync.records` submits the actual record count, so it must be queried as
   `sum:aeci.algolia.sync.records` (and `sum:…{}.as_count()` in monitors).

### Known coverage limitation

The `aeci.page.render.duration_ms` **distribution** is emitted only for **cacheable** routes
(which is exactly where `route_class` ∈ {detail, index, browse} is defined). The non-cacheable
branch — the `**` 404 wildcard and non-GET requests — has no `route_class` and is intentionally
excluded from that histogram. Those requests are covered by the `aeci.ssr.render` **count**
metric (`cache_status:non_cacheable`), which fires on every branch. API-side requests (including
404s) are fully covered by `aeci.api.query.duration_ms`, so the error-rate widget/monitor still
see API errors.

### The `ssr.render` log is a gated smoke signal (AECI-103)

AECI-31 emitted an `ssr.render` structured **log** on every render to prove the
API↔Worker↔Datadog logs pipe end-to-end. At production traffic that is one log line per page
render — unbounded ingest volume and cost. The per-render volume signal now lives in the
bounded `aeci.ssr.render` count metric above, so the log is demoted to a smoke signal, gated by
`shouldEmitRenderLog` (`apps/web/src/server-datadog.ts`):

- errors (`status >= 400`) are logged in **every** env — full fidelity,
- **all** renders are logged in non-prod (`ENV` ≠ `production`) — dev volume is tiny and useful
  for verifying the pipe,
- prod `2xx` renders are **not** logged — the count metric carries that signal.

The gate is deterministic (no log sampling): a count metric, not a log sample, is the bounded
prod heartbeat. No committed dashboard widget or monitor queries the `ssr.render` log, so this
change skews nothing — the only log-shaped monitor query targets `status:error` logs, which the
gate keeps at full fidelity.

## Dashboards

### `AECi Phase 2 — Traffic`

- **Definition (for record):** `observability/datadog/dashboard.json`
- **Live URL:** https://us5.datadoghq.com/dashboard/b5b-edd-gva/aeci-phase-2--traffic _(applied 2026-06-12 — AECI-222, the AECI-66/AECI-161 live-apply)._

Widgets: top routes by request count · cache hit rate per `route_class` · p50/p95/p99
render per `route_class` · p95 API query per endpoint · 4xx/5xx error rate over time ·
purge events by source.

### `AECi Phase 3 — Search`

- **Definition (for record):** `observability/datadog/dashboard-search.json`
- **Live URL:** https://us5.datadoghq.com/dashboard/fci-6sf-yvn/aeci-phase-3--search _(applied 2026-06-12 — AECI-222, the AECI-141 live-apply)._

Widgets (Worker-side search/sync health): sync runs by `outcome` · sync runs by
`entity`/`trigger` · sync duration p50/p95/p99 by `trigger` · records pushed per
`entity` (`op:saved`/`deleted`, queried with `sum:`) · index drift per `index` (the
AECI-140 `aeci.algolia.index_drift` gauge). The browser-side query-latency + error-rate
widgets are **deferred** until there's a search UI to instrument — see "Browser search
RUM" below.

### `AECi Phase 4 — Home / Stats`

- **Definition (for record):** `observability/datadog/dashboard-home-stats.json`
- **Live URL:** https://us5.datadoghq.com/dashboard/3bi-9a9-6hz/aeci-phase-4--home--stats _(applied 2026-06-12 — AECI-222)._

Widgets (Worker-side home-stats + page_views health, AECI-180): stats compute runs by
`outcome` · stats compute duration p50/p95/p99 · per-key compute outcome by `key`/`outcome`
(which `home.*` key failed) · per-key compute duration p95 by `key` · page-view writes by
`outcome` · page-view write error rate (`100 × failed / total`, with a 10% marker).

### `AECi Phase 5 — Auth / Reviews`

- **Definition (for record):** `observability/datadog/dashboard-auth-reviews.json`
- **Live URL:** _TBD — filled in after the live apply (AECI-206 verification step)._

Widgets (Phase 5.15 auth + reviews health, AECI-206): sign-ins by `outcome` · sign-ins by
`method` · auth failure rate (`100 × failed / total`, with a 30% marker) · review submits by
`outcome` · moderation actions by `action`/`outcome` · Perspective API latency p50/p95/p99 ·
Perspective API error rate (`100 × failed / total`, with a 50% marker) · moderation queue
oldest-pending age (h) + depth (with a 48h backlog marker). Note the sign-in widgets read
`aeci.auth.signin`, which carries `service:aeci-web` (the SSR Worker), unlike the rest of the
Phase 5 metrics on `aeci-api`.

## Monitors

Each monitor's `message` links the matching runbook in `docs/RUNBOOKS.md` and routes to
the team notification channel. The committed JSON keeps the `@NOTIFICATION_CHANNEL_TBD`
placeholder (env-agnostic for record); substitute the real handle **at apply time**. The
resolved handle is `@chrisw@thewbsproject.com` (Datadog email notification; AECI-222) — all
nine monitors were applied 2026-06-12 with that substitution.

| Monitor | Condition | Definition |
|---|---|---|
| Cache hit rate low | hit rate < 70% sustained 15m | `observability/datadog/monitor-cache-hit-rate.json` |
| Detail render slow | p95 detail render (cache MISS) > 1.5s sustained 10m | `observability/datadog/monitor-detail-render-p95.json` |
| Worker error rate high | combined SSR+API 5xx rate > 1% over 5m | `observability/datadog/monitor-error-rate.json` |
| Algolia index drift | any index's \|drift\| > 0 (daily); or no data for 48h | `observability/datadog/monitor-algolia-index-drift.json` |
| Algolia sync failed | any `outcome:failed` push in the last 1d | `observability/datadog/monitor-algolia-sync-failed.json` |
| Algolia sync not running | no successful (`outcome:ok`) cron push for 48h | `observability/datadog/monitor-algolia-sync-no-data.json` |
| Home stats compute failed | any `aeci.stats.compute.key{outcome:failed}` or job-level `aeci.stats.compute{outcome:failed}` (the latter covers a pre-compute crash) in the last 1d | `observability/datadog/monitor-stats-compute-failed.json` |
| Home stats not running | no `aeci.stats.compute{trigger:cron}` heartbeat for ~26h | `observability/datadog/monitor-stats-compute-no-data.json` |
| page_views write errors | write error rate > 10% over 10m | `observability/datadog/monitor-pageviews-write-errors.json` |
| Auth sign-in error rate | sign-in failure rate > 30% over 15m (`service:aeci-web`) | `observability/datadog/monitor-auth-error-rate.json` |
| Perspective API outage | Perspective failure rate > 50% over 15m | `observability/datadog/monitor-perspective-outage.json` |
| Moderation queue backlog | oldest pending review > 48h (daily); or no snapshot for ~26h | `observability/datadog/monitor-moderation-queue-age.json` |

The p95-detail monitor is scoped to `cache_status:miss` on purpose: HITs are served
from the edge and would mask a genuinely slow render.

Algolia sync health is intentionally **two** monitors. "Sync failed" alerts on `outcome:failed`
and must **not** use `notify_no_data` — that series is empty on a healthy run, so a no-data
alert there fires constantly. The "sync not running" liveness monitor instead watches the
`outcome:ok{trigger:cron}` series (which reports every healthy run) via `notify_no_data`, the
same always-reports pattern that lets the index-drift monitor's no-data mean "the cron didn't
run." Keep the failure and liveness concerns on separate metrics — don't fold them back together.

Home stats (AECI-180) follow the **same failure + liveness split**. "Home stats compute failed"
alerts when either the per-key `aeci.stats.compute.key{outcome:failed}` count or the job-level
`aeci.stats.compute{outcome:failed}` count is non-zero (no `notify_no_data` — both are empty on a
healthy run). The per-key term names the offending `home.*` key; the job-level term also catches a
**pre-compute crash** (a Prisma-init throw before `runHomeStats`), which emits the job-level
`outcome:failed` heartbeat but no per-key points. That term is load-bearing — the crash also emits
the `{trigger:cron}` liveness heartbeat, which keeps the "not running" monitor green, so without the
job-level failure term a total crash would slip past **both** monitors. "Home stats not running" is the
freshness/liveness monitor: it watches the always-emitted `aeci.stats.compute{trigger:cron}`
heartbeat (one point per completed run, **any** outcome) via `notify_no_data`, `no_data_timeframe`
1560 (~26h = a missed daily run + grace). It deliberately watches the outcome-agnostic heartbeat,
not `outcome:success`, so a persistently-`partial` run still counts as "ran." Reading `stats_cache`'s
`computed_at` directly isn't an option for the missed-run case — a run that never fired can't emit
its own timestamp — so no-data on the heartbeat **is** the staleness signal (the AC's "computed_at
older than ~26h").

The page_views write monitor is the one **deliberate exception** to the liveness pattern. It alerts
on the error **rate** (`aeci.pageviews.write` `outcome:failed / total`) and must **not** use
`notify_no_data`: page_views is **traffic-driven**, not a fixed-cadence cron, so zero writes (no
visitors) is normal at pre-launch and a liveness/no-data alert would fire constantly. Only the
failure ratio is meaningful. The 10% threshold is a launch-tunable starting point (§14.3 cites 1%
for request error rate; page_views runs at far lower volume, so the floor is higher to avoid
single-failure noise) — retune once production traffic is known.

The Phase 5 monitors (AECI-206) split the same way. **"Auth sign-in error rate"** and **"Perspective
API outage"** are **traffic-driven error-rate** monitors — like page_views, no `notify_no_data` (zero
sign-ins / zero review-submits is normal at pre-launch and a no-data alert would be constant noise);
only the failure ratio matters, and both thresholds (30% / 50%) are launch-tunable starting points
(at low volume a single failure can dominate the ratio). The auth monitor is the only one scoped to
`service:aeci-web` (the SSR Worker emits `aeci.auth.signin`). **"Moderation queue backlog"** is the
**fixed-cadence** one and behaves like the stats freshness monitor: the 06:00 UTC moderation cron emits
`aeci.moderation.queue_oldest_age_hours` (and `…queue_depth`) on **every** run — 0 for an empty queue —
so the same series carries both the threshold alert (oldest pending > 48h → backlog) **and**, via
`notify_no_data` (`no_data_timeframe` 1560 ≈ 26h), the cron-liveness check (no snapshot → the cron
stopped). Because the snapshot is **daily**, detection lags up to ~24h on top of the 48h threshold; the
cron can move to hourly post-launch if a tighter moderation SLA is needed.

## Browser search RUM (`aeci.search.query`, AECI-174)

§14.3 lists "Algolia query latency and error rate" as a dashboard signal. Search is
queried **client-side**, direct to Algolia with the search-only key injected as
`window.__AECI_ALGOLIA__` (`apps/web/src/algolia-bootstrap-inject.ts`), so this latency is
a **browser RUM** signal, not a Worker metric. AECI-141 documented this contract and deferred
the emit until a search-results UI existed; AECI-142 (`/search`) and AECI-144 (the header
autocomplete) shipped that UI, and **AECI-174 implements the emit + the two dashboard widgets**.

- **Action:** `datadogRum.addAction('aeci.search.query', {...})` on every query that resolves
  or errors. The dynamic-import, fire-and-forget emit lives in
  `apps/web/src/app/search/search-rum.ts` (`emitSearchQuery`, pattern:
  `apps/web/src/app/datadog.provider.ts`); it's injected into each controller as a
  `SearchQueryEmitter` seam so the unit tests assert the context without loading the SDK.
- **Context (low-cardinality only — no raw query text):**
  - `index` — `products` | `vendors` | `integrations` | `federated`
  - `status` — `ok` | `error`
  - `duration_ms` — number (Algolia `processingTimeMS`, or the client round-trip)
  - `results_bucket` — `none` | `1-5` | `6-20` | `21+`
- **Emit sites & `index` mapping:**
  - `/search` (`search-controller.ts`) runs one batched products+vendors multi-query per
    keystroke; each index's `connectStats` render emits `status:ok` **per index**
    (`index:'products'` / `index:'vendors'`, `duration_ms` = that index's `processingTimeMS`,
    `results_bucket` from its `nbHits`). A failed batched request emits ONE `index:'federated'`
    `status:'error'` from the InstantSearch instance `error` event.
  - The header autocomplete (`autocomplete-controller.ts`, a single federated `searchForHits`)
    emits ONE `index:'federated'` per query — `status:'ok'` with the client round-trip
    `duration_ms` and `results_bucket` from the true total `nbHits`, or `status:'error'` on reject.
  - `integrations` is a reserved enum value — not queried by either surface today (the
    `/search` integrations index is intentionally disabled; see `search-controller.ts`).
- **Widgets in `AECi Phase 3 — Search`** (`observability/datadog/dashboard-search.json`, both
  `data_source: "rum"`): query latency p50/p95/p99 over `@context.duration_ms` (filtered
  `@context.status:ok`); error rate = `@context.status:error` count / **one-action-per-query**
  count. The denominator filters `@context.index:(products OR federated)` (not all actions):
  a successful `/search` query emits two `ok` actions (one per index) while a failed query emits
  one `federated` error, so counting every action would halve the apparent `/search` error rate.

## Credentials

| Credential | Used by | Where it lives | Notes |
|---|---|---|---|
| `DD_API_KEY` | Worker runtime — logs **and** metric submission | Wrangler secret (both Workers, all envs) | Already provisioned (AECI-31). Metric submission needs only this key. |
| `DD_APP_KEY` | **Operator only** — creating/reading dashboards + monitors | Local shell / CI secret at apply time | **Never** a Worker secret; never in `wrangler.jsonc` / `.dev.vars`. |
| `DD_SITE` | both | Wrangler `vars` | `us5.datadoghq.com`. The metrics host is `api.{DD_SITE}`. |

## Applying the dashboard + monitors

These are **not** Terraform-managed. Author/own them in the Datadog UI; commit the
exported JSON here for record. To (re)create from the committed JSON via the API
(site `us5`):

```bash
export DD_API_KEY=...   # the existing Worker key works for reads/writes
export DD_APP_KEY=...    # operator app key (NOT a Worker secret)
DD=https://api.us5.datadoghq.com

# Dashboard
curl -sX POST "$DD/api/v1/dashboard" \
  -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
  -H 'Content-Type: application/json' \
  -d @observability/datadog/dashboard.json

# Each monitor
for m in observability/datadog/monitor-*.json; do
  curl -sX POST "$DD/api/v1/monitor" \
    -H "DD-API-KEY: $DD_API_KEY" -H "DD-APPLICATION-KEY: $DD_APP_KEY" \
    -H 'Content-Type: application/json' -d @"$m"
done
```

After creating, paste the returned dashboard URL into the **Live URL** field above and
re-export any UI edits back into `observability/datadog/`.

## Verifying metrics flow (post-deploy)

Generate traffic against a deployed env and confirm all three metrics land within ~5
min:

```bash
DATADOG_TRAFFIC_GEN=1 PLAYWRIGHT_BASE_URL=https://<staging-url> \
  pnpm --filter @aeci/web exec playwright test e2e/traffic-gen.spec.ts
```

The generator visits ~20 representative pages (static / index / browse / detail) twice
— the first pass is a cache MISS, the second a HIT — so both `cache_status` values and
all three `route_class` values appear. Then check Datadog:

- Metrics Explorer: `aeci.page.render.duration_ms` (split by `cache_status`, `route_class`),
  `aeci.api.query.duration_ms` (split by `endpoint`), `aeci.cache.purge`.
- The dashboard should show data on all six widgets.
