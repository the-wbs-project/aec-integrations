# Observability

How AECi is monitored: the pipe topology, the attribute vocabulary, the
custom-metric catalogue, the dashboards, and the alerts. This is the
**is-it-healthy** half of the telemetry story. The **are-people-getting-value**
half — the product event catalogue, the activation funnel, identity, groups and
feature flags — is [`ANALYTICS.md`](./ANALYTICS.md). Both land in PostHog; the
split is by question, not by vendor, and neither file repeats the other.

Governing specs: `docs/STAGE_1_PHASE_2_SPEC.md` §14 for the catalogue itself, and
[`POSTHOG_MIGRATION_SPEC.md`](./POSTHOG_MIGRATION_SPEC.md) + [ADR
0024](./adr/0024-observability-migrates-to-posthog.md) for the vendor migration.
Implemented in AECI-66 on top of the Datadog plumbing from AECI-31; re-pointed at
PostHog by the AECI-639 epic (AECI-640…650) and made single-vendor by **AECI-651**,
which deleted the Datadog leg.

## Read this first — PostHog is the only plane

**There is one observability vendor: PostHog.** The AECI-639 dual-run ran the
PostHog transport beside Datadog so the swap could be verified against live
traffic; AECI-651 then deleted the Datadog leg — the two per-Worker adapters, the
browser RUM SDK, the `observability/datadog/` monitor + dashboard JSON, every
`DD_*` variable, and the CSP grants to the two `browser-intake-*` hosts.

| Question | Where to look |
|---|---|
| "My phone buzzed — what fired?" | One of the 13 PostHog alerts (hourly cadence), production project only |
| "Did the 08:00 cron actually run?" | The **CI liveness sweep** (`.github/workflows/posthog-liveness-sweep.yml`), every 3 h, **thirteen** crons watched. It runs OUTSIDE the Worker, which is what lets it detect a dead Worker |
| "What does this metric mean?" | This document |
| "Show me the graph" | PostHog — 7 dashboards, 43 insights, applied from `observability/posthog/insights.json` |
| "Read the error log for this request" | The PostHog Logs explorer |
| "Which person hit this 500?" | PostHog — `posthogDistinctId` is a log attribute (AECI-644) |
| "Core Web Vitals in the field" | PostHog web vitals (`$web_vitals`), live on every tier since the project toggle was flipped 2026-08-26 |

### Two things the decommission changed that a reader will notice

1. **Alert cadence is hourly, not 5-minutely.** PostHog's alert engine checks
   hourly on our plan; the retired Datadog monitors checked every 5–15 minutes.
   This is the single biggest degradation in the swap and it was accepted
   knowingly (ADR 0024 decision 2). The per-monitor thresholds that were NOT
   ported one-to-one are preserved in the disposition table in
   [`RUNBOOKS.md`](./RUNBOOKS.md) — that table is the only surviving record of
   them now that `observability/datadog/` is deleted.
2. **Absence detection is not a vendor feature any more.** PostHog has no
   `notify_no_data` equivalent at any tier, so the eight monitors that did nothing
   but detect silence became one scheduled-CI sweep. See "Absence detection moved
   out of the vendor entirely".

## Pipes

Three pipes, one vendor. Every one of them is fire-and-forget
(`ctx.waitUntil` on the server), never blocks the response, and **no-ops entirely
when its credential is absent** — keyless local dev is the design, not a degraded
mode.

> **They also spend a shared, bounded resource (AECI-666).** A Worker invocation may
> hold only ~6 connections waiting for response headers — `fetch`, KV, R2, Cache API,
> Queues `send()` and outbound WebSockets all draw on the same pool. Retiring the
> Datadog leg (AECI-651) **halved** the cost of every emission — one `logToPosthog`
> call is now one connection, not two — but the budget is still a budget. Two rules
> follow, and both are enforced in review: every transport **releases its response
> body** on every path (`discardResponseBody`), and a caller whose line count scales
> with its payload uses the **batched** sender (`logBatchToPosthog`, N entries → one
> request) rather than a loop. Where an upstream has no batch endpoint, bound the
> fan-out with `mapWithConcurrency(items, WORKER_CONNECTION_LIMIT, fn)`. Exceeding
> the budget is not merely slow — see the troubleshooting section below for why it
> is silent.

### PostHog — three pipes, two mechanisms (AECI-642 / §AW1)

The intake facts below were **probed live** against `aec-integrations-dev`
(525793) on 2026-08-24, not inferred from documentation (spec §8.1).

| Pipe | What rides it | Where | Intake | Auth |
|---|---|---|---|---|
| **Worker logs** | structured logs, incl. the §26.5 audit forwards | both Workers (`logToPosthog`) | `POST https://us.i.posthog.com/i/v1/logs` — hand-rolled OTLP/HTTP JSON | `Authorization: Bearer <phc_ project token>` |
| **Worker metrics** | the `aeci.*` catalogue below | both Workers (`submitCount` / `submitGauge` / `submitDistribution`) | `POST https://us.i.posthog.com/i/v1/metrics` — hand-rolled OTLP/HTTP JSON | `Authorization: Bearer <phc_ project token>` |
| **Events + exceptions** | `captureEvent` / `captureException` | both Workers, via `posthog-node/edge` | the SDK's own capture path | project token, in the body |
| *(browser)* **Tier 2 + Tier 3** | `$exception`, `$web_vitals`, `app_started`; then `$pageview` + the event catalogue on consent | `apps/web` client (`app/analytics/`) | `us.i.posthog.com` (+ `us-assets.i.posthog.com` for remote config) | publishable `phc_`, rendered into the HTML as `window.__AECI_POSTHOG__` |
| *(CI)* **Deploy markers** | a queryable `deployment` event + a project annotation | `scripts/ci/posthog-deploy-marker.sh` | `POST /capture/` (event) and `us.posthog.com` (annotation) | publishable `phc_` (event) / personal `phx_` (annotation) |

Three facts about those intakes that cost time to discover and are cheap to state:

- **The `Bearer` header is required on both OTLP intakes**, even though the token
  is the publishable one. The `?api_key=` query form returns
  `401 {"error":"No token provided"}` — the **opposite** of `/capture/`, which
  takes the key in the JSON body and no auth header. Do not generalize either
  convention to the other.
- **`/i/v1/e/` does not exist.** It 404s. The working single-event endpoints are
  `/capture/` and `/i/v0/e/`. A `/i/v1/e/` typo is a silent 404 that reads exactly
  like a config problem.
- **Number encoding differs by position.** OTLP metric *data points* use
  `asDouble`; *attribute values* use `doubleValue`. And OTLP's `Gauge` message has
  no `aggregationTemporality` field at all, so `submitGauge` omits it rather than
  sending DELTA — a strict parser could reject the extra field. (The DELTA rule
  still governs the sum and histogram pipes.)

The SDK's own metrics client is deliberately unused: it aggregates in memory over
a 10-second window, and a Worker isolate is gone long before that window closes.
Emit per call.

## The attribute vocabulary

One vocabulary on all pipes, with **one deliberate, arithmetic-backed
exception**. These ride as OTLP **resource** attributes on the logs and metrics
pipes and as event properties on the `posthog-node` pipe — the call site never
writes them; the transport (`packages/shared/src/posthog.ts`) attaches them.

Verified live on both Workers, 2026-08-24 (§8.9 check 2 — the list below is what
actually arrived, not what was intended):

| Attribute | Value | On logs | On metrics | On events |
|---|---|---|---|---|
| `service.name` | `aeci-api` / `aeci-web` | ✅ | ✅ | — |
| `service` | same value, undotted | ✅ | ✅ | ✅ |
| `app` | always `aeci` | ✅ | ✅ | ✅ |
| `env` | `development` / `preview` / `staging` / `demo` / `stage2` / `production` | ✅ | ✅ | ✅ |
| `worker` | `aeci-api` / `aeci-web` | ✅ | ✅ | ✅ |
| `source` | `worker` (API) / `worker-angular` (SSR) | ✅ | ✅ | ✅ |
| `version` | `COMMIT_SHA`, the real one (AECI-74) | ✅ | ✅ | ✅ |
| `locale` | `en-US` | ✅ | ✅ | ✅ |
| `host` | the request hostname | ✅ | ❌ **never** | ✅ |
| `posthogDistinctId` | the Supabase user id, **only** on genuinely-authed requests | ✅ | ❌ never | — (events use the service slug) |

**`service.name` is the one the Logs explorer filters on.** It is mandatory and
separate from `service`; the explorer's service filter reads only the dotted key.
Emitting `service` alone produces a project full of logs that the service filter
cannot see.

**`host` is on logs and events but not on metrics — and that is deliberate.**
Say it out loud, or the next reader will "restore consistency" and blow the
cardinality budget. In the **non-production** project the preview tier deploys
**one Worker per pull request** (`aeci-web-pr-123.<subdomain>.workers.dev`), so
`host` as a metric resource attribute is unbounded cardinality that grows with
every PR opened, forever, and no tag discipline elsewhere recovers it. Logs are
not a series model, so a hostname costs nothing there and genuinely answers
"which of the four non-prod tiers sharing project 525793 served this". The rule
is **enforced structurally, not by comment**: `postMetric()` does not accept a
`Request`, so `host` cannot be re-added to a metric by accident. Full arithmetic
under "Cardinality budget" below.

**Point attributes carry only the caller's tags.** The shared vocabulary rides as
resource attributes precisely because series identity includes them — repeating
the set on every data point would multiply the series count for zero extra
information. `key:value` tag strings split on the **first** colon only, because
route patterns contain colons.

**`posthogDistinctId` is spelled exactly that way** — camelCase — because that is
the property PostHog joins logs to persons on. It is emitted **iff** the request
carries a JWKS-verified Supabase user id (AECI-644 / §AW3), which is true in
exactly two places: `createAuthzMiddleware` and `requireUserAuth`. Cron, queue
consumers, the promote Workflow, machine-to-machine callers and anonymous SSR
renders **omit the attribute** — they do not synthesize one. A made-up id mints a
bogus person and corrupts every person-linked view in the project, permanently,
in a way that looks like real data. Omission is structural: the field is typed
`?: never` so a call site cannot author it, and the transport strips a
spread-smuggled value at runtime. Note the deliberate asymmetry — server-side
*events* fall back to the service slug `aeci-api` as `distinct_id` (§3.10) while
logs omit. Different mechanism, different failure mode; do not unify them.

### Not a pipe: local dev tracing (AECI-548)

`wrangler dev` captures OpenTelemetry traces for every **local** Worker invocation and serves
them over a read-only SQL endpoint. **This is a separate thing from everything else in this
document — do not conflate the two.**

| | Local tracing | The pipes above |
|---|---|---|
| Where | Inside the `wrangler dev` process | Deployed tiers |
| Lifetime | Wiped when the dev server exits | 7–15 day retention |
| Transport | **None** — never leaves the machine | HTTP intake, `ctx.waitUntil` |
| Content | Every span of every local request | Curated `aeci.*` catalogue + gated logs |
| Configured by | Nothing — automatic | Wrangler vars + `POSTHOG_PROJECT_KEY` |

Consequences worth stating plainly: a local span **never** reaches PostHog, so it
can neither pollute a dashboard nor be used as evidence about deployed behaviour; and nothing
in the metric catalogue below has a local-dev equivalent. Full schema, guardrails, and the
debugging recipes live in **`docs/local-tracing.md`**.

The one place they touch: because the §26.5 forwards run through `ctx.waitUntil`, they appear
in local traces as outbound `fetch` spans to `us.i.posthog.com/i/v1/logs` and `/i/v1/metrics`.
That is a cheap way to confirm a forward actually fires without opening the console at all. (Two
host families used to appear here, one per vendor; the Datadog family went away with AECI-651.)

## Custom metric catalogue (Phase 2 §14)

~50 `aeci.*` metrics. Every one is emitted to **both** vendors from the same call
site for the duration of the dual-run. Two rows changed shape in AECI-642 and are
flagged inline: the raw `status` / `status_code` tags are **gone** (cardinality —
see the budget below), and `aeci.search.query` is a **retiring** RUM action rather
than a Worker metric.

> **⚠️ Front-of-Worker cache (WC-3 AECI-317 · WC-8 AECI-322).** Native Cloudflare Workers Cache serves cacheable HITs **without running the SSR Worker** (preview + staging; demo/production still gated). So the two SSR render metrics only ever record `cache_status:MISS`/`miss` (the Worker runs only on a native-cache miss) or `non_cacheable` — **there is no `cache_status:hit` series.** HIT-rate visibility lives on `Cf-Cache-Status` + the Cloudflare Workers observability dashboard (see "Front-of-Worker cache: HIT observability" below). **WC-8 (AECI-322) completed the rework:** the `cache hit rate < 70%` monitor + its dashboard widget were **retired** (their `cache_status:hit` numerator is now permanently ~0 — they would flatline / alert forever), and the crawler-`noindex` decision is now baked into the cached payload so a HIT can't leak an indexable non-prod page (`docs/CACHE_STRATEGY.md` §7.1).

| Metric | Type | Emitted from | Tags |
|---|---|---|---|
| `aeci.page.render.duration_ms` | distribution | `apps/web/src/server-runtime.ts` (`handleSsr`, cacheable render = native-cache MISS) | `route_class` (detail/index/browse), `cache_status` (`MISS` only — no `hit` series; WC-3/WC-8), `status_class` (2xx/4xx/5xx). **The raw `status_code` tag was dropped in AECI-642** — same cardinality defect as `aeci.api.query.duration_ms` below, on the web side. The exact code lives on the error log |
| `aeci.ssr.render` | count | `apps/web/src/server-runtime.ts` (`handleSsr`, every branch the Worker runs) | `cache_status` (`miss`/`non_cacheable` only — no `hit` series; WC-3/WC-8), `status_class` (2xx/4xx/5xx) |
| `aeci.api.query.duration_ms` | distribution | `apps/api/src/metrics-middleware.ts` (top-level Hono middleware) | `endpoint` (matched route pattern, e.g. `/api/products/:slug`), `status_class` — **the raw `status` tag was dropped in AECI-642**: `62 route patterns × ~15 distinct codes ≈ 930 series` from this metric alone, over the entire 1,000-series budget before any other metric existed. `status_class` costs 186. The exact code is not lost — it is on the error log, which is where you were going anyway once a rate moved. **Note (AECI-563):** on `endpoint:/api/promote` this now times only the fast kick-off, not the ingest; use `aeci.api.promote.job.duration_ms` for the commit |
| `aeci.api.promote.kickoff` | count | `apps/api/src/routes/promote-kickoff.ts` (`POST /api/promote`, AECI-563) | `outcome` (`created` / `existing` — `existing` is a replayed kick-off attaching to its already-running job, the idempotency guard firing), `payload` (`inline` / `staged` — `staged` means the bundle exceeded the 1 MiB Workflow-params cap and went to `PROMOTE_KV`) |
| `aeci.api.promote.job` | count | `apps/api/src/workflows/promote-workflow.ts` (`runPromoteWorkflow`, AECI-563) | `outcome` (`complete` / `errored`), plus `code` (the `ApiErrorCode`) on `errored` — one heartbeat per finished job; the always-emitted `outcome:complete` series is the ingest-liveness signal |
| `aeci.api.promote.job.duration_ms` | distribution | `apps/api/src/workflows/promote-workflow.ts` (`runPromoteWorkflow`, AECI-563) | `outcome` (`complete` / `errored`) — wall-clock of the whole job (payload load + plan + atomic batch + count recompute). **This is the metric that replaces the old promote request duration**; a slow ingest is no longer visible as a slow request |
| `aeci.api.promote.skipped` | count | `apps/api/src/routes/promote.ts` (`logPromoteSkips`) | `source` (`promote`), `kind` (`integration` / `extension` / `usefulness` / `claim` / `trade` / `vendor` / `product`) — **value = per-kind skip count, query with `sum:`** |
| `aeci.api.promote.stale_id` | count | `apps/api/src/routes/promote.ts` (`logPromoteStaleIds`, AECI-568) | `source` (`promote`), `kind` (`vendor` / `product` / `integration`) — **value = per-kind count, query with `sum:`**. The caller sent a `supabaseId` whose row no longer exists, so the ingest **created** a replacement instead of no-op-updating. Self-healing, but it means the review app was holding a dead pointer — a sustained non-zero series says the two sides are diverging |
| `aeci.api.promote.unresolved_link` | count | `apps/api/src/routes/promote.ts` (`logPromoteUnresolvedLinks`, AECI-730) | `source` (`promote`), `field` (`powered_by` / `built_by`) — **value = per-field count, query with `sum:`**. An integration was written **without** its `poweredByProduct` / `builtByVendor` FK because that record isn't promoted. Distinct from `skipped` on purpose: the row DID land. **Expected to be permanently non-zero** — Zapier and Workato are parked for good (AECI-700), so every promote of an edge naming them fires this. **Do not alert on presence; alert (if ever) on a rise.** Paired log is `info`, not `warn`, for the same reason |
| `aeci.api.promote.replay` | count | `apps/api/src/routes/promote.ts` (`logPromoteReplay`, AECI-571) | `source` (`promote`), `via` (`pre-read` / `batch-conflict`). Non-zero means the Workflows **at-least-once window actually fired** and the `promote_jobs` primary key absorbed it — the commit stayed exactly-once and the original IDs were returned. Informational, not actionable: the promote is correct. Capture the `job_id` from the paired log; a duplicated product on a job that reported `complete` once is now a bug, not this window |
| `aeci.cache.purge` | count | `apps/web/src/server/cache-purge-queue.ts` (WC-5 queue consumer — `promote`/`moderation`); `apps/web/src/server/routes/admin-purge.ts` (native `ctx.cache.purge()` since WC-6 / AECI-320 — `manual`/`ci-taxonomy-seed`) | `source` (promote / moderation / **vendor** — a vendor-portal self-service edit, AECI-520, kept distinct from AECi-initiated `moderation` / datatool / manual / ci-taxonomy-seed / future webhook), `outcome` (consumer: `ok` / `purge_failed` / `no_cache` / `noop`; `/admin/purge`: `ok` / `failed` / `skipped`, where `skipped` = native cache disabled on the tier), `mode` (`tags` / `path_prefixes` / `combined` / `everything`; `/admin/purge` only) |
| `aeci.api.data_gap` | count | `apps/api/src/lib/handler-utils.ts` (`reportMissingVendors`, called by the product-list-producing handlers) | `gap_type` (currently `missing_vendor`) |
| `aeci.api.vendor.updates` | count | `apps/api/src/routes/vendor-updates.ts` (`GET /api/vendor/updates`, AECI-627) | `changed` (`none` / `some`). The endpoint is **stateless** — it does not know what the caller last saw — so `some` means "a cursor moved within one poll interval (`VENDOR_UPDATES_CHANGE_WINDOW_MS`, 60 s = the longest shipped cadence) of this response", not "changed since your last poll". Read the `some` ratio as an **upper bound**: a 20 s focused client can be tagged `some` on three consecutive polls for one write. This is the series ADR 0023's re-open trigger names — a high `none` ratio is the evidence for lengthening the poll interval; a sustained high `some` ratio, plus request volume exceeding the cost of a hibernating Durable Object, is the evidence for revisiting the transport |
| `aeci.algolia.sync` | count | `apps/api/src/scheduled.ts` (daily cron) + `apps/api/src/routes/promote.ts` (`syncAlgoliaAfterPromote`) | `trigger` (cron / promote), `entity` (products / vendors / integrations / all), `outcome` (ok / failed / skipped_no_creds) |
| `aeci.algolia.index_drift` | gauge | `apps/api/src/scheduled.ts` (daily cron) + `apps/api/scripts/reconcile-algolia-drift.ts` (CLI / deploy-staging hook) | `entity` (products/vendors/integrations), `index` (physical index name) |
| `aeci.algolia.orphans_removed` | gauge | `apps/api/src/scheduled.ts` (daily drift cron, post-report sweep) + `apps/api/scripts/reconcile-algolia-drift.ts` (CLI) — AECI-266 | `entity` (products/vendors/integrations), `index` (physical index name) |
| `aeci.algolia.orphans_skipped_cap` | gauge | `apps/api/src/scheduled.ts` (daily drift cron) — AECI-266; emitted only when the safety cap refuses a large purge | `entity` (products/vendors/integrations), `index` (physical index name) |
| `aeci.algolia.sync.records` | count | `apps/api/src/lib/algolia-sync-metrics.ts` (`emitAlgoliaSyncMetrics`, from the cron + promote hook) | `trigger` (cron / promote), `entity` (products / vendors / integrations), `op` (saved / deleted) |
| `aeci.algolia.sync.duration_ms` | distribution | `apps/api/src/lib/algolia-sync-metrics.ts` (`emitAlgoliaSyncMetrics`, from the cron + promote hook) | `trigger` (cron / promote) |
| `aeci.search.query` | RUM action — **retiring** | `apps/web/src/app/search/search-rum.ts` (`emitSearchQuery`), called by `search-controller.ts` (per-index `connectStats` render + instance `error` event) and `autocomplete-controller.ts` (`runSearch`) — AECI-174; see "Browser search telemetry" below | `index` (products/vendors/integrations/federated), `status` (ok/error), `results_bucket` (none/1-5/6-20/21+), `duration_ms`. **This action and its two RUM-sourced Phase-3 dashboard widgets die with AECI-651** (§3.9). The same four fields now also ride the **`search_performed` PostHog event** (AECI-643) — including a `status: 'error'` row, without which the search error rate would be unrecoverable. `search-rum.ts` is deliberately untouched so RUM keeps emitting through the dual-run. **The narrowing is real and is accepted:** the RUM action saw *every* search; the event sees the **consented** slice only |
| `aeci.stats.compute` | count | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the daily cron + the post-promote refresh) + an inline pre-compute-crash count in `apps/api/src/scheduled.ts` and `apps/api/src/routes/promote.ts` | `trigger` (cron / promote), `outcome` (success / partial / failed) |
| `aeci.stats.compute.duration_ms` | distribution | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the cron + promote hook) | `trigger` (cron / promote) |
| `aeci.stats.compute.key` | count | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the cron + promote hook) | `trigger` (cron / promote), `key` (the `home.*` stats_cache key), `outcome` (written / skipped / failed) |
| `aeci.stats.compute.key.duration_ms` | distribution | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the cron + promote hook) | `trigger` (cron / promote), `key` (the `home.*` stats_cache key) |
| `aeci.metrics_snapshot.run` | count | `apps/api/src/lib/metrics-snapshot.ts` (`emitMetricsSnapshotMetrics`, from the daily 00:15 UTC snapshot cron) + an inline pre-compute-crash count in `apps/api/src/scheduled.ts` | `trigger` (cron), `outcome` (ok / partial / failed) — always emitted, so this doubles as the cron-liveness heartbeat |
| `aeci.metrics_snapshot.run.duration_ms` | distribution | `apps/api/src/lib/metrics-snapshot.ts` (`emitMetricsSnapshotMetrics`) | `trigger` (cron) |
| `aeci.metrics_snapshot.metric` | count | `apps/api/src/lib/metrics-snapshot.ts` (`emitMetricsSnapshotMetrics`) | `trigger` (cron), `metric` (the `metrics_daily` key — one of the 19 in `ADMIN_SNAPSHOT_METRIC_KEYS`), `outcome` (written / failed) |
| `aeci.pageviews.write` | count | `apps/api/src/routes/page-views.ts` (`capturePageView`, the deferred `POST /api/page-views` insert) | `outcome` (ok / failed / **deduped**); on `outcome:ok` also `bot` (true / false — the ingest-time UA+ASN classification, AECI-526) so the human/bot ratio is queryable in the metrics plane without waiting for the daily digest |
| `aeci.pageviews.speculative` | count | `apps/web/src/server-runtime.ts` (`firePageView`) | none — a browser prefetch/prerender the Worker refused to count as an arrival (AECI-743) |
| `aeci.auth.signin` | count | `apps/web/src/server/routes/auth-callback.ts` (the SSR `/auth/callback` handler — **carries `service:aeci-web`**, AECI-206) | `method` (google / magic_link / unknown), `outcome` (success / failed), `reason` on failure (link_invalid / missing_code / auth_not_configured) |
| `aeci.review.submit` | count | `apps/api/src/routes/reviews.ts` (`createSubmitReviewHandler`, AECI-206) | `outcome` (ok / duplicate / product_not_found) |
| `aeci.moderation.action` | count | `apps/api/src/routes/admin-reviews.ts` (`createModerateReviewHandler`, AECI-206) | `action` (approve / reject), `outcome` (ok / invalid_state) |
| `aeci.toxicity.api` | count | `apps/api/src/lib/toxicity.ts` (`scoreToxicity`, AECI-206 / AECI-258) | `outcome` (ok / failed), `reason` on failure (http_error / malformed / timeout / network) |
| `aeci.toxicity.api.duration_ms` | distribution | `apps/api/src/lib/toxicity.ts` (`scoreToxicity`, AECI-206 / AECI-258) | `outcome` (ok / failed) |
| `aeci.moderation.queue_depth` | gauge | `apps/api/src/lib/moderation-metrics.ts` (`emitModerationQueueMetrics`, from the daily 06:00 UTC moderation cron) | — |
| `aeci.moderation.queue_oldest_age_hours` | gauge | `apps/api/src/lib/moderation-metrics.ts` (`emitModerationQueueMetrics`, from the daily 06:00 UTC moderation cron) | — |
| `aeci.linear.issue` | count | `apps/api/src/lib/linear.ts` (`createLinearIssueForRequest`, AECI-211 — the request→Linear `ctx.waitUntil` task) | `outcome` (ok / failed / skipped_exists), `kind` (claim / correction), `reason` on failure (http_error / graphql_error / timeout / network / empty_response / db_error) |
| `aeci.linear.issue.duration_ms` | distribution | `apps/api/src/lib/linear.ts` (`createLinearIssueForRequest`, AECI-211) | `outcome` (ok / failed) |
| `aeci.webhooks.linear.receipt` | count | `apps/api/src/routes/webhooks.ts` (`createLinearWebhookHandler`, AECI-212 — the inbound `POST /api/webhooks/linear`, emitted after a valid HMAC verify) | `type` (Linear webhook resource, e.g. `Issue`), `action` (`create` / `update` / `remove`) |
| `aeci.webhooks.linear.hmac_failure` | count | `apps/api/src/routes/webhooks.ts` (`createLinearWebhookHandler`, AECI-212 — emitted before the 401 when `Linear-Signature` is missing/invalid) | — |
| `aeci.linear.sync` | count | `apps/api/src/lib/linear.ts` (`pushRequestResolutionToLinear`, AECI-213 — the site→Linear resolve/reject `ctx.waitUntil` push) | `outcome` (ok / failed / skipped_no_issue), `kind` (claim / correction), `to_status` (resolved / rejected), `reason` on failure (http_error / graphql_error / timeout / network / empty_response / db_error) |
| `aeci.linear.sync.duration_ms` | distribution | `apps/api/src/lib/linear.ts` (`pushRequestResolutionToLinear`, AECI-213) | `outcome` (ok / failed) |
| `aeci.linear.reconcile.stuck` | gauge | `apps/api/src/lib/reconciliation-sweep.ts` (`runReconciliationSweep`, AECI-214 — the every-15-min sweep) | — (backlog: count of `open`/unlinked `vendor_requests` older than the stuck threshold; **0 on a clean run**) |
| `aeci.linear.reconcile.attempt` | count | `apps/api/src/lib/reconciliation-sweep.ts` (`runReconciliationSweep`, AECI-214) | `outcome` (cleared / still_failing) — submits the **row count** as the value, so query with `sum:` |
| `aeci.linear.reconcile.persistent_failure` | count | `apps/api/src/lib/reconciliation-sweep.ts` (`runReconciliationSweep`, AECI-214) | — (count of requests stuck past the persistent threshold AND still failing after a retry; the alert signal — submits the row count, query with `sum:`) |
| `aeci.linear.reconcile.email` | count | `apps/api/src/lib/admin-alert.ts` (`sendAdminAlert`, AECI-214; transport AECI-240) | `outcome` (sent / failed / skipped) — sends via Resend; `skipped` when `RESEND_API_KEY` / `ADMIN_ALERT_EMAIL` are absent (the seam is fail-open and the **alert** is the backstop) |
| `aeci.request.moderation.action` | count | `apps/api/src/routes/admin-requests.ts` (`emitRequestModeration`, AECI-216 / Phase 6.9 — the `PATCH /api/admin/requests/:id` resolve/reject handler) | `action` (`resolve` / `reject`), `outcome` (`ok` / `invalid_state`) — one count per moderation attempt; `invalid_state` is the §6.9 preload guard (422 when the target isn't `open`/`in_review`) |
| `aeci.email.send` | count | `apps/api/src/lib/email.ts` (the Resend transactional client, AECI-240 / Phase 7.5, extended by every epic that added a template) | `outcome` (sent / failed / skipped), `template` — **the tag list is the `EmailTemplate` union in `lib/email.ts`, and `docs/email.md`'s catalogue is its prose mirror; keep all three in step.** Currently: `review-submitted` / `review-approved` / `review-rejected` / `account-deleted` / `mailing-list-welcome` / `stuck-request-alert` / `landing-signup` / `landing-feedback` / `claim-approved` / `claim-rejected` / `attestation-silent-counterparty` / `attestation-open-conflict` / `attestation-stale-version` / `attestation-ops-alert` / `entitlement-expiring` / `entitlement-expiring-admin`. Fail-open; `skipped` when `RESEND_API_KEY` / `EMAIL_FROM` / the recipient are absent (see `docs/email.md`) — for the two vendor-addressed sweeps (`attestation-*`, `entitlement-expiring`) that also covers an absent `SUPABASE_SERVICE_ROLE_KEY`, which is the expected local / PR-preview state |
| `aeci.data_quality.job` | count | `apps/api/src/scheduled.ts` (`runDataQualityJob`, daily 04:00 UTC cron, AECI-241 / Phase 7.6) | `trigger` (cron), `outcome` (success / failed) — one heartbeat per completed run (incl. the pre-run crash path); `outcome:failed` is the failure signal, the always-emitted `{trigger:cron}` series is the liveness signal |
| `aeci.data_quality.job.duration_ms` | distribution | `apps/api/src/scheduled.ts` (`runDataQualityJob`, daily cron) | `trigger` (cron) |
| `aeci.data_quality.check` | gauge | `apps/api/src/scheduled.ts` (`runDataQualityJob`, daily cron, AECI-241) | `check` (the check id, e.g. `products_without_vendor` / `broken_integration_refs` / `reviews_missing_anonymized_at` / `algolia_index_drift` / `entitlement_mirror_drift`), `severity` (error / warn) — **value is the issue count or 0** (emitted every run so a monitor can break down by check and detect no-data); a check that threw emits the sentinel **-1**. **`entitlement_mirror_drift` (severity `error`, AECI-609) is Guard 2 of the `vendors.verified` mirror invariant** (`STAGE_2_PAID_TIERS_SPEC.md` §2.1): it counts vendors where `verified = 1` XOR an `active` `vendor_entitlements` row exists. Non-zero means something wrote the mirror outside `lib/vendor-entitlement.ts` — hand-written D1 SQL, the `apps/datatool` Worker, or (the likely one) a §2.4 backfill that ran on one tier and not another. It rides the existing gauge deliberately, so it needed no new metric and no new monitor |
| `aeci.data_quality.email` | count | `apps/api/src/scheduled.ts` (`runDataQualityJob` → `lib/email.ts` `sendEmail`, AECI-241) | `outcome` (sent / failed / skipped) — **`skipped`** when `RESEND_API_KEY` / `DATA_QUALITY_EMAIL_{FROM,TO}` are unset (fail-open; the **alerts** are the delivery backstop) |
| `aeci.attestation.detector` | gauge | `apps/api/src/lib/attestation-notify-metrics.ts` (`emitDetectorMetrics`, from the daily 10:00 UTC §7 attestation sweep in `apps/api/src/scheduled.ts` `runAttestationNotifyJob`, AECI-302) | `detector` (`silent-counterparty` / `open-conflict` / `stale-version` / `aeci-denied`) — **value is the finding count or 0**, emitted for every detector in the union on **every** run (a detector dropped from the registry flatlines at 0 rather than vanishing); a detector that threw emits the sentinel **-1**, the same idiom as `aeci.data_quality.check`. **This zero series is the job's only liveness signal until vendors start attesting** — the detectors match nothing while every attestation in D1 is still `source='aeci'`. **Since AECI-705 the value is the POST-GATE count**: `runAttestationDetectors` drops every vendor-addressed finding on a connector-powered edge (~14% of the catalogue) inside the same `try` that produces this gauge, so it measures what is actually **sent**, not what was found. Ops-routed findings (`vendorId: null` — all of `aeci-denied`, and `open-conflict`'s AECi row) are never dropped and still count |
| `aeci.attestation.notify.job` | count | `apps/api/src/scheduled.ts` (`runAttestationNotifyJob`, daily 10:00 UTC cron, AECI-302) | `trigger` (cron), `outcome` (success / failed) — one heartbeat per run. Unlike the read-only gauge jobs this one **rethrows** after emitting `outcome:failed`, so the queue consumer retries |
| `aeci.attestation.notify.job.duration_ms` | distribution | `apps/api/src/scheduled.ts` (`runAttestationNotifyJob`, daily cron) | `trigger` (cron) |
| `aeci.attestation.notify.sent` | count | `apps/api/src/lib/attestation-notify-metrics.ts` (`emitNotifyOutcomeMetrics`, same sweep) | `detector`, `outcome` (`sent` / `failed` / `skipped`) — aggregated to one point per (detector, outcome) per run, not one per email. Only findings the sweep actually attempted to send are counted here: **`skipped`** means no resolvable recipient (no `RESEND_API_KEY`, no `ADMIN_ALERT_EMAIL`, or `fetchAuthUserEmails` degraded without `SUPABASE_SERVICE_ROLE_KEY`) and writes no ledger row, so it is retried by the next sweep. Findings **suppressed** by an in-window `audit_log` ledger row (§7.3) are filtered out *before* the send loop, so they never reach this metric — the suppressed count lives in the per-run summary log (`aeci.attestation.notify found=… suppressed=…`), not as an `outcome:` tag here |
| `aeci.entitlement.action` | count | `apps/api/src/routes/admin-entitlements.ts` (`emitEntitlementAction`, AECI-532 — the `PATCH /api/admin/vendors/:id/entitlement` set/renew/clear handler) | `action` (`set` / `renew` / `clear`), `outcome` (`ok` / `invalid_state` / `forbidden`) — one count per attempt, alongside the `vendor_entitlement.set` / `.renewed` / `.cleared` `audit_log` row written in the same `db.batch`. `invalid_state` is the §5.1 422 gate (a `set` on an already-active entitlement, a `renew`/`clear` on one that is not active); `forbidden` is the zero-capability-tier guardrail. **This is the only metric that moves when a Verified badge appears or disappears**, so `action:clear` is the series to watch — `outcome:ok` there means a vendor's badge is coming off every cached page and out of the next nightly Algolia push |
| `aeci.claim.moderation.action` | count | `apps/api/src/routes/admin-claims.ts` (`emitClaimModeration`, AECI-519; `action:note` added by AECI-739) | `action` (`approve` / `reject` / `note`), `outcome` (`ok` / `noop` / `invalid_state` / `conflict` / `unavailable`) — one count per attempt against a vendor claim. `approve` + `ok` is a verified vendor account being minted, so it moves in lockstep with `aeci.entitlement.action`'s grant path; `unavailable` is the 503 that fires wherever `SUPABASE_SERVICE_ROLE_KEY` is absent, which is expected on PR previews and a real incident anywhere else. `action:note` is the AECI-739 operator note (§5.2 step 6) — an annotation, so it grants nothing and its `noop` simply means the submitted text was unchanged. **Undocumented until AECI-739**: the series has existed since AECI-519 and was never catalogued here |
| `aeci.entitlement.expiry_due` | gauge | `apps/api/src/lib/entitlement-expiry-metrics.ts` (`emitExpiryDueMetric`, from the daily 11:00 UTC §7 sweep in `apps/api/src/scheduled.ts` `runEntitlementExpiryJob`, AECI-613) | — (no tags) — terms inside the warning horizon this run, **before** the `expiry_notice_sent_at` fence. A gauge, not a count, because it is a stock rather than a flow: it answers "how much is due" and stays flat while nobody renews. **Emitted on every run including zero**, which is what makes it a liveness signal — every §2.4 backfilled entitlement is perpetual (`period_end IS NULL`) and therefore structurally invisible to this job, so **0 is the healthy steady state for a long time** and no-data is the failure |
| `aeci.entitlement.expiry_notice` | count | `apps/api/src/lib/entitlement-expiry-metrics.ts` (`emitExpiryNoticeMetrics`, same sweep) | `channel` (`vendor` / `admin`), `outcome` (the `EmailOutcome` verbatim: `sent` / `failed` / `skipped`) — aggregated to one point per (channel, outcome) per run, not one per email, so a vendor with four seats is not four identical counts. **`channel:vendor,outcome:skipped` on a deployed tier is a real finding** (a missing `SUPABASE_SERVICE_ROLE_KEY`, or a vendor with no unbanned seat) rather than the expected state it is locally and on PR previews; `channel:admin` needs only `ADMIN_ALERT_EMAIL` and should always land |
| `aeci.entitlement.expiry.job` | count | `apps/api/src/scheduled.ts` (`runEntitlementExpiryJob`, daily 11:00 UTC cron, AECI-613) | `trigger` (cron), `outcome` (ok / failed) — one heartbeat per run. Unlike the attestation sweep this job **does not rethrow**: a retry would re-send every notice whose fence write is what failed, so an unexpected error is an `outcome:failed` heartbeat and a `failed` `job_runs` row and nothing more. Per-notice send failures and batch failures stay `outcome:ok` with the counts in the summary log — the sweep is fail-open and tomorrow's run picks up exactly what this one missed |
| `aeci.entitlement.expiry.job.duration_ms` | distribution | `apps/api/src/scheduled.ts` (`runEntitlementExpiryJob`, daily cron) | `trigger` (cron) |
| `aeci.waf.ratelimit.blocked` | count | `apps/api/src/lib/waf-metrics.ts` (`emitWafEventMetrics`, from the hourly WAF poll in `apps/api/src/scheduled.ts` `runWafMetricsJob`, AECI-262) | `rule` (CF rule id), `action` (block / managed_challenge / …), `host`, `source` (ratelimit / firewallcustom) — **value is the event count, so query with `sum:`** (Datadog gotcha 3; on PostHog it is an OTLP monotonic sum and the choice disappears); only mitigation actions counted |
| `aeci.waf.poll` | count | `apps/api/src/scheduled.ts` (`runWafMetricsJob`, hourly cron, AECI-262) | `trigger` (cron), `outcome` (ok / failed / skipped_no_creds) — one heartbeat per run; the always-emitted `outcome:ok` series is the cron-liveness signal |
| `aeci.cron.no_handler` | count | `apps/api/src/scheduled.ts` (the `scheduled()` dispatch `default:` branch, AECI-661) | `cron` (the unmatched expression). **Any non-zero value is a defect.** `controller.cron` is matched by exact string, so a deployed `triggers.crons` entry that drifts from `lib/cron-schedules.ts` silently does nothing. This used to be a bare `console.warn`, which made a mis-scheduled job indistinguishable from a quiet week — `asn_registry` sat in exactly that state, and the only evidence was an absent `job_runs` row |
| `aeci.analytics_digest.email` | count | `apps/api/src/scheduled.ts` (`runAnalyticsDigestJob` → `lib/email.ts` `sendEmail`, AECI-526, daily 05:00 UTC = noon Jakarta cron) | `outcome` (sent / failed / skipped) — the daily operator digest: **human** page views (`is_bot IS NOT 1` + `NOT_INTERNAL`, an UPPER bound) + the AECI-660 PostHog lower bound + the AECI-683 corroborated floor, top products, new/total sign-ins, pending-moderation depth, and a Crawler-activity breakdown (`is_bot = 1`, grouped by `bot_name`). This metric carries only the send outcome — the figures themselves land in `job_runs.detail` (`AnalyticsDigestSummary`), which is where to look when a number moves and you want the history rather than one morning's email. **`skipped`** when `RESEND_API_KEY` / `EMAIL_FROM` / `ANALYTICS_DIGEST_EMAIL_TO` are unset (fail-open); one count per run, so the always-emitted series doubles as the cron-liveness signal (`outcome:failed` also covers a pre-send crash) |
| `aeci.vendor_seat.provision` | count | `apps/api/src/routes/admin-vendors.ts` (`emitSeatProvision`, **AECI-740** — `POST /api/admin/vendors/:id/seats`, the connector-vendor catalogue-maintenance seat) | `outcome` (`ok` / `noop` / `conflict` / `unavailable` / `not_found`) — one count per attempt, including the refusals, alongside the `vendor_seat.provisioned` `audit_log` row written in the same `db.batch`. This is the only route that writes `profiles.role = 'vendor_admin'` **on its own** — the claim grant and the invite redeem write it too — so `outcome:ok` is the complete record of a seat handed out with no claim and no invite behind it; it opens no `vendor_entitlements` row, so it will NOT appear in `aeci.entitlement.action` and a vendor seated this way is deliberately invisible to `entitlement_mirror_drift` (`STAGE_2_SPEC.md` §8.9(2)/(4)). **`outcome:unavailable` is the one to watch**: it means `SUPABASE_SERVICE_ROLE_KEY` is absent or GoTrue errored, which is EXPECTED on local dev and PR previews and is an incident anywhere else — nothing was written either way. `outcome:conflict` is the 409 exclusivity refusal (the account is a site admin, or already belongs to a different vendor) and is worth a look on its own: it usually means the operator has the wrong address, not that the rule is wrong |
| `aeci.connector_catalog.management` | count | `apps/api/src/routes/admin-connector-catalogs.ts` (`emitManagementAction`, **AECI-720** — the `PATCH /api/admin/connector-catalogs/:id` per-iPaaS management cutoff) | `to` (`vendor` / `review` — the state flipped TO), `outcome` (`ok` / `invalid_state` / `not_found`) — one count per attempt, alongside the `connector_catalog.managed_by_vendor` / `.managed_by_review` `audit_log` row written in the same `db.batch`. `to:vendor` + `outcome:ok` is the moment a review lane FREEZES: from then on the connector-catalogue sync refuses that catalogue's pages with `CATALOG_VENDOR_MANAGED`, so a spike in errored connector promote jobs right after one of these is expected, not an incident. `outcome:invalid_state` is the 422 gate (the catalogue is already in the requested state) and is worth watching on its own — it means an operator's model of who controls a lane disagrees with the database |
| `aeci.moderation.ban` | count | `apps/api/src/routes/admin-reviewers.ts` (`emitBanAction`, **AECI-218 / Phase 6.11**; `role` tag added **AECI-524** — the `PATCH /api/admin/reviewers/:id` ban/unban write-path) | `action` (`ban` / `unban`), `role` (`reviewer` / `vendor_admin` — the moderated seat's role), `outcome` (`ok` / `invalid_state` / `forbidden`) — one count per ban/unban attempt, alongside the §9 `appendAuditLog()` + `reviewer_ban` `workflow_transition` |
| `aeci.job_runs.write` | count | `apps/api/src/scheduled.ts` (`jobRunSink` → `lib/job-runs.ts`, **AECI-583 / Phase 8.3 P3.1**) | `phase` (start / finish), `job` (the `AdminCronJob` id), `outcome` (ok / failed) — this measures the **recorder, not the job**: a `failed` here means the admin panel's cron liveness under-reports while the job itself completed normally. Emitted on success too, so a silently-broken writer is distinguishable from "no crons ran". 36 series, ~245 points/day. Companion error log: `aeci.job_runs.write_failed`, `source:job-runs` |
| `aeci.asn_registry.refresh` | count | `apps/api/src/scheduled.ts` (`runAsnRegistryJob`, from the WEEKLY Monday 02:00 UTC refresh cron — **AECI-624 / §7.6**) | `trigger` (cron), `outcome` (ok / partial / failed / skipped) — always emitted, so this doubles as the cron-liveness heartbeat. **This is a weekly series**: a no-data monitor on it must use a window of at least two weeks or it will alert every Tuesday. `failed` means the panel is annotating from a stale registry (it never deletes), NOT that annotations disappeared; `skipped` means there were no `page_views` ASNs to classify, which is only ever the expected state on a fresh environment |
| `aeci.asn_registry.coverage` | gauge | `apps/api/src/scheduled.ts` (`runAsnRegistryJob`) | none — a single 0–1 fraction: the share of distinct `page_views.cf_asn` values the registry has a record for. **The number worth watching, and the one nothing else surfaces**: it decays silently between runs as new networks arrive, and freshness cannot detect that — a registry refreshed this morning can still annotate almost nothing. Baseline ≈0.75 in production; §7.6 documents why the tail is poor (PeeringDB has no record, or a blank `info_type`, for ~25% of our traffic) |
| `aeci.retention.prune` | count | `apps/api/src/lib/retention-prune.ts` (`emitRetentionPruneMetrics`, from the daily 03:00 UTC prune cron) + an inline crash count in `apps/api/src/scheduled.ts` (**AECI-584 / Phase 8.3 P3.2**) | `trigger` (cron), `outcome` (ok / skipped / failed), `reason` (`metrics_daily_gap`, on skips only) — always emitted, so this doubles as the cron-liveness heartbeat. **`skipped` is the one to watch**: it means a day inside the `page_views` cut window has no `metrics_daily` row, so the prune refused to delete anything from EITHER table |
| `aeci.retention.rows_deleted` | count | `apps/api/src/lib/retention-prune.ts` (`emitRetentionPruneMetrics`) | `trigger` (cron), `table` (page_views / job_runs) — **emitted every run for every table, zeros included**, which is what makes a threshold monitor possible. §7.4 asks for a runaway prune to be visible here *before* it is visible as missing data; a series that only appeared when something was deleted could not do that |
| `aeci.retention.prune.duration_ms` | distribution | `apps/api/src/lib/retention-prune.ts` (`emitRetentionPruneMetrics`) | `trigger` (cron) |
| `aeci.retention.prune.truncated` | count | `apps/api/src/lib/retention-prune.ts` (`emitRetentionPruneMetrics`) | `trigger` (cron), `table` — the per-table run budget (`MAX_CHUNKS_PER_TABLE × PRUNE_CHUNK_ROWS` = 10,000 rows) stopped the run short. Not a failure: the next night continues. Persisting for several days means the window is shortening faster than the prune can catch up |

`aeci.ssr.render` (AECI-103) is one count per SSR render, fired on **every** branch the
Worker runs — the cacheable render (a native-cache MISS) and the non-cacheable branch, which
the `aeci.page.render.duration_ms` distribution skips. Post-WC-3 (AECI-317) edge HITs skip the
Worker under native Workers Cache, so there is **no `cache_status:hit` slice** here (HIT-rate
moves to `Cf-Cache-Status`; WC-8). It is the bounded pipe-health / render-volume signal that
replaced the per-render `ssr.render` *log* firehose. Tags are kept deliberately low-cardinality
(`cache_status` + `status_class`, no path/slug) so cost can't balloon. `cache_status:non_cacheable`
is the slice for the `**` 404 wildcard and non-GET requests.

Every metric also carries the shared vocabulary described under "The attribute
vocabulary" above — `env`, `app:aeci`, `service`, `service.name`, `worker`,
`source`, `version`, `locale` — attached by the transport as OTLP resource
attributes, **without `host`**. The tags listed in the table are the per-point
attributes the call site supplies.

## Cardinality budget (AECI-645 / POSTHOG_MIGRATION_SPEC.md §3.5)

PostHog guardrails metrics at **1,000 series per window**. Datadog had no
comparable ceiling at our volume, so the catalogue above was grown one tag at a
time without anyone doing the sum. This section is that sum, and the standing
rule that comes out of it.

> **The standing rule: no new tag without redoing this arithmetic.**
> Adding one two-valued tag to `aeci.api.query.duration_ms` costs 186 series —
> a fifth of the entire budget — because tag cost is multiplicative, not
> additive. If you add a metric or a tag dimension, update the table below in
> the same PR. A budget nobody recomputes is a budget nobody has.

### Series identity includes the resource attributes

A PostHog metric series is identified by the **whole** attribute tuple — the
per-point attributes *and* the OTLP resource attributes. That second half is
easy to forget because we never write it at the call site: the transport
(`packages/shared/src/posthog.ts`) attaches `service.name`, `env`, `app`,
`service`, `worker`, `version` and `locale` to every point automatically.

Within one project most of those are ×1 (`app` is always `aeci`, `locale` is
always `en-US`, and a given metric is emitted by exactly one `service`). Two
are not:

- **`version` (= `COMMIT_SHA`) is ×2 for the length of a deploy overlap.** Two
  Worker versions are live at once, so every series in the catalogue
  temporarily doubles. It collapses back on its own, but it means the budget
  must be sized against `2 × steady-state`, not steady-state.
- **`env` is ×1 in the production project and up to ×4 in the non-production
  one**, which carries preview, staging, demo and stage2 together (§3.6 / D4).
  The non-prod project is therefore the tighter constraint, not the looser one.

### The arithmetic

Per-point series counts, at steady state, for the metrics that actually cost
something. Everything not listed is single-digit; the long tail of ~50 metrics
contributes ≈490 between them.

| Metric | Arithmetic | Series |
|---|---|---|
| `aeci.api.query.duration_ms` | 62 route patterns × 3 `status_class` | **186** |
| `aeci.waf.ratelimit.blocked` | ~5 `rule` × ~3 `action` × ~3 `host` × 2 `source` | ~90 |
| `aeci.stats.compute.key` | 2 `trigger` × 12 `home.*` keys × 3 `outcome` | 72 |
| `aeci.email.send` | 16 templates × 3 `outcome` | 48 |
| `aeci.cache.purge` | consumer (3 × 4) + `/admin/purge` (3 × 3 × 4 `mode`) | ~48 |
| `aeci.metrics_snapshot.metric` | 19 `metrics_daily` keys × 2 `outcome` | 38 |
| `aeci.job_runs.write` | 2 `phase` × 9 jobs × 2 `outcome` | 36 |
| `aeci.linear.sync` | `outcome` × `kind` × `to_status` × `reason` | ~32 |
| `aeci.stats.compute.key.duration_ms` | 2 `trigger` × 12 keys | 24 |
| `aeci.algolia.sync` | 2 `trigger` × 4 `entity` × 3 `outcome` | 24 |
| *(remaining ~50 metrics)* | mostly `outcome` × one dimension | ≈490 |
| **Steady-state total** | | **≈854** |
| **During a deploy overlap** | ×2 for `version` | **≈1,708** |

**≈854 is 85% of the guardrail before any multiplier, and a deploy overlap puts
us at ~1.7× over it.** That is the finding. Two decisions follow, both taken in
AECI-645 and implemented in AECI-642.

### Decision 1 — the raw `status` tag is dropped

`aeci.api.query.duration_ms` used to carry both raw `status` and `status_class`.
Because `status` determines `status_class`, the pair costs 62 × ~15 distinct
codes ≈ **930 series from a single metric** — over the entire budget on its own,
before every other metric in the catalogue. Keeping `status_class` costs 186.

The exact status code is not lost. It lives on the error log, which is where you
were going to look anyway once a rate moved: a metric tells you *that* 5xx rose,
the log tells you *which* endpoint returned *what*.

The same defect existed on the web side — `aeci.page.render.duration_ms` carried
a raw `status_code` beside `status_class`. Dropped for the same reason.

### Decision 2 — `host` is a log attribute, not a metric attribute

This is a deliberate exception to the "one tag vocabulary on all pipes"
invariant, and it is the reason the arithmetic was worth doing.

In the **non-production** project, the preview tier deploys **one Worker per
pull request** (`aeci-web-pr-123.<subdomain>.workers.dev`). If `host` were a
metrics resource attribute, every series in the catalogue would fork per PR —
**unbounded cardinality that grows with every PR, forever**, and no amount of
tag discipline elsewhere would recover it. In production it is a more modest
×2–3 (`aecintegrations.com`, `www.`, `prod.`) but for no analytical gain, since
`env` already identifies the tier and the apex 301s to `www` anyway.

So `host` stays on **logs** — cheap there, high-cardinality is the norm for
logs, and "which hostname served this" is a real question when reading one.
It is **not** attached to metric points or metric resources.

Note the one place `host` legitimately remains on a metric:
`aeci.waf.ratelimit.blocked` carries it as a *per-point* attribute, because a
WAF event is intrinsically about a hostname and the set is the small, fixed list
of zone hostnames. That is bounded and deliberate.

### Value-bearing counts map to OTLP monotonic sums

Several metrics submit a **row count** as the value rather than incrementing by
one — `aeci.api.promote.skipped`, `aeci.api.promote.stale_id`,
`aeci.linear.reconcile.attempt`, `aeci.linear.reconcile.persistent_failure`,
`aeci.waf.ratelimit.blocked`. Under Datadog these were the "query with `sum:`,
not `count:`" gotchas: `count:` counted *submissions* and silently under-reported,
which is a genuinely nasty class of bug because the graph looks plausible.

**That gotcha dies with the migration.** Every one of them maps to an OTLP `sum`
with `isMonotonic: true` and DELTA temporality, so the submitted value *is* the
delta and any aggregation over the series adds up correctly. There is no
`count:`-vs-`sum:` choice left to get wrong.

Gauges (`aeci.algolia.index_drift`, `aeci.moderation.queue_depth`,
`aeci.data_quality.check`, `aeci.attestation.detector`,
`aeci.entitlement.expiry_due`, …) stay OTLP `gauge` — they report a level as of
submission, not a delta, and summing them is meaningless.

### Never a user, person, or session id on a metric

Not once, not "just for debugging". An identifier tag is cardinality equal to
the user base, so a single such tag would blow the entire budget the first day
it saw traffic — and it would do it silently, by pushing *other* metrics out of
the window rather than by failing.

Person-level correlation has a designed home: `posthogDistinctId` as a **log**
attribute on genuinely-authed requests (AECI-644 / §AW3), which is the exact
name PostHog joins on. An unhandled 500 is one click from the person via the
log. The metric stays anonymous and bounded.

## `job_runs` is a second recording surface, not a replacement (AECI-583)

Since AECI-583 every cron also writes a `job_runs` row in D1 (`DATABASE_SCHEMA.md`
§9.4, `ADMIN_PANEL_SPEC.md` §7.2), and `/admin/system` renders it. That does **not**
retire anything below. The two surfaces answer different questions, and the split
is not a matter of taste:

- **Something outside the Worker owns absence.** A job that does not run writes no
  `job_runs` row either, so its absence is invisible in D1 *by construction*. "The
  08:00 sync stopped firing" can only be answered by a checker that is not itself
  the thing that died. **That is the CI liveness sweep**
  (`scripts/ci/posthog-liveness-sweep.sh`), which took the job over from Datadog's
  `notify_no_data` monitors at AECI-651. It is emphatically **not** a PostHog alert — no PostHog tier
  has `notify_no_data`, and an alert that evaluates "count < 1" over an empty
  window returns no rows rather than a breach.
- **`job_runs` owns the record.** Outcome, duration, and a per-job payload, in
  product, no vendor login, over a 90-day window. For the data-quality job that
  payload is the whole ten-check result set, which is a thing no metric can carry.
  This independence is also what mitigates PostHog Metrics being alpha: if the
  metrics plane were wrong tomorrow, the in-product record would still be right.

**The invariant a reviewer can check: every cron emits both.** A `job_runs` row with
no matching heartbeat, or a heartbeat with no row, is a bug in the instrumentation
— not a discrepancy to reconcile by hand.

**Coverage widened in the port.** Datadog watched **six** of these crons for
absence; the CI sweep watches all **thirteen** (`observability/posthog/project-config.json`
holds the registry, one row per cron with its own staleness allowance).

| Cron | `job_runs.job` | Its liveness signal |
|---|---|---|
| 00:15 metrics snapshot | `metrics-snapshot` | `aeci.metrics_snapshot.run` (`outcome:success\|partial\|failed`) |
| Mondays 02:00 ASN registry (`0 2 * * 2` — CF day-of-week is 1=Sunday) | `asn-registry` | `aeci.asn_registry.refresh` (`outcome:ok\|partial\|failed\|skipped`) |
| 03:00 retention prune | `retention-prune` | `aeci.retention.prune` (`outcome:ok\|skipped\|failed`) |
| 04:00 data quality | `data-quality` | `aeci.data_quality.job` (`outcome:success\|failed`) |
| 05:00 analytics digest | `analytics-digest` | `aeci.analytics_digest.email` |
| 06:00 moderation snapshot | `moderation-snapshot` | `aeci.moderation.queue_depth` (gauge; no per-run heartbeat) |
| 07:00 home stats | `home-stats` | `aeci.stats.compute` (`outcome:success\|partial\|failed`) |
| 08:00 Algolia sync | `algolia-sync` | `aeci.algolia.sync` (`trigger:cron`) |
| 09:00 index drift | `algolia-drift` | `aeci.algolia.index_drift` (gauge; no per-run heartbeat) |
| 10:00 attestation detector sweep | `attestation-notify` | `aeci.attestation.notify.job` (`outcome:success\|failed`) — plus the per-detector `aeci.attestation.detector` gauge, which is emitted for every detector on **every** run including zeros. That zero series is the real liveness signal until vendors start attesting: the detectors match nothing while every attestation in D1 is `source='aeci'`, so "0 findings" is the healthy steady state and no-data is the failure. Added by AECI-302; this row by AECI-608 |
| 11:00 entitlement term expiry | `entitlement-expiry` | `aeci.entitlement.expiry.job` (`outcome:ok\|failed`) — plus the `aeci.entitlement.expiry_due` gauge, emitted every run including zero. As with the 10:00 sweep the zero series is the real liveness signal, and for a longer time: every backfilled entitlement is perpetual (`period_end IS NULL`) and structurally invisible to the partial expiry index, so "0 due" is healthy and no-data is the failure. Added by AECI-613 |
| `*/15` request reconcile | `request-reconcile` | `aeci.linear.reconcile.stuck` (gauge) |
| hourly WAF poll | `waf-poll` | `aeci.waf.poll` (`outcome:ok`) |

Two vocabularies meet here on purpose: the dispatcher's internal `ScheduledJob` ids
(`sync`, `drift`, `stats`, …) never reach either surface — `ADMIN_CRON_JOB` in
`apps/api/src/lib/cron-schedules.ts` maps them onto the `AdminCronJob` ids above.

One asymmetry worth knowing: **`home-stats` and `algolia-sync` are natively
partial** (per-key and per-entity respectively), and the metric models that as
`outcome:partial`. `job_runs.outcome` has no such member, so a partial run is
recorded `failed`, derived from the *same* `jobOutcome()` the metric tag uses. The
panel therefore never claims more success than the telemetry does for the same run.

## Measuring the D1 read-replication latency win (AECI-250)

The edge-read-latency thesis (ADR 0016) is realized by the D1 Sessions API:
reads default to the `'first-unconstrained'` session anchor and are served by the
nearest replica. **The signal is the existing `aeci.api.query.duration_ms`
distribution** (no new metric) — split by `endpoint`, it already isolates the
representative reads (`/api/products`, `/api/products/:slug`, `/api/vendors/:slug`,
`/api/integrations/:id`).

To quantify the delta: capture a baseline p50/p95 on those `endpoint` slices, then
enable read replication on the database (Cloudflare dashboard → D1 → *db* →
Settings → Enable Read Replication, or REST `read_replication:{"mode":"auto"}`)
and compare. The win is **prod-only** (local/preview run a single un-replicated
SQLite; `getDb` falls back to the plain binding there) and only appears **after**
the per-database flip — the code ships inert-safe before it. Replica reads also
surface in the D1 binding's own analytics (`served_by_region` / `served_by_colo`
on query results) for a region-routing sanity check.

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

`aeci.algolia.orphans_removed` / `aeci.algolia.orphans_skipped_cap` (AECI-266) promote the
drift check from report-only to **self-healing** for the negative-drift case. Right after the
`index_drift` report, the same 09:00 cron sweeps each index (`apps/api/src/lib/algolia-orphans.ts`):
browse every objectID, diff against the authoritative promoted-id set from D1, and
`deleteObject` the orphans (objects with no promoted D1 row — what the incremental sync
can't see to delete). `orphans_removed` is a per-`entity`/`index` gauge (0 on a clean run);
`orphans_skipped_cap` is emitted **only** when the safety cap (≤50 objects and ≤20% of an
index per pass) refuses an unexpectedly large purge — the `AECi — Algolia orphan sweep capped`
alert (PostHog — "Algolia orphan sweep capped") pages on a non-zero
value, and the operator runs `db:reconcile-algolia-drift --apply --force` after confirming it's
intended. The sweep is delete-only; **positive** drift (records missing from the index) stays
repaired by the 08:00 incremental sync, not here. The next day's `index_drift` reads 0 once
the orphans are gone.

`aeci.algolia.sync.records` and `aeci.algolia.sync.duration_ms` (AECI-141) round out the
sync-health picture the `aeci.algolia.sync` outcome count only hinted at. Both are emitted for
a **completed** run by the shared `emitAlgoliaSyncMetrics` (`apps/api/src/lib/algolia-sync-metrics.ts`),
called by both writers of the index — the daily cron and the post-promote hook — so the two
can't drift. `…records` is the count of objects pushed, split `op:saved` (upserts) / `op:deleted`
(removals), per `entity`; **its value is the record count, not 1, so query it with `sum:`, not
`count:`** (see Datadog gotcha 3). `…duration_ms` is one distribution point per run (wall-clock of the push
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
slowed without reading logs. The pre-compute crash path (a DB-client-init throw before `runHomeStats`)
stays an inline single `aeci.stats.compute{outcome:failed}` count — like the Algolia crash path, it
isn't a completed run. Because every completed invocation (and the crash path) emits exactly one
job-level `aeci.stats.compute{trigger:cron}` point regardless of outcome, that series is the
**liveness heartbeat** the "not running" monitor watches via `notify_no_data` (the same
always-reports pattern as the index-drift gauge).

The same `runHomeStats` also fires on every successful promote (`trigger:promote`, AECI-305 —
so the home banner reflects a promotion at once rather than lagging until the cron), emitting the
identical metric family with a `promote` trigger tag (and its own inline pre-compute-crash count in
`promote.ts`). The "not running" liveness monitor keys on `{trigger:cron}` only — promote runs are
event-driven and mustn't feed a fixed-cadence heartbeat — but the "compute failed" monitor is
trigger-agnostic, so a failed *promote* refresh alerts the same as a failed cron run (a genuine
"home stats didn't refresh" signal). A failed promote refresh also self-heals at the next daily cron.

`aeci.metrics_snapshot.*` (AECI-581 / `ADMIN_PANEL_SPEC.md` §7.1) is the same shape one layer over:
the daily 00:15 UTC cron that captures the prior **complete** UTC day into `metrics_daily`, the admin
panel's long memory. A completed run emits one job-level `aeci.metrics_snapshot.run` count
(`outcome:ok` = every one of the 19 metrics written, `partial` = some wrote + some failed, `failed` =
nothing wrote), one `aeci.metrics_snapshot.run.duration_ms` distribution, and a per-metric
`aeci.metrics_snapshot.metric{outcome:written|failed}` so a dashboard sees *which* key failed without
reading logs. The pre-compute crash path (a DB-client-init throw before `runMetricsSnapshot`) stays an
inline single `aeci.metrics_snapshot.run{outcome:failed}` count, exactly as `aeci.stats.compute` does.

Two things make this worth a monitor rather than just a dashboard. The cron is **queue-less**, so a
failed invocation is not retried — and unlike the other read-only crons, a missed run leaves a
permanent hole: the *stock* metrics (catalog totals, queue depths, subscriber counts) cannot be
reconstructed after the fact (§4), so a day not captured is a day lost. Recovery for the flow metrics
is `pnpm --filter @aeci/api ops:backfill-metrics-daily`, which is the same idempotent
`(day, metric)` upsert. **This cron has never had a dedicated Datadog monitor** — a known gap
(`PHASE_8_COMPLETION.md` §F5), and the worst one to have on a queue-less job whose missed *stock*
metrics are unrecoverable. AECI-583's `job_runs` row plus the always-emitted
`aeci.metrics_snapshot.run{trigger:cron}` series are the only signals today. **The PostHog port
closes it from both sides without anyone filing an issue:** `metrics-snapshot` is one of the six
previously-unwatched crons picked up by the combined cron-failure alert, and one of the thirteen in
the CI liveness sweep's registry (26 h window). The sweep is **already running**, so its red is
worth reading even during the dual-run.

`aeci.pageviews.write` (AECI-180) is the write-health signal for the `POST /api/page-views` insert
(AECI-177): one count per attempted insert, `outcome:ok` after a successful `page_views` write and
`outcome:failed` in the swallow-and-log catch. The bot-score sampled-out early return emits nothing
— it's an intentional skip, not a write, and must not pollute the error-rate denominator. The
endpoint already returned 204, so a failing insert is user-invisible; this metric makes the
regression visible as an error **rate** *before* it silently zeroes `home.trending_products` at the
next daily compute. AECI-743 added a third outcome, `deduped`, for a view refused by the
one-document-one-row guard (`dedupe_key`, `API_CONTRACTS.md` §6.9). It is counted rather than
dropped silently for the reason this whole issue exists: an unobserved miscount is
indistinguishable from an ingest outage, and the original double-fire survived undetected into the
digest's most trusted figure. **Keep it out of the error-rate denominator's numerator** — a
`deduped` is a correct refusal, not a failure. If it ever climbs to a large share of total writes,
that is a signal about the traffic (a prerendering client, a retry loop), not about ingest health.
Its writer-side counterpart is `aeci.pageviews.speculative`, emitted by the SSR Worker when it
declines to count a prefetch/prerender; a sudden rise there is worth reading alongside the digest,
since those loads used to be counted as arrivals. Note it is monitored on error-rate **only**, never liveness/no-data: page_views
is traffic-driven, so zero writes (no visitors) is normal at pre-launch and a no-data alert would
fire constantly — unlike the fixed-cadence stats cron.

`aeci.auth.signin` / `aeci.review.submit` / `aeci.moderation.action` / `aeci.toxicity.api*` /
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
- **`aeci.toxicity.api`** + **`aeci.toxicity.api.duration_ms`** are the toxicity-scoring health
  pair (`lib/toxicity.ts`, Claude Haiku, called once per review submit). Scoring is **fail-open** — an
  outage (or no key) stores `toxicity_score = null` and the review still enters the queue — so the count
  is an *outage/triage-loss* signal, never user-facing. The **absent-key** path is a silent no-op that emits
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
(no `LINEAR_API_KEY`, the expected non-prod state) emits **nothing**, mirroring `aeci.toxicity.api`,
so it never pollutes the error-rate denominator.

`aeci.linear.reconcile.*` (AECI-214, Phase 6.7) are the §6.7 reconciliation-sweep metrics — the
every-15-min backstop that retries those stuck rows. `aeci.linear.reconcile.stuck` is the **backlog
gauge** (count of `open`/unlinked `vendor_requests` past the stuck threshold; 0 on a clean run, so a
no-data monitor distinguishes "ran clean" from "didn't run"). `aeci.linear.reconcile.attempt`
(`outcome:cleared|still_failing`) and `aeci.linear.reconcile.persistent_failure` (still failing past
the persistent threshold) ride the same `source:reconcile` logs; the persistent-failure count + its
`level:error` log are **the alert signal** — the PostHog alert "Linear reconciliation: persistent stuck requests"
today, and `AECi — Linear reconcile: persistent stuck request` in
`observability/posthog/alerts.json` after the cutover (it stays a **separate** alert on merit:
the sweep is healthy, a user-visible vendor request is not).
`aeci.linear.reconcile.email` tracks the admin-alert seam (Resend transport, AECI-240; `outcome:sent|failed|skipped`,
`skipped` when the key/recipient are absent). The full Phase-6 **dashboard** + the pipeline-failure / HMAC / sweep-liveness monitors
land in **6.12** (AECI-219, below); AECI-214 shipped only the single stuck-row (persistent-failure)
monitor the §6.2 backstop required.

`aeci.email.send` (AECI-240, Phase 7.5) is the Resend transactional-email transport health metric —
one count per send attempt from `lib/email.ts`, `outcome` (`sent`/`failed`/`skipped`) × `template`. The
`template` vocabulary is the `EmailTemplate` union in `lib/email.ts` and has grown with every epic that
added a send; the catalog row above carries the current list, and `docs/email.md` is the prose mirror.
Like toxicity scoring, every send is **fail-open and fire-and-forget** (dispatched via `ctx.waitUntil`,
never blocks the triggering action), so the count is an *outage/triage-loss* signal, never user-facing.
`skipped` is the absent-config no-op (no `RESEND_API_KEY` / `EMAIL_FROM`, or an unresolved recipient — the
expected local/preview state), so it doesn't pollute the `failed` error-rate denominator. The
`stuck-request-alert` template is the same send the `aeci.linear.reconcile.email` seam metric also
records, so a reconcile alert increments both (one transport-level, one seam-level). See `docs/email.md`.

`aeci.linear.sync` / `aeci.linear.sync.duration_ms` (AECI-213, Phase 6.6) are the **outbound-resolution**
counterpart: one count per site→Linear `ctx.waitUntil` push when an admin resolves/rejects a request.
`outcome:ok` on a pushed state transition + comment + recorded `workflow_transition`; `outcome:skipped_no_issue`
when the request was never linked to a Linear issue (`linear_issue_id` null — nothing to push, a tolerated
no-op, not a failure); `outcome:failed` (with a `reason` tag) when the Linear `issueUpdate` or the transition
write fails. The `to_status` tag (`resolved` / `rejected`) splits the two terminal pushes. Same absent-key
silence as `aeci.linear.issue`. The dashboard widget + alert for this metric land with the Phase 6.12
observability issue (AECI-219).

`aeci.webhooks.linear.receipt` / `aeci.webhooks.linear.hmac_failure` (AECI-212, Phase 6.5) are the
**inbound** (Linear → Site) half of the sync. `POST /api/webhooks/linear` (`routes/webhooks.ts`)
HMAC-verifies the `Linear-Signature` header against `LINEAR_WEBHOOK_SIGNING_SECRET` and **fails closed**:
a missing/invalid signature emits `aeci.webhooks.linear.hmac_failure` and returns 401 **before** anything
is written. A verified request emits `aeci.webhooks.linear.receipt` tagged `type` (the Linear resource —
`Issue`) × `action` (`create` / `update` / `remove`); only `Issue`/`update` state changes drive a
`workflow_transition` + `vendor_requests.status` update, the rest are acknowledged no-ops. `…receipt` is
the throughput signal (and, paired against a sudden zero, the "secret rotated but not re-pushed → all
deliveries bouncing" tell); `…hmac_failure` is the security/mis-config signal behind the
`monitor-webhook-hmac-failure.json` alert. The full dashboard + alert land in 6.12 (AECI-219, below).

`aeci.moderation.ban` (count, `action:ban|unban` × `role:reviewer|vendor_admin` × `outcome:ok|invalid_state|forbidden`) **shipped with
AECI-218 / Phase 6.11** (the `role` tag added AECI-524 so a `vendor_admin`-seat ban is distinguishable): the reviewer-**ban management** write-path (`PATCH /api/admin/reviewers/:id`,
admin sets/clears `profiles.banned_at` + `ban_reason`) emits one count per ban/unban attempt via
`emitBanAction` in `apps/api/src/routes/admin-reviewers.ts`, alongside the §9 `appendAuditLog()` + the
reversible `reviewer_ban` `workflow_transition`. Phase 5 (AECI-197) only *enforces* an existing ban on
review submit; the *write* path is this Phase 6 handler (the ban *action* is raised from the moderation
queue's repeat-offender prompt — `docs/STAGE_1_PHASE_6_SPEC.md` §9). It rides the Phase 6 dashboard +
monitors shipped by AECI-219 / Phase 6.12, now the PostHog alerts in `observability/posthog/alerts.json`.

`aeci.waf.ratelimit.blocked` / `aeci.waf.poll` (AECI-262, §15.1) surface the Cloudflare WAF
rate-limit + scraper-challenge mitigations (`docs/waf-rate-limits.md`) as metrics. Enterprise
Logpush is the "push" path Cloudflare offers; we're on **Pro**, so the API Worker's hourly cron
(`runWafMetricsJob`) **polls** instead — it reads the previous clock hour of the zone's
`firewallEventsAdaptiveGroups` over the GraphQL Analytics API
(`packages/shared/src/cloudflare-analytics.ts`) and `submitCount`s one
`aeci.waf.ratelimit.blocked` point per mitigation group (`rule`/`action`/`host`/`source`). **Its
value is the event count, not 1, so query it with `sum:` / `sum:…{}.as_count()`** (Datadog gotcha 3);
only mitigation actions (block / challenge) are counted — `allow`/`log`/`skip` are dropped. A
quiet hour emits no blocked points (a count series is sparse — silence = no *mitigations*, which is
not the same as no attacks: an **uncovered host** reads identically, the AECI-659 failure mode —
see `docs/waf-rate-limits.md` §5), so
cron-liveness rides the **separate** always-emitted `aeci.waf.poll{outcome:ok}` heartbeat
(`outcome:failed` on a Cloudflare error, `outcome:skipped_no_creds` when `CF_ANALYTICS_API_TOKEN`
is absent — the local/preview/pre-provisioning state, a silent no-op). Same failure + liveness
split as Algolia/stats. The poll is **per-env host-scoped** (each env filters to its own
`PUBLIC_SITE_URL` host) because all envs share one Cloudflare zone — an unscoped query would
count the same zone-wide events under every `env:` tag. The "WAF rate-limit / challenge spike"
monitor alerts on a sustained `aeci.waf.ratelimit.blocked` spike (no `notify_no_data`); there is
no committed dashboard widget yet (this is a post-launch shim — add one if the signal proves
worth a panel).

**Review-app promote observability** (`POST /api/promote`, `docs/REVIEW_APP_PROMOTE_API.md`
§6.1–6.2) makes the **logs plane** the authoritative record of a promotion push's problems, so the
AECi operator diagnoses a failed push without the review app plumbing the HTTP response body
anywhere. The console is the PostHog Logs explorer; `service` is the OTLP resource attribute
`service.name` (`aeci-api` / `aeci-web`), and `trace_id` correlation works the same way it did
under Datadog.
The promote endpoint runs on its own Hono sub-router whose `errorHandler({ logClientErrors: true,
source: 'review-app-promote' })` (`apps/api/src/index.ts` / `apps/api/src/errors.ts`) logs **every**
rejection — not just the unknown-500 branch every other route logs — under `source:review-app-promote`:
one log per 4xx/409 (level `warn`) and 5xx (level `error`), carrying the HTTP status (as
`http_status` — the bare `status` attribute is reserved for the log level on **both** vendors), error `code`, `field`, full
`details` (the Zod `issues[]` for a `VALIDATION_FAILED`, the slug `target` for a
`SLUG_CONFLICT`), `path`/`method`, and the **same `trace_id`** returned in the response envelope
(so a caller-reported `trace_id` pivots straight to the log).

**Since AECI-563 that router only sees the kick-off.** The commit runs in the promote Workflow, so a
`SLUG_CONFLICT` or an unexpected fault during the ingest never passes through `errorHandler` and would
otherwise vanish from the logs. The Workflow logs it itself: an `error`-level
`aeci.api.promote.job_failed` under the same `source:review-app-promote`, carrying `job_id`, the error
`code`, and the reason — pivot on `job_id` rather than `trace_id` for those. Together with
`aeci.api.promote.job{outcome}` this keeps `REVIEW_APP_PROMOTE_API.md` §6.3's "every rejected promote
is logged" true across both surfaces — and, since AECI-642, across both vendors.

Separately, a **partial** promote — a job that reaches `complete` with a non-empty `skipped[]`, which
every outcome metric sees as a clean success — emits a `warn` log
`aeci.api.promote.partial_skipped` (detailing every `{ref, kind, reason}` + per-kind counts) plus the
`aeci.api.promote.skipped` count above, so a curator's silently-dropped entity is visible.

An absorbed commit **replay** (AECI-571) emits a `warn` `aeci.api.promote.replay_detected`
(`job_id`, `via`, the product id the replay is about to return) alongside the
`aeci.api.promote.replay` count above. Nothing is wrong when this fires — the ledger's primary key
rolled the duplicate batch back and the original IDs were returned — but it is the only direct
evidence that the Workflows at-least-once window occurred at all, so capture the `job_id`.

A third silent outcome (AECI-568): a `supabaseId` the caller sent whose row no longer exists. The
ingest now **creates** a replacement rather than issuing a no-op `UPDATE … WHERE id = <gone>` and
reporting it as `updated` with an empty slug, and each fallback emits a `warn`
`aeci.api.promote.stale_supabase_id` (every `{kind, ref, supabaseId}` + per-kind counts) plus the
`aeci.api.promote.stale_id` count above. The promote itself is correct either way — this is the signal
that the review app's copy of that id had gone stale, which is the same divergence
`scripts/ops/2026-08-promote-strand-audit/` sweeps for offline.

A fourth (AECI-730): an integration written **without** an optional link, because its
`poweredByProduct` / `builtByVendor` didn't resolve. This is not a skip — the row landed — so it
gets its own `info` log `aeci.api.promote.unresolved_link` (every `{ ref, field, supabaseId,
outcome }` + per-field counts) plus the `aeci.api.promote.unresolved_link` count above, and is
deliberately kept **out** of `aeci.api.promote.skipped`. The severity split is the point: Zapier
and Workato are parked permanently (AECI-700), so this fires on routine promotes forever, and a
permanent `warn` — or a permanently dirty `skipped` series — is exactly the noise an operator
learns to ignore. `outcome: 'preserved'` means the update left a stored FK alone rather than
nulling it (the clobber guard); `'unset'` means the row was created with the column NULL. The
offline counterpart is `scripts/ops/2026-08-powered-by-backfill/audit.mjs`, whose
`connectorUnpromoted` bucket is the same population.

All of it is fire-and-forget over the shared transports (each leg a no-op without its own config —
`POSTHOG_PROJECT_KEY`, `DD_API_KEY`) and never affects the response. **Fire-and-forget is not
fire-and-ignore:** until AECI-666 the tail could exhaust the invocation's connection budget and lose
every hook silently, so each is now dispatched behind a 20s watchdog and the audit forwards go as one
batched request per vendor (ADR 0021's 2026-08-27 amendment). This is deliberately scoped to
promote — the high-traffic public read endpoints stay silent on 4xx to keep log volume down.

For a `500` (an unhandled throw — e.g. a `db.batch` rejection in promote), the log now also carries a
`cause` attribute: the flattened `err.cause` chain. D1/SQLite put the real reason
(`SQLITE_CONSTRAINT: UNIQUE constraint failed …`, a failing statement, "too many SQL variables") one
link down in `err.cause`, which the bare `err.message` drops — so before this the 500 logged as a
generic "D1_ERROR" with no diagnosable detail (`apps/api/src/errors.ts` → `causeChain`). The same
`cause` is written to the Cloudflare Workers-Observability `console.error`, so `wrangler tail
aeci-api-production` surfaces it live before either telemetry console is consulted.

## Troubleshooting: the key is set but nothing arrives

The transport swallows its own failures by design, so "the key is set and nothing
arrives" is the normal shape of a misconfiguration. The triage below was originally
written against the Datadog intake, where the failure mode was discovered; it
applies unchanged to PostHog, which is now the only intake.

### `POSTHOG_PROJECT_KEY` is set but nothing appears in PostHog

**Same failure mode, same guard — carried over on purpose.** An intake `fetch`
*resolves* on 4xx/5xx, so a throw-only `catch` never fires and a rejected token
drops every log and metric with no indication at all. `packages/shared/src/posthog.ts`
checks `res.ok` and, on a non-2xx, emits `console.warn('<label>: intake rejected
<status>', <body snippet>)` — still swallowed, because observability must never
break the request path.

```bash
wrangler tail aeci-api-production --format pretty
# then look for one of:
#   logToPosthog: intake rejected 401
#   submitCount / submitGauge / submitDistribution: intake rejected 401
#   captureEvent / captureException: flush failed
```

What each status means here:

- **`401`** — the `phc_` token is wrong for the project, **or** it was passed as
  `?api_key=` instead of the `Authorization: Bearer` header. The Bearer header is
  mandatory on both OTLP intakes (see "Pipes"). Fix the `POSTHOG_PROJECT_KEY`
  wrangler `var` — it is a committed var, not a secret, so the fix is a code change
  and a deploy, not a `wrangler secret put`.
- **`404`** — almost always the host split (`us.posthog.com`, the **management**
  API, in place of `us.i.posthog.com`, the **ingest** host), or a `/i/v1/e/` path
  that does not exist. Both 404s read exactly like a config problem.
- **`403` / `413`** — a project quota/plan drop, or a payload over the limit.
- **No `intake rejected` and no `forward failed` line at all** — the intake accepted
  it and the gap is PostHog-side. Broaden the query: filter on the OTLP **resource**
  attribute `service.name` (`aeci-api` / `aeci-web`), not `service` — the Logs
  explorer's service filter reads only the dotted key, so a project full of correct
  logs can look empty.
- **Nothing at all, not even a warn** — check whether the transport no-opped:
  `POSTHOG_PROJECT_KEY` absent is a **total** no-op by design (invariant 3), which
  is the correct behaviour locally and on a keyless preview and is indistinguishable
  from a broken pipe if you are not expecting it.

### A third silent-loss mode: the invocation ran out of connections

Both symptoms above assume the `fetch` *settled*. There is a third failure in which it
never does. Until AECI-666 the transports left their **success-path response body
unread**. Each unread body holds an open connection; a Worker invocation may hold only
a bounded number of those (and the dual-run spends two per emission); past the limit
the runtime cancels the stalled responses — into `fetch` promises that **never
settle**, so neither the `res.ok` check nor the `catch` above ever runs. Nothing is
logged at all, and if the invocation is still waiting when the event loop empties it
is killed outright.

The tell is not a vendor symptom. It is a burst of Cloudflare runtime warnings:

```bash
# Any hit here means some caller is opening more connections than it releases.
wrangler tail aeci-api-production --format pretty | grep -i "stalled HTTP response"

# Often followed by, on the same invocation:
#   "your Worker's code had hung and would never generate a response"
```

Both transports now release every body, and both expose a batched sender so a caller
with N related lines — the promote's §26.5 audit forwards — costs one request per
vendor instead of N. A promote hook that stays unsettled for 20s is additionally
abandoned with `promote hook "<name>" did not settle within 20000ms`, which is the
signal that was missing entirely while this ran undetected.

One PostHog-only trap worth naming separately: `captureEvent` / `captureException`
go through `posthog-node`, which **batches**. Their failures surface as
`<label>: flush failed`, not `intake rejected`, and a missing event may simply mean
the flush never happened — which is exactly what `captureImmediate` /
`captureExceptionImmediate` cause, and why they are banned (see the gotchas below).

## Gotchas when querying

### PostHog (the plane you are migrating to)

1. **Build the client per request, and flush through `waitUntil` — never
   `*Immediate`.** `posthog-node` is constructed per call with `flushAt: 1`,
   `flushInterval: 0`, `fetchRetryCount: 0`, `disableGeoip: true`, and flushed via
   `ctx.waitUntil(client.flush())`. `captureImmediate` /
   `captureExceptionImmediate` resolve **before** the network send finishes: the
   isolate tears down mid-flight and the event vanishes. This is the single most
   expensive mistake available in the transport file, and the file says so at the
   call site.
2. **The 1,000-series budget is real, and tag cost is multiplicative.** ≈854 series
   at steady state, ≈1,708 during a deploy overlap. The arithmetic and the standing
   rule are under "Cardinality budget" above — **no new tag without redoing it.**
3. **PostHog Metrics is alpha.** The insight builder is unsettled and there is no
   read tool, so every insight here is a **HogQL query over `posthog.metrics`**
   rather than a UI-built chart. That is a deliberate choice: the underlying table
   is stable SQL even while the product above it is not.
4. **Two projects, not one `env` filter.** Production is `aec-integrations`
   (**354071**); preview, staging, demo and stage2 all share `aec-integrations-dev`
   (**525793**). Queries carry **no `env:` predicate** — the project *is* the tier
   boundary. Adding one would be belt-and-braces with a real downside: if the
   transport ever tagged `env` differently, every alert would read 0 forever and
   nothing would fail. If a tier is mis-routed (as demo was, pre-AECI-640), fix the
   routing, not the queries. Note that prod events from **before** AECI-640 carry
   mixed tiers — filter by `$host` when reading history.
5. **`us.posthog.com` is management; `us.i.posthog.com` is ingest.** Trivially easy
   to swap, and the failure is a 404 that never mentions the host.
6. **PostHog does NOT lowercase tag values. Datadog did.** `cache_status` is emitted
   as the literal `MISS` (`apps/web/src/server-runtime.ts`), so a predicate copied
   from a Datadog query as `cache_status:miss` **matches nothing and looks healthy**.
   Every committed query wraps such comparisons in `lower()`. `status_class` is
   already lowercase in source but is wrapped too, because the cost is nil and the
   failure is invisible.
7. **An empty stack is not automatically a source-map problem.** A `$exception` with
   "no stacktrace" is more often an error thrown without one, or a rejection carrying
   a non-`Error` value, than a missing upload. Check that the chunk shows `Uploaded`
   under Symbol sets before assuming the map pipeline broke.
8. **CSP `connect-src` must list both PostHog hosts** — `https://us.i.posthog.com`
   (ingest) **and** `https://us-assets.i.posthog.com` (remote config). The region is
   pinned to US: an EU switch is a code change in `server/seo-headers.ts` as well as
   `POSTHOG_HOST`.
9. **HogQL table namespacing is asymmetric.** `logs` is at the ROOT; metrics and
   spans need the prefix (`posthog.metrics`, `posthog.trace_spans`). A bare
   `FROM metrics` errors with "Unknown table".
10. **There is no `aggregation_temporality` filter, on purpose.** Counters and
    histograms are DELTA by construction and gauges carry none at all, so
    `sum(value)` is correct without the predicate — and a predicate whose literal
    casing is wrong would silently zero every counter alert.
11. **The remote-config gate** — the newest and least-guessable one. See its own
    section below.

### The remote-config gate — a server-side switch the client cannot override

> **Dated correction — 2026-08-26, re-fetched live.** **The toggles have since been turned
> on.** Both projects now return `capturePerformance.web_vitals: true` and
> `errorTracking.autocaptureExceptions: true`, and **both** return a full `sessionRecording`
> config object. The mechanism described below is unchanged and still the thing to know —
> remote config overrides the client — but three of its conclusions are now historical:
>
> - `$web_vitals` **is no longer blocked**; it fires on every tier, non-prod included. Consequence 1 below is stale.
> - Exception **autocapture** is on for both projects, so `$exception` now also arrives from the window-level path. (Consequence 2 — that *manual* capture was never gated — still holds and is still why the error path worked throughout.)
> - `sessionRecording` is **no longer a project-level confirmation of D5**. Replay is enabled at the project level on **both** projects; the only thing keeping it off is `disable_session_recording: true` in `posthog-client.ts`, on every tier. The closing sentence of this section is wrong as written.
>
> `heatmaps` still differs (prod `true`, non-prod `false`). Full table + consequences:
> `docs/POSTHOG_MIGRATION_SPEC.md` §8.8 addendum.


Found during the live verification pass and **not anticipated anywhere in the
migration spec's §2–§3** (recorded as §8.8). On init, `posthog-js` fetches
`https://us-assets.i.posthog.com/array/{phc_token}/config`, and **that response
overrides client-side config for the two operational signals.** For the non-prod
project it currently returns:

```json
{ "capturePerformance": { "network_timing": true, "web_vitals": false, … },
  "autocaptureExceptions": false,
  "errorTracking": { "autocaptureExceptions": false, … },
  "sessionRecording": false,
  "analytics": { "endpoint": "/i/v0/e/" } }
```

So setting `capture_performance: { web_vitals: true }` in `posthog.init()` is
**necessary but not sufficient** — `$web_vitals` does not fire until web vitals is
enabled in the **project settings**. The same is true of exception autocapture.
Both are operator toggles, not code, and both are needed on **both** projects.

Two consequences worth stating plainly:

1. **A missing `$web_vitals` is this toggle, not the client config.** The toggle was
   flipped on 2026-08-26 and web vitals are live on every tier. If they ever go
   quiet, check the project setting before touching code — and note there is no
   longer a Datadog RUM fallback carrying field Core Web Vitals.
2. **Manual capture is NOT gated.** `posthog.captureException(...)` — the path
   `PosthogErrorHandler` uses, and the load-bearing one, since Angular swallows
   application errors before `window.onerror` — delivers `$exception` events even
   while `autocaptureExceptions` is false. Verified live. What project-level error
   tracking gates is the **issue grouping / Error Tracking product**, not ingestion.
   So the browser error path works today; it just has no console to read it in until
   the toggle is flipped.

~~`sessionRecording: false` in that response is a useful independent confirmation of
D5 — replay is off at the project level as well as in the client config.~~
**No longer true as of 2026-08-26** — see the dated correction at the top of this
section. Replay is enabled at the project level on both projects; D5 is held by the
client alone, everywhere.

## Known coverage limitation (`aeci.page.render.duration_ms`)

The `aeci.page.render.duration_ms` **distribution** is emitted only for **cacheable** routes
(which is exactly where `route_class` ∈ {detail, index, browse} is defined). The non-cacheable
branch — the `**` 404 wildcard and non-GET requests — has no `route_class` and is intentionally
excluded from that histogram. Those requests are covered by the `aeci.ssr.render` **count**
metric (`cache_status:non_cacheable`), which fires on every branch. API-side requests (including
404s) are fully covered by `aeci.api.query.duration_ms`, so the error-rate widget/monitor still
see API errors.

## The `ssr.render` log is a gated smoke signal (AECI-103)

AECI-31 emitted an `ssr.render` structured **log** on every render to prove the
API↔Worker↔logs pipe end-to-end. At production traffic that is one log line per page
render — unbounded ingest volume and cost, now on **two** intakes. The per-render volume signal
lives in the bounded `aeci.ssr.render` count metric above, so the log is demoted to a smoke
signal, gated by `shouldEmitRenderLog` — which AECI-642 moved to the vendor-neutral
`apps/web/src/server-render-log.ts`, because it is **policy, not transport**, and both legs must
gate identically:

- errors (`status >= 400`) are logged in **every** env — full fidelity,
- **all** renders are logged in non-prod (`ENV` ≠ `production`) — dev volume is tiny and useful
  for verifying the pipe,
- prod `2xx` renders are **not** logged — the count metric carries that signal.

The gate is deterministic (no log sampling): a count metric, not a log sample, is the bounded
prod heartbeat. No committed dashboard widget or monitor queries the `ssr.render` log, so this
change skews nothing — the only log-shaped monitor query targets `status:error` logs, which the
gate keeps at full fidelity.

## Front-of-Worker cache: HIT observability (WC-8 / AECI-322)

Native Workers Cache (WC-3) serves cacheable HITs **without running the SSR Worker**, so
egress-time signals that used to re-run on every response don't fire on a HIT. This is by
design. Where each signal lives now:

- **HIT/MISS + edge HIT-rate** → the **`Cf-Cache-Status`** response header
  (`HIT`/`MISS`/`EXPIRED`/`BYPASS`/`DYNAMIC`) and the **Cloudflare Workers observability
  dashboard** (Workers & Pages → `aeci-web` → Observability). **Neither vendor** has a HIT-rate series
  anymore: the `cache_status:hit` numerator went to ~0 when the Worker stopped running on HITs, so
  the `cache hit rate < 70%` monitor **and** its Traffic-dashboard widget were **retired** in WC-8
  (they would otherwise alert / flatline forever). Wrangler/Miniflare is a confirmed local no-op
  for this front cache (no `Cf-Cache-Status`/`Age`); `e2e/edge-cache.spec.ts` verifies exact
  `MISS → HIT` after each first-party PR-preview deploy (ADR 0020 Q3 / WC-9).
- **SSR render metrics** (`aeci.ssr.render`, `aeci.page.render.duration_ms`) → still emitted, but
  only on the branch where **the Worker actually runs** (a native-cache MISS / non-cacheable) —
  `cache_status:MISS`/`miss`/`non_cacheable`, never `hit`. A fall in MISS volume as HIT-rate climbs
  is **expected** and is **not** "SSR render dropped" / "traffic dropped"; read absolute request
  volume from Cloudflare, not these Worker-side counts.
- **Page views** → the browser `PageViewTracker` (AECI-151,
  `apps/web/src/app/core/page-view-tracker.ts`) is the **canonical** counter. The SSR-side
  `firePageView` (`POST /api/page-views`) fires only on a MISS / non-cacheable render and always
  undercounted; a HIT never reaches the Worker, so it is deliberately **not** reconstructed from
  HITs. Do not add HIT-counting to the Worker.
- **`noindex` on HIT** → the crawler-indexing header is baked into the cached payload on the MISS
  render (`docs/CACHE_STRATEGY.md` §7.1), so every HIT serves it without the Worker running.

## Dashboards

**Seven PostHog dashboards, 43 insights.** They are applied from
`observability/posthog/insights.json` via `apply.sh`. Datadog's five boards were
deleted with the rest of the plane at AECI-651.

> **Operator step still outstanding:** the boards are applied to the **non-production**
> project; running `apply.sh` against the production project (354071) is a manual step.
> Until it runs, production dashboards are empty — and there is no longer a Datadog
> board to read instead.

### PostHog — 7 dashboards, 43 insights (AECI-647 / §AW6)

**Source of truth: `observability/posthog/`.** Query text and thresholds live in
that directory as JSON, the same way the retired `observability/datadog/` held them — do not
duplicate either here, or the two will drift and the doc will lose.

| File | What it is |
|---|---|
| `observability/posthog/README.md` | The **26-row monitor disposition table** (every Datadog monitor → its new home, with its retired threshold), the AW6 judgement calls, the migration hazards, the drill record, the numbered manual steps and the operator checklist. `docs/RUNBOOKS.md` carries the disposition table as well, for the on-call reader. |
| `observability/posthog/project-config.json` | Project topology, alert subscribers, and the **thirteen-cron liveness registry** the CI sweep reads. |
| `observability/posthog/insights.json` | 7 dashboards, 43 insights (30 board + 13 alert-source), as data. |
| `observability/posthog/alerts.json` | 13 alerts, each naming its source insight and carrying the **retired Datadog query verbatim**. |
| `observability/posthog/apply.sh` | The applier. `--dry-run` / `--verify`; dashboards + insights to **both** projects, alerts to **prod only**. |

**Every insight is a HogQL query over `posthog.metrics`** (or, for the two re-homed
browser search widgets, over `events`) rather than a Metrics-UI chart — see gotcha
3 above. Alert-source insights are aggregates with **no `GROUP BY`**, so they always
return exactly one row and a healthy-but-empty window evaluates to `0` rather than
to "no rows", which is the shape that makes a threshold alert safe.

**Live dashboards (non-production, project 525793):**
<https://us.posthog.com/project/525793/dashboard> — Traffic `2025785`, Search
`2025786`, Home/Stats `2025787`, Auth/Reviews/Moderation `2025788`,
Requests/Linear `2025789`, Cron health `2025790`, Alert signal sources `2025791`
(43 insights, ids `11280545`–`11280671`; no alerts exist in 525793 by design).

**Production (354071) is not yet applied** — it needs the `phx_` personal key,
which is still an outstanding operator step. Paste the production dashboard URLs
here after the first prod `apply.sh` run (spec §7).

**What is verified and what is not.** All 43 queries compile and execute; all 13
alert-source queries return exactly one row on an empty table; the
dashboard → insight → alert chain was probed end to end and then deleted. But
**every query returns zero rows today** — `posthog.metrics` was empty on both
projects when AECI-647 landed. Correct *shape* is proven; correct *numbers* are
not, and the histogram-p95 reconstruction in particular has never seen a real
histogram. That spot-check is the reason the dual-run window exists
(`observability/posthog/README.md` manual step 2).

## Alerts

Two alert sets, only one of which is armed on production.

| | Datadog monitors | PostHog alerts |
|---|---|---|
| Count | **26**, all applied and live | **13**, covering 16 of those 26 |
| Applied to | production (and `env`-scoped where relevant) | **non-production dashboards only**; alerts are prod-only and unapplied pending the `phx_` key |
| Cadence | 5 min – 1 day, per monitor | **hourly**, uniformly (`every_15_minutes` needs the Boost add-on; `real_time` needs Scale/Enterprise) |
| Absence detection | `notify_no_data`, 8 monitors | **none** — moved out of the vendor entirely, to the CI liveness sweep |
| Delivery | email to `@chrisw@thewbsproject.com` | email `subscribed_users` (no Slack/webhook wired — deliberate; AECi has no Slack) |
| Pages today? | **Yes** | No |

The full **26-row disposition** — every Datadog monitor, its old threshold, and
where it landed — is in `observability/posthog/README.md` and is reproduced for
on-call in [`RUNBOOKS.md`](./RUNBOOKS.md). The headline split: **13 alerts covering
16 monitors · 8 → the liveness sweep · 2 → the existing daily digests · 2 dual
monitors split across both.** 26 accounted for, none dropped.

Three things changed in the port and are worth knowing **before** reading a number:

- **Cadence is hourly.** Four Datadog monitors evaluated at 5–15 minutes. The
  Worker error-rate alert (5 min → 1 h) is the **largest single degradation in the
  migration**, and it is a deliberate cost, not an oversight. If it bites, PostHog's
  *other* alert type (`POST /api/projects/:id/logs/alerts/`) supports 5/10/15/30/60-minute
  windows without the Boost add-on — the upgrade path is written up as manual step 4
  in `observability/posthog/README.md`.
- **Ratio alerts gained minimum-denominator floors** (5 / 5 / 20 / 3 samples),
  implemented as `if(total >= N, ratio, 0.0)`. New and deliberate: at AECi's current
  volume one failed sign-in out of two is 50% and would page. Datadog's shorter
  windows had the same exposure and simply got lucky.
- **The WAF threshold was rescaled** 500/15 min → 2,000/1 h. Same sensitivity: the
  source is an hourly cron reading a whole clock hour in one shot, so the 15-minute
  window was always coarser than it looked.

**Four cron-failure monitors combined into one alert.** Algolia sync failed, home
stats compute failed, data quality job failed and retention prune failed become
`AECi — Cron job failed (any daily/hourly job)`. Combining is normally a loss — you
learn *something* broke but not *what* — except that PostHog's `HogQLAlertConfig`
has a **`label_column`**, and the query returns the failing metric names in it, so
**the breach email says which jobs failed.** Same information, one notification, one
place to tune. It also widens coverage twice over: six previously-unwatched crons
gain failure coverage, and the `trigger:cron` predicate is dropped so a
promote-path failure counts as the real failure it is. Five monitors stayed separate
on merit (data-quality ERROR severity, retention-prune runaway, reconcile persistent
stuck, orphan-sweep capped, webhook HMAC) because each is a different runbook —
"the job succeeded but the DATA is wrong" and "the job failed" are not the same page
at 3am.

### Absence detection moved out of the vendor entirely

**No PostHog tier has `notify_no_data`.** All eight absence monitors are replaced by
**`.github/workflows/posthog-liveness-sweep.yml`** (logic in
`scripts/ci/posthog-liveness-sweep.sh`), a scheduled GitHub Actions job that queries
the production project for a per-cron heartbeat **every 3 hours** and **fails red**.

It runs outside the Worker on purpose — that is the property that made "Datadog owns
absence" true, and a liveness check hosted inside the API Worker cannot detect the
API Worker being dead. **Do not add `continue-on-error` to it.** Every other
telemetry step in this repo is best-effort (`posthog-deploy-marker.sh` always exits
0), so the surrounding convention points the other way; the correct precedent is
`.github/workflows/reconcile-counts.yml`.

Exit codes are deliberately three-valued: **0** = all thirteen heartbeats fresh; **1**
= a heartbeat is MISSING or STALE (with a GitHub `::error::` annotation naming the
cron and its allowance); **2** = the sweep could not run at all (PostHog 5xx, or no
`POSTHOG_CLI_API_KEY`) and reports "UNCHECKED, not healthy". **"The sweep could not
run" is not "the crons are fine"** — both are red, and the annotations say which.
All five paths were drilled against a stub speaking the verbatim PostHog query
envelope before the workflow shipped.

**New dependency, stated rather than discovered: absence detection now depends on
GitHub Actions availability,** which Datadog's server-side `notify_no_data` did not.
The per-cron windows in `project-config.json` carry margin for the sweep's own
lateness (26 h for daily jobs, 90 min for the 15-minute reconcile). `job_runs`,
`/admin/system` and the two daily digest emails remain an independent second record.

## Browser search telemetry (`search_performed`)

Search is queried **client-side**, direct to Algolia with the search-only key
injected as `window.__AECI_ALGOLIA__` (`apps/web/src/algolia-bootstrap-inject.ts`),
so its latency and error rate were never a Worker metric. From AECI-174 they were a
Datadog **RUM** action, `aeci.search.query`. AECI-643 re-homed `status` /
`duration_ms` / `results_bucket` onto the **`search_performed` PostHog event**
(including a `status: 'error'` row, without which the search error rate would be
unrecoverable), and **AECI-651 deleted the RUM action and its two Phase-3 dashboard
widgets**. The event is now the only carrier.

Property contract, emit sites and the naming rules live in
[`ANALYTICS.md`](./ANALYTICS.md) §4; the payload type is `SearchPerformedEvent` in
`apps/web/src/app/search/search-controller.ts`, and the shared vocabulary
(`SearchStatus`, `ResultsBucket`, `resultsBucket()`) is
`apps/web/src/app/search/search-telemetry.ts`.

### What the swap changed about the numbers

> **The server side now reads PostHog back (AECI-660).** For months this was write-only:
> AECI-239 shipped the instrumentation and nothing consumed it, so the daily digest reported one
> number with no second opinion. `apps/api/src/lib/posthog-query.ts` closes that loop — the 05:00
> digest runs one HogQL query for the reported UTC day, scoped to the env's own `$host`, and prints
> the result **beside** the D1 figure.
>
> The pair matters because the two sources fail in opposite directions. `page_views` is written
> server-side on every full-document load including cache hits, so a crawler that never runs
> JavaScript still counts: an **upper bound**. (Since AECI-741 that raw figure is no longer the
> email's headline — the headline is the count remaining after the automation filter, and it sits
> *between* this upper bound and the PostHog floor.) PostHog fires only when JS runs *and* the visitor
> consented, so a real person who declines is invisible: a **lower bound**. On 2026-08-23 the digest
> said "48 human views"; PostHog saw **5 pageviews from 1 person**, and those five were the operator's
> own session, which the digest had already excluded.
>
> **One population per email (AECI-747).** The headline is `raw − flagged`, and since AECI-747 the
> "Most viewed products" and "Traffic sources" tables exclude the SAME flagged clients — the
> `AutomationExclusion` the cron hands `collectAnalyticsMetrics`. Before that the email led with a
> filtered number over unfiltered rows, and on 2026-08-30 showed a bot-driven page as the day's top
> product. The exclusion predicate is the exact complement of `swarm-detection.ts`'s
> `countFlaggedViews`, and is NULL-safe on purpose: a row with a null UA hash AND a null ASN counts
> in the headline, so it must survive the tables too.
>
> **Three axes since AECI-744**, not two: the exclusion carries `verdicts` alongside `uaHashes` and
> `asns`, because `client_verdict IN ('inconsistent','non-browser')` now flags a row on its own with
> no view floor. It is passed unconditionally — the union count always includes the verdict matcher,
> so the complement must too — and it repeats the same NULL-safe `IS NULL OR NOT IN` shape, because
> every row written before 2026-08-26 has a NULL verdict and counts in the headline. **The admin panel still passes no exclusion**,
> so `/admin/overview` top-products remain unfiltered — a known parity gap, not a second definition.
>
> Pure transport, like `cloudflare-analytics.ts`: it never throws, and every failure path returns a
> structured `{ ok: false, reason }` that the email renders as "unavailable". It must **never** report
> a `0` on failure — a fabricated zero beside a real count reads as a finding rather than as missing
> data, which is the specific way this kind of pairing goes wrong. Needs `POSTHOG_QUERY_API_KEY`
> (a **personal** `phx_` key scoped to `query:read`, API Worker only) + `POSTHOG_PROJECT_ID`; absent,
> the digest is byte-identical to what it sent before, plus one note. Outcomes are recorded in the
> `job_runs` detail (`posthogPageViews` / `posthogPeople` / `posthogSkipped`) so a join that silently
> stops running is visible without diffing emails.

**How it loads (cache-neutral, opt-in).** The SSR Worker inlines the public config as
`window.__AECI_POSTHOG__ = {key, host}` before `</head>` (`posthog-bootstrap-inject.ts`)
— deployment-env-only, so it's safe to cache (§9.1a). In the browser, the `Analytics`
service loads `posthog-js` (dynamic import) and calls `posthog.init()` **only after the
visitor accepts the consent banner** (`consent-banner.ts`); Do-Not-Track is honored as a
hard decline (no load, no banner). Init uses `capture_pageview: 'history_change'` (auto
pageviews incl. SPA navigations), `autocapture: false`, and
`disable_external_dependency_loading: true` (so the CSP `script-src` stays untouched —
only the two `connect-src` PostHog US hosts are needed).

Three differences are permanent and are the reason a pre-AECI-651 search chart does
not line up with a post- one:

1. **Consent.** The RUM action was consent-independent and saw *every* search;
   `search_performed` is Tier 3 and sees the **consented slice only**. Search volume
   read from PostHog is a funnel, not a census. `docs/ANALYTICS.md` §5 is the general
   statement of this rule; this is the one place the migration changed what a number
   *means* rather than where it lives.
2. **One event per search, not per index.** RUM emitted once per index. The event
   fires once per search and carries `results_products` / `results_vendors`, which
   answer the question RUM's `index` dimension answered ("which entity type did this
   query find?") without turning one search into two events (spec §8.10). Residual:
   `duration_ms` is the root (products) index's `processingTimeMS` rather than
   per-index, and RUM's `integrations` value has no successor — `/search` never
   queried that index.
3. **The header autocomplete is no longer measured at all.** It had no PostHog emit,
   only the RUM one, so deleting the RUM leg left it dark. Tracked as a follow-up;
   see the "Known limitations" section.

Two re-homed insights exist on the PostHog Search dashboard, sourced from `events`
rather than `posthog.metrics`.

## The browser plane (AECI-239 → AECI-643)

**The product-event catalogue is not here.** It lives in
[`ANALYTICS.md`](./ANALYTICS.md) §4, with the naming rules, the privacy rules, the
activation funnel, identity/groups and feature flags. This section covers only the
*operational* half of the browser plane — the part that answers "is it healthy" —
and the loading mechanism both halves share.

**Three tiers, one client** (spec §3.3 / decision D2, implemented in AECI-643):

| Tier | Runs for | Carries | Persistence | Consent |
|---|---|---|---|---|
| **1 — server** | always | Worker logs, all metrics, §26.5 audit forwards, cron heartbeats, promote-job events, deploy markers | n/a | no concept of it |
| **2 — browser operational** | **every visitor, DNT/GPC included** | `$exception`, `$web_vitals`, `app_started` | **memory only** — no identifier, no localStorage, no cookie | not gated |
| **3 — product analytics** | consented visitors only | `$pageview` + the event catalogue, `identify`, groups | localStorage | banner-gated; DNT/GPC are a hard deny |

Tier 2 is the direct replacement for the consent-independent Datadog RUM it retired,
and that equivalence is the whole justification for running it un-gated: it is
operational telemetry with no identifier attached, which is opt-out-exempt in normal
practice, and it is disclosed in the privacy policy. Tier 3 **upgrades the same
client in place** on consent, so the anonymous id and queued state carry across
rather than being re-minted.

Two operational consequences of Tier 2's anonymity, both accepted:

- **Error counts are occurrence counts, not affected-visitor counts.** Each page
  load gets a fresh anonymous id because nothing persistent is written. There is no
  "3 users hit this" number pre-consent and there will not be one.
- **`respect_dnt` is deliberately `false`, and that is not a loosening.** Verified
  against `posthog-js` source: with `respect_dnt: true` a DNT browser resolves to
  DENIED → `isOptedOut` → `capture()` returns early, which drops **every** event on
  the instance including `$exception` and `$web_vitals` — exactly what D2 forbids.
  DNT/GPC gating lives in `consent.ts`, where it governs the product slice only.
  Do not set it back.

**`PosthogErrorHandler` is the load-bearing piece,** not `capture_exceptions`.
Angular swallows application errors before `window.onerror`, so autocapture alone
reports almost no application errors; the Angular `ErrorHandler` → `captureException`
path is what actually delivers them (and it still `console.error`s). It is also the
path that is **not** blocked by the remote-config gate — see that section above.

**The self-contained bundle is deliberate.** `posthog-js/dist/module.full.no-external`
is imported rather than the default ESM entry, because the default lazy-loads
web-vitals and the exception-autocapture wrappers from PostHog's CDN — which
`disable_external_dependency_loading: true` refuses and `script-src` would block
anyway, so `$web_vitals` would simply never fire. The alternative was opening
`script-src` to a third-party origin, overturning AECI-239's documented decision to
keep it closed. Measured cost on a real production build: 61,450 B → 131,483 B
brotli on a **post-hydration lazy chunk**; the initial bundle total is unchanged.
Reversible in one import line.

**How it loads (cache-neutral).** The SSR Worker inlines the public config as
`window.__AECI_POSTHOG__ = {key, host}` before `</head>`
(`posthog-bootstrap-inject.ts`) — deployment-env-only, so the response stays
visitor-state-neutral and safe to cache (§9.1a). **This injection stays** and is the
one place AECi deliberately diverges from the sibling repo's migration (§3.2 / O2):
AECi promotes **one build by SHA** across staging → demo → prod, so the artifact
carries no tier knowledge — only the Worker does. A committed per-tier constant in
the bundle would be wrong on two of the three tiers. `__AECI_DD__` is injected the
same way and is deleted at AECI-651; `__AECI_POSTHOG__` is not.

**Dimensions on every event.** `locale` + `theme` ride everything, registered as
super-properties in the `loaded` callback before anything is captured. `theme` is
always `light` today (dark removed in AECI-226) but the dimension is still emitted so
the schema is stable when dark returns.

**Region is pinned to US.** `POSTHOG_HOST` defaults to `https://us.i.posthog.com`;
the static CSP `connect-src` allowlists `us.i.posthog.com` + `us-assets.i.posthog.com`.
Switching to EU is a code change — the host default **and** the two CSP hosts, since
the CSP is static and cannot read per-env config.

**Session replay is off** (D5), in the client config *and* at the project level.
Enabling it is a separate privacy review, not part of this migration.

## Credentials

`docs/environments.md` is the authoritative secret matrix; this table is the
observability-shaped view of it.

### PostHog

| Credential | Used by | Where it lives | Notes |
|---|---|---|---|
| **PostHog Worker secrets (emit path)** | — | **nowhere. There are none.** | **Read this row rather than skipping it — the absence is a design property, not an omission.** All three PostHog intakes (OTLP logs, OTLP metrics, event capture) authenticate with the publishable `phc_` project token, so Worker telemetry secrets went **4 → 0** with the migration. The READ path is the exception: `POSTHOG_QUERY_API_KEY` (a `phx_` personal key) IS an API-Worker secret, held for the AECI-660 digest join — emitting telemetry needs no credential, querying it back does. Beyond that, a Worker-side PostHog personal key is a design change, not a provisioning step. |
| `POSTHOG_PROJECT_KEY` | Worker runtime (logs + metrics + events) **and** the browser | **Committed per-env `vars` entry in both `apps/web/wrangler.jsonc` and `apps/api/wrangler.jsonc`** | Publishable `phc_` token. Was the CI-pushed secret `POSTHOG_KEY`; AECI-640 made it a committed var. Treating it as a secret bought nothing — the SSR Worker renders it into the served HTML on every page — and cost the weeks-dark prod analytics of AECI-326, where the push step ran, the secret was absent, and the warn-and-skip said so only in a log nobody read. A committed var has **no provisioning step to forget**, and PR previews get telemetry for free. Per-tier value follows the D4 topology: preview/staging/demo/stage2 → `aec-integrations-dev` (**525793**), production only → `aec-integrations` (**354071**). Absent → the whole transport no-ops (invariant 3). |
| `POSTHOG_HOST` | both Workers + the browser | Wrangler `vars`, per env | `https://us.i.posthog.com` — the **ingest** host. `us.posthog.com` (no `.i`) is the management API used by annotations and `apply.sh`; swapping them yields a confusing 404, which is why the marker script carries two separate host variables. Defaulted in code when unset. |
| `POSTHOG_CLI_API_KEY` | **CI + operator only** — source-map upload, the deploy-marker annotation leg, `apply.sh`, the liveness sweep | GitHub secret + operator keychain. **Never a Worker secret** — a personal key reaches the whole org | Personal `phx_` key. **One key needs the union of scopes**: insight write · dashboard write · alert write · project read · **query read** (the sweep) · **error tracking write** · **organization read** (the last two are source-map upload, §8.3 — §7's original list missed them). Optional + fail-open everywhere: absent, source maps are still *deleted* before deploy (the safety property survives), the marker's queryable `deployment` event still ships on the publishable token, and the liveness sweep exits **2** — "unchecked", which is not a pass. `apply.sh` also reads it as `POSTHOG_PERSONAL_API_KEY`; it cannot read the GitHub secret. **Currently not provisioned** (§8.7). |
| `POSTHOG_PROJECT_ID_PROD` / `_NONPROD` | CI (marker annotation, liveness sweep, `apply.sh`) | Repo **variables** | `354071` / `525793`. **Not set** — the workflows fall back to those literals, so this is a repoint convenience rather than a prerequisite. |
| `POSTHOG_KEY_STAGING` / `POSTHOG_KEY_PRODUCTION` | — | GitHub secrets | **Now unused.** Deleting them is an operator step (§8.7). |

**Why there is no browser-specific credential row.** There isn't a second token:
the browser and both Workers use the same publishable `POSTHOG_PROJECT_KEY`, which
is why the SSR bootstrap injection (§3.2) can hand it to the client directly.

## Deploy markers

Every deploy path emits a best-effort PostHog marker. It cannot fail a deploy:
`scripts/ci/posthog-deploy-marker.sh` always exits 0 and every skip prints a GitHub
`::warning::` that lands on the job page rather than only in the log body — the
AECI-326 failure mode in reverse. (A second, Datadog `/api/v1/events` marker fired
alongside it until AECI-651 deleted it.)

The PostHog marker has **two legs, and one of them works without any operator step**
(§8.6):

| Leg | What it is | Auth | Works today? |
|---|---|---|---|
| Project **annotation** | the vertical line PostHog draws across every insight — what makes "the p95 stepped up at 14:02" readable at a glance | personal `phx_` (`POSTHOG_CLI_API_KEY`) + a numeric project id, via the **management** host `us.posthog.com` | **No** — warn-skips until the key is provisioned |
| `deployment` **event** | the annotation is decoration; the event is *data* — what a HogQL query joins against to answer "which deploy introduced this error" | publishable `phc_`, via `POST /capture/` on the **ingest** host | **Yes**, including on PR previews and forks |

The event carries `env` / `service` / `version` / `deploy_kind` and was verified
live arriving with all four intact. `deploy_kind` is one of
`deploy` | `promote` | `preview` | **`auto_rollback`** — the prod rollback path in
`promote-to-prod.yml` emits its own marker with `auto_rollback`, and the script
switches the annotation emoji for it, because **an auto-rollback is an incident
marker, not a release marker** and a HogQL query needs to be able to separate the
two. It also sets `$process_person_profile: false`: a deploy is not a user, and
minting a person per deploy would corrupt every person-linked view.

## Applying dashboards and alerts

Neither plane is Terraform-managed.

### PostHog (`observability/posthog/apply.sh`)

```bash
export POSTHOG_PERSONAL_API_KEY=phx_...       # or POSTHOG_CLI_API_KEY
./observability/posthog/apply.sh --dry-run    # plan only; no key needed
./observability/posthog/apply.sh              # apply
./observability/posthog/apply.sh --verify     # read-only drift report
```

Dashboards + insights go to **both** projects; alerts go to **production only**.
The applier is idempotent by name, preflights every optional scope and reports all
misses at once, completes the run before reporting failures (with a per-project
summary), and runs on stock macOS bash 3.2.

**Fix drift in the JSON and re-run — never in the UI**, because the next run will
not know. `--verify` reports a live query that no longer matches the committed one.
That is the opposite of the Datadog convention below, and the inversion is
deliberate: Datadog's objects were authored in the UI and exported for record, which
is why "the live monitor is source of truth" appears there and not here.

Two things `apply.sh` deliberately does not do, each with a recreate recipe printed
instead of a guessed API call: **tile layout** (positions carry no contract, and
pinning them would make every cosmetic tweak a repo change) and **non-email alert
delivery** (`subscribed_users` is the only channel wired; Slack/webhook delivery is
a separate `cdp-functions` object, and AECi has no Slack). Both are numbered manual
steps in `observability/posthog/README.md`.



## Post-deploy pipe verification

Run this after a deploy that touches telemetry, and after any operator step that was
supposed to un-block a pipe. The results recorded beside each check are what the
**live pass on 2026-08-24** actually returned (spec §8.9), not what was expected —
where a check has never passed, the reason is named so you do not re-debug working
code.

**Generate traffic first:**

```bash
TELEMETRY_TRAFFIC_GEN=1 PLAYWRIGHT_BASE_URL=https://<staging-url> \
  pnpm --filter @aeci/web exec playwright test e2e/traffic-gen.spec.ts
```

~20 representative pages (static / index / browse / detail), twice. Under native
Workers Cache the **first pass is a MISS (the Worker runs → one datapoint in each
vendor)** and the **second pass is a front-of-Worker HIT that skips the Worker** — so
pass 2 adds no second datapoint anywhere. Confirm the HIT via the
**`Cf-Cache-Status: HIT`** response header instead (preview/staging, where
`cache.enabled` is on).

| # | Check | Status as of the last pass |
|---|---|---|
| 1 | **Worker metrics reach the intake.** `POST /i/v1/metrics` → 200 | ✅ repeatedly. PostHog Metrics is alpha and has **no read tool**, so "split by `endpoint`" is not verifiable from a terminal — the intake accepting is the available evidence, and the dashboard is where you see the split |
| 2 | **Worker logs filtered by `service.name`** (`aeci-api` / `aeci-web`) with `env` + `version` | ✅ both Workers. All nine resource attributes arrive complete, `version` = the real `COMMIT_SHA`. The AECI-103 gated `ssr.render` log ported as-is and fires |
| 3 | **A §26.5 audit forward is visible as a PostHog log.** Trigger an audit-bearing write (e.g. a review submit) | ⚠️ partial — local tracing showed outbound `fetch` spans to `us.i.posthog.com/i/v1/logs` returning 200, which is the mechanism, but no audit-bearing write was triggered in that pass. **Re-run this one** |
| 4 | **Browser Tier 2 pre-consent:** `app_started` + `$web_vitals` fire before consent; nothing persistent is written; `$pageview` is absent; a DNT/GPC browser still emits Tier 2 | ✅ for `app_started` (twice, pre-consent, with a stored `denied` decision, carrying `locale`/`theme`), ✅ zero PostHog keys in `localStorage`/`sessionStorage`, ✅ `$pageview` correctly absent. ❌ `$web_vitals` — **blocked by the remote-config gate, not by the code** |
| 5 | **Angular error capture** via the dev-only bench-route throw button | ✅ an uncaught error through Angular's global listener → `ErrorHandler` → `captureException` arrived as `$exception`. The bench button is correctly **absent** from the production bundle (verify the marker string is gone from `dist/`), so the global-listener path stands in for it there. Devtools-console throws are not a substitute |
| 6 | **Source maps:** prod stack unminified; every chunk `Uploaded` under Symbol sets; **zero** `sourceMappingURL` comments in served JS | ✅ 122 `.map` emitted, 0 `sourceMappingURL` in served JS, 0 `.css.map`; the skip path deleted all 122 maps while leaving the 122 chunks |
| 7 | **A promote run:** kick-off + job metrics and the `job_failed` / `partial_skipped` / `replay_detected` log paths visible | ❌ not run — needs `REVIEW_APP_TOKEN`, absent from local `.dev.vars` |
| 8 | **The liveness sweep drill:** simulate a missing heartbeat, watch the workflow fail red | ✅ drilled against a stub speaking the real query envelope — fresh → exit 0; missing → exit 1; stale → exit 1; PostHog 5xx / no key → exit 2 |
| 9 | **An email/side-effect pipe:** trigger one; the metric and any mirrored event arrive with the expected `outcome` + `template` | ❌ not run **deliberately** — local `.dev.vars` holds a live Resend key, so triggering it sends real mail |
| 10 | **`pnpm dev:agent` boots and serves an SSR 200** — separately from `pnpm build` (the pnpm strict-layout trap: a green build does **not** prove dev resolves) | ✅ SSR 200, `/api/health` 200, `__AECI_POSTHOG__` injected with the committed key (`__AECI_DD__` was still injected at the time of this pass; AECI-651 removed it) |

**The fan-out was proven end to end during the dual-run.** In one run, a single set of
call sites produced `us.i.posthog.com/i/v1/{logs,metrics}` → **200** *and* the two
Datadog intakes → **202**, concurrently — which is the evidence that the PostHog leg
carried everything the Datadog leg did before AECI-651 removed the latter.

**Harness note for whoever re-runs check 4.** `posthog-js` batches captures and
flushes on the visible→hidden transition. An automation tab that was *never* visible
never makes that transition and its timers are throttled, so events sit in the queue
and the check looks like a failure. Dispatch a `pagehide` event on `window` to force
the flush.

**What to look at.** `aeci.page.render.duration_ms` (split by `cache_status` — expect
`MISS` only — and `route_class`), `aeci.api.query.duration_ms` (split by `endpoint`),
`aeci.cache.purge`. The dashboards should show data on the render / API / error-rate
/ purge widgets; the HIT-rate slot is a note pointing at the Cloudflare Workers
observability dashboard (WC-8). With one vendor there is no cross-check any more, so
a metric that is simply *absent* is the finding — see check 1 on why "the intake
accepted it" is the strongest available evidence for the metrics plane.

## Known limitations

Stated here rather than discovered later. Each is a real cost of the migration, and
each was accepted with its eyes open (spec §3.8).

- **Alert cadence is hourly.** Four Datadog monitors evaluated at 5–15 minutes;
  every PostHog alert evaluates at 1 hour. `every_15_minutes` needs the Boost
  add-on and `real_time` needs Scale/Enterprise. **The Worker error-rate alert
  (5 min → 1 h) is the single largest degradation in the migration.** The escape
  hatch, if it bites, is PostHog's log-alert type — 5/10/15/30/60-minute windows,
  no add-on, max 20 per project — written up as manual step 4 in
  `observability/posthog/README.md`.
- **There is no `notify_no_data`, at any PostHog tier.** Absence detection is a CI
  sweep, which means **absence detection now depends on GitHub Actions
  availability** — a dependency the old model did not have. Mitigations: the
  per-cron windows carry margin for the sweep's own lateness, and `job_runs` +
  `/admin/system` + the two daily digests are an independent second record.
- **PostHog Metrics is alpha, and AECi leans on custom metrics far harder than the
  sibling repo that ran this migration first.** The entire cron-health model is
  custom metrics. There is no read tool for the metrics plane, and the insight
  builder is unsettled — which is why every insight here is HogQL over a table
  rather than a UI chart. The dual-run window and the independence of `job_runs`
  are the two mitigations; both are deliberate.
- **No APM, no distributed tracing.** None was ever provisioned in Datadog either,
  so nothing was lost in the swap — but PostHog has no answer here, so this is the permanent
  state rather than a gap awaiting a fix. `trace_id` in the API error envelope is a
  `crypto.randomUUID()`, not an APM span id. Local `wrangler dev` OTel tracing is
  unaffected (`docs/local-tracing.md`).
- **Server-side feature-flag checks cost a network round-trip per call.** Local
  evaluation is genuinely unavailable rather than unimplemented: it would require a
  personal API key inside the client, and that must never become a Worker secret.
  See `ANALYTICS.md` §10.5.
- **Browser search telemetry is consent-scoped.** The RUM action saw every search;
  `search_performed` sees the consented slice. The only place the migration changed
  what a number *means* — see "Browser search telemetry" above.
- **The header autocomplete emits no telemetry at all.** Its only signal was the
  Datadog RUM action, and `/search`'s `search_performed` does not cover it (that
  event fires from `search-controller.ts`, not `autocomplete-controller.ts`). So
  autocomplete latency and error rate are currently unmeasured. This is a *new* hole
  opened by AECI-651, not an accepted narrowing — tracked as **AECI-717**.
- **`$web_vitals` and exception *autocapture* are gated on project settings**, not
  code. Manual `captureException` is not gated. See "The remote-config gate".
- ~~**Field Core Web Vitals currently live only in Datadog RUM.**~~ **Resolved
  2026-08-26** — the project toggle was flipped on both projects, so `$web_vitals`
  now flows to PostHog on every tier and this is no longer a hole blocking the
  AECI-651 Datadog deletion. (It was the one signal where deleting Datadog before
  flipping the toggle would have left a real gap.)
