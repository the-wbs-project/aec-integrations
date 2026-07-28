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
| `aeci.api.promote.skipped` | count | `apps/api/src/routes/promote.ts` (`logPromoteSkips`) | `source` (`promote`), `kind` (`integration` / `extension` / `usefulness` / `claim`) — **value = per-kind skip count, query with `sum:`** |
| `aeci.cache.purge` | count | `apps/web/src/server/routes/admin-purge.ts` | `source` (manual / future webhook), `outcome` (ok / cf_failed) |
| `aeci.api.data_gap` | count | `apps/api/src/lib/handler-utils.ts` (`reportMissingVendors`, called by the product-list-producing handlers) | `gap_type` (currently `missing_vendor`) |
| `aeci.algolia.sync` | count | `apps/api/src/scheduled.ts` (daily cron) + `apps/api/src/routes/promote.ts` (`syncAlgoliaAfterPromote`) | `trigger` (cron / promote), `entity` (products / vendors / integrations / all), `outcome` (ok / failed / skipped_no_creds) |
| `aeci.algolia.index_drift` | gauge | `apps/api/src/scheduled.ts` (daily cron) + `apps/api/scripts/reconcile-algolia-drift.ts` (CLI / deploy-staging hook) | `entity` (products/vendors/integrations), `index` (physical index name) |
| `aeci.algolia.orphans_removed` | gauge | `apps/api/src/scheduled.ts` (daily drift cron, post-report sweep) + `apps/api/scripts/reconcile-algolia-drift.ts` (CLI) — AECI-266 | `entity` (products/vendors/integrations), `index` (physical index name) |
| `aeci.algolia.orphans_skipped_cap` | gauge | `apps/api/src/scheduled.ts` (daily drift cron) — AECI-266; emitted only when the safety cap refuses a large purge | `entity` (products/vendors/integrations), `index` (physical index name) |
| `aeci.algolia.sync.records` | count | `apps/api/src/lib/algolia-sync-metrics.ts` (`emitAlgoliaSyncMetrics`, from the cron + promote hook) | `trigger` (cron / promote), `entity` (products / vendors / integrations), `op` (saved / deleted) |
| `aeci.algolia.sync.duration_ms` | distribution | `apps/api/src/lib/algolia-sync-metrics.ts` (`emitAlgoliaSyncMetrics`, from the cron + promote hook) | `trigger` (cron / promote) |
| `aeci.search.query` | RUM action | `apps/web/src/app/search/search-rum.ts` (`emitSearchQuery`), called by `search-controller.ts` (per-index `connectStats` render + instance `error` event) and `autocomplete-controller.ts` (`runSearch`) — AECI-174; see "Browser search RUM" below | `index` (products/vendors/integrations/federated), `status` (ok/error), `results_bucket` (none/1-5/6-20/21+), `duration_ms` |
| `aeci.stats.compute` | count | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the daily cron + the post-promote refresh) + an inline pre-compute-crash count in `apps/api/src/scheduled.ts` and `apps/api/src/routes/promote.ts` | `trigger` (cron / promote), `outcome` (success / partial / failed) |
| `aeci.stats.compute.duration_ms` | distribution | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the cron + promote hook) | `trigger` (cron / promote) |
| `aeci.stats.compute.key` | count | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the cron + promote hook) | `trigger` (cron / promote), `key` (the `home.*` stats_cache key), `outcome` (written / skipped / failed) |
| `aeci.stats.compute.key.duration_ms` | distribution | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the cron + promote hook) | `trigger` (cron / promote), `key` (the `home.*` stats_cache key) |
| `aeci.pageviews.write` | count | `apps/api/src/routes/page-views.ts` (`capturePageView`, the deferred `POST /api/page-views` insert) | `outcome` (ok / failed); on `outcome:ok` also `bot` (true / false — the ingest-time UA+ASN classification, AECI-526) so the human/bot ratio is queryable in Datadog without waiting for the daily digest |
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
| `aeci.linear.reconcile.email` | count | `apps/api/src/lib/admin-alert.ts` (`sendAdminAlert`, AECI-214; transport AECI-240) | `outcome` (sent / failed / skipped) — sends via Resend; `skipped` when `RESEND_API_KEY` / `ADMIN_ALERT_EMAIL` are absent (the seam is fail-open and the Datadog alert is the backstop) |
| `aeci.request.moderation.action` | count | `apps/api/src/routes/admin-requests.ts` (`emitRequestModeration`, AECI-216 / Phase 6.9 — the `PATCH /api/admin/requests/:id` resolve/reject handler) | `action` (`resolve` / `reject`), `outcome` (`ok` / `invalid_state`) — one count per moderation attempt; `invalid_state` is the §6.9 preload guard (422 when the target isn't `open`/`in_review`) |
| `aeci.email.send` | count | `apps/api/src/lib/email.ts` (the Resend transactional client, AECI-240 / Phase 7.5 — review submit/approve/reject confirmations, the account-deletion email, the reconcile-sweep admin alert, and the landing signup/feedback operator notifications AECI-247/277) | `outcome` (sent / failed / skipped), `template` (`review-submitted` / `review-approved` / `review-rejected` / `account-deleted` / `stuck-request-alert` / `landing-signup` / `landing-feedback`) — fail-open; `skipped` when `RESEND_API_KEY` / `EMAIL_FROM` / the recipient are absent (see `docs/email.md`) |
| `aeci.data_quality.job` | count | `apps/api/src/scheduled.ts` (`runDataQualityJob`, daily 04:00 UTC cron, AECI-241 / Phase 7.6) | `trigger` (cron), `outcome` (success / failed) — one heartbeat per completed run (incl. the pre-run crash path); `outcome:failed` is the failure signal, the always-emitted `{trigger:cron}` series is the liveness signal |
| `aeci.data_quality.job.duration_ms` | distribution | `apps/api/src/scheduled.ts` (`runDataQualityJob`, daily cron) | `trigger` (cron) |
| `aeci.data_quality.check` | gauge | `apps/api/src/scheduled.ts` (`runDataQualityJob`, daily cron, AECI-241) | `check` (the check id, e.g. `products_without_vendor` / `broken_integration_refs` / `reviews_missing_anonymized_at` / `algolia_index_drift`), `severity` (error / warn) — **value is the issue count or 0** (emitted every run so a monitor can break down by check and detect no-data); a check that threw emits the sentinel **-1** |
| `aeci.data_quality.email` | count | `apps/api/src/scheduled.ts` (`runDataQualityJob` → `lib/email.ts` `sendEmail`, AECI-241) | `outcome` (sent / failed / skipped) — **`skipped`** when `RESEND_API_KEY` / `DATA_QUALITY_EMAIL_{FROM,TO}` are unset (fail-open; the Datadog monitors are the delivery backstop) |
| `aeci.waf.ratelimit.blocked` | count | `apps/api/src/lib/waf-metrics.ts` (`emitWafEventMetrics`, from the hourly WAF poll in `apps/api/src/scheduled.ts` `runWafMetricsJob`, AECI-262) | `rule` (CF rule id), `action` (block / managed_challenge / …), `host`, `source` (ratelimit / firewallcustom) — **value is the event count, so query with `sum:`** (gotcha 3); only mitigation actions counted |
| `aeci.waf.poll` | count | `apps/api/src/scheduled.ts` (`runWafMetricsJob`, hourly cron, AECI-262) | `trigger` (cron), `outcome` (ok / failed / skipped_no_creds) — one heartbeat per run; the always-emitted `outcome:ok` series is the cron-liveness signal |
| `aeci.analytics_digest.email` | count | `apps/api/src/scheduled.ts` (`runAnalyticsDigestJob` → `lib/email.ts` `sendEmail`, AECI-526, daily 12:00 UTC cron) | `outcome` (sent / failed / skipped) — the daily operator digest: **human** page views + top products (`is_bot IS NOT 1`), new/total sign-ins, pending-moderation depth, and a Crawler-activity breakdown (`is_bot = 1`, grouped by `bot_name`). **`skipped`** when `RESEND_API_KEY` / `EMAIL_FROM` / `ANALYTICS_DIGEST_EMAIL_TO` are unset (fail-open); one count per run, so the always-emitted series doubles as the cron-liveness signal (`outcome:failed` also covers a pre-send crash) |
| `aeci.moderation.ban` | count | `apps/api/src/routes/admin-reviewers.ts` (`emitBanAction`, **AECI-218 / Phase 6.11** — the `PATCH /api/admin/reviewers/:id` ban/unban write-path) | `action` (`ban` / `unban`), `outcome` (`ok` / `invalid_state` / `forbidden`) — one count per ban/unban attempt, alongside the §9 `appendAuditLog()` + `reviewer_ban` `workflow_transition` |

`aeci.ssr.render` (AECI-103) is one count per SSR render, fired on **every** branch
of `handleSsr` — including the edge-cache HIT path and the non-cacheable branch, both of
which the `aeci.page.render.duration_ms` distribution skips. It is the bounded pipe-health /
render-volume signal that replaced the per-render `ssr.render` *log* firehose. Tags are kept
deliberately low-cardinality (`cache_status` + `status_class`, no path/slug) so cost can't
balloon. `cache_status:non_cacheable` is the slice for the `**` 404 wildcard and non-GET
requests.

Every metric also carries the base tags `env`, `app:aeci`, `service` (`aeci-web` /
`aeci-api`), `worker`, `locale` — the same vocabulary as the log `ddtags` string.

### Measuring the D1 read-replication latency win (AECI-250)

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
monitor (`observability/datadog/monitor-algolia-orphan-sweep-capped.json`) pages on a non-zero
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

`aeci.pageviews.write` (AECI-180) is the write-health signal for the `POST /api/page-views` insert
(AECI-177): one count per attempted insert, `outcome:ok` after a successful `page_views` write and
`outcome:failed` in the swallow-and-log catch. The bot-score sampled-out early return emits nothing
— it's an intentional skip, not a write, and must not pollute the error-rate denominator. The
endpoint already returned 204, so a failing insert is user-invisible; this metric makes the
regression visible as an error **rate** *before* it silently zeroes `home.trending_products` at the
next daily compute. Note it is monitored on error-rate **only**, never liveness/no-data: page_views
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
`level:error` log are **the Datadog alert** behind `monitor-linear-reconcile-stuck.json`.
`aeci.linear.reconcile.email` tracks the admin-alert seam (Resend transport, AECI-240; `outcome:sent|failed|skipped`,
`skipped` when the key/recipient are absent). The full Phase-6 **dashboard** + the pipeline-failure / HMAC / sweep-liveness monitors
land in **6.12** (AECI-219, below); AECI-214 shipped only the single stuck-row (persistent-failure)
monitor the §6.2 backstop required.

`aeci.email.send` (AECI-240, Phase 7.5) is the Resend transactional-email transport health metric —
one count per send attempt from `lib/email.ts`, `outcome` (`sent`/`failed`/`skipped`) × `template`
(`review-submitted` / `review-approved` / `review-rejected` / `account-deleted` / `stuck-request-alert` /
`landing-signup` / `landing-feedback`).
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

`aeci.moderation.ban` (count, `action:ban|unban` × `outcome:ok|invalid_state|forbidden`) **shipped with
AECI-218 / Phase 6.11**: the reviewer-**ban management** write-path (`PATCH /api/admin/reviewers/:id`,
admin sets/clears `profiles.banned_at` + `ban_reason`) emits one count per ban/unban attempt via
`emitBanAction` in `apps/api/src/routes/admin-reviewers.ts`, alongside the §9 `appendAuditLog()` + the
reversible `reviewer_ban` `workflow_transition`. Phase 5 (AECI-197) only *enforces* an existing ban on
review submit; the *write* path is this Phase 6 handler (the ban *action* is raised from the moderation
queue's repeat-offender prompt — `docs/STAGE_1_PHASE_6_SPEC.md` §9). It rides the Phase 6 dashboard +
monitors shipped by AECI-219 / Phase 6.12 (`observability/datadog/`).

`aeci.waf.ratelimit.blocked` / `aeci.waf.poll` (AECI-262, §15.1) surface the Cloudflare WAF
rate-limit + scraper-challenge mitigations (`docs/waf-rate-limits.md`) in Datadog. Enterprise
Logpush is the "push" path Cloudflare offers; we're on **Pro**, so the API Worker's hourly cron
(`runWafMetricsJob`) **polls** instead — it reads the previous clock hour of the zone's
`firewallEventsAdaptiveGroups` over the GraphQL Analytics API
(`packages/shared/src/cloudflare-analytics.ts`) and `submitCount`s one
`aeci.waf.ratelimit.blocked` point per mitigation group (`rule`/`action`/`host`/`source`). **Its
value is the event count, not 1, so query it with `sum:` / `sum:…{}.as_count()`** (gotcha 3);
only mitigation actions (block / challenge) are counted — `allow`/`log`/`skip` are dropped. A
quiet hour emits no blocked points (a count series is sparse — silence = no attacks), so
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
§6.1–6.2) makes Datadog the authoritative record of a promotion push's problems, so the AECi
operator diagnoses a failed push without the review app plumbing the HTTP response body anywhere.
The promote endpoint runs on its own Hono sub-router whose `errorHandler({ logClientErrors: true,
source: 'review-app-promote' })` (`apps/api/src/index.ts` / `apps/api/src/errors.ts`) logs **every**
rejection — not just the unknown-500 branch every other route logs — under `source:review-app-promote`:
one log per 4xx/409 (level `warn`) and 5xx (level `error`), carrying the HTTP status (as
`http_status` — Datadog reserves `status` for the log level), error `code`, `field`, full
`details` (the Zod `issues[]` for a `VALIDATION_FAILED`, the slug `target` for a
`SLUG_CONFLICT`), `path`/`method`, and the **same `trace_id`** returned in the response envelope
(so a caller-reported `trace_id` pivots straight to the log). Separately, a **partial** promote — a
`200` with a non-empty `skipped[]`, which `aeci.api.query.duration_ms` sees as a clean success —
emits a `warn` log `aeci.api.promote.partial_skipped` (detailing every `{ref, kind, reason}` + per-kind
counts) plus the `aeci.api.promote.skipped` count above, so a curator's silently-dropped entity is
visible. All of it is fire-and-forget over the shared transport (no-op without `DD_API_KEY`) and never
affects the response. This is deliberately scoped to promote — the high-traffic public read endpoints
stay silent on 4xx to keep log volume down.

For a `500` (an unhandled throw — e.g. a `db.batch` rejection in promote), the log now also carries a
`cause` attribute: the flattened `err.cause` chain. D1/SQLite put the real reason
(`SQLITE_CONSTRAINT: UNIQUE constraint failed …`, a failing statement, "too many SQL variables") one
link down in `err.cause`, which the bare `err.message` drops — so before this the 500 logged as a
generic "D1_ERROR" with no diagnosable detail (`apps/api/src/errors.ts` → `causeChain`). The same
`cause` is written to the Cloudflare Workers-Observability `console.error`, so `wrangler tail
aeci-api-production` surfaces it live even before Datadog is consulted.

### Troubleshooting: `DD_API_KEY` is set but no Worker logs/metrics appear

The shared transport (`packages/shared/src/datadog.ts`) fires each log/metric via `ctx.waitUntil(fetch(intake))`
and previously only caught a *thrown* fetch. A Datadog intake that **rejects** the request — a `403`
from an invalid/mis-scoped `DD_API_KEY`, a `413` (payload too large), a plan/exclusion drop — resolves
the `fetch` with a non-2xx status, so the throw-only `catch` never fired and **every log and metric was
discarded silently**. That is the "the secret is clearly set (see the Worker's Variables & Secrets) but
nothing reaches Datadog" failure. The transport now checks `res.ok` and, on a non-2xx, emits
`console.warn('<label>: intake rejected <status>', <body snippet>)` (still swallowed — observability must
never break the request path). So when a Worker's logs go missing despite `DD_API_KEY` being present:

```bash
# Watch the live Worker log stream and re-trigger the endpoint (e.g. a promote):
wrangler tail aeci-api-production --format pretty
# then look for:  logToDatadog: intake rejected 403   /   submitMetric: intake rejected 403
```

A `403` there means the key value is wrong for the `DD_SITE` org (rotate/replace the `DD_API_KEY`
Worker secret — it is NOT CI-pushed; set it manually per `docs/environments.md` §6). No `intake
rejected` / `forward failed` line means the intake accepted the payload and the gap is Datadog-side
(wrong index/service filter, an exclusion filter, or the RUM-vs-Logs view) — broaden the query to
`service:aeci-api` / `service:aeci-web`.

### Three gotchas when querying

1. **Datadog lowercases tag values.** `cache_status:HIT` is stored and queried as
   `cache_status:hit`; `status_class:5xx` stays `5xx`. All dashboard/monitor queries
   use lowercase.
2. **Distribution percentiles must be enabled.** `aeci.page.render.duration_ms`,
   `aeci.api.query.duration_ms`, `aeci.algolia.sync.duration_ms`,
   `aeci.stats.compute.duration_ms`, `aeci.stats.compute.key.duration_ms`,
   `aeci.toxicity.api.duration_ms`, `aeci.linear.issue.duration_ms`, and
   `aeci.linear.sync.duration_ms` are
   distribution metrics — to query `p50/p95/p99` you must enable percentile aggregations
   under **Metrics → Summary → (metric) → Manage distribution metrics → Add percentile
   aggregations**. Done once per metric.
3. **Count metrics whose value isn't 1 need `sum:`, not `count:`.** `count:` counts the
   number of submitted points; `sum:` sums their values. Most count metrics here submit
   `value 1` (so the two coincide — e.g. `count:aeci.cache.purge`), but
   `aeci.algolia.sync.records` and `aeci.api.promote.skipped` submit the actual record /
   skip count and must be queried as `sum:aeci.algolia.sync.records` /
   `sum:aeci.api.promote.skipped` (and `sum:…{}.as_count()` in monitors).

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
- **Live URL:** _TBD — filled in after the AECI-233 live apply; runbook + sign-off table in [`docs/PHASE_5_OPERATIONAL_VERIFICATION.md`](./PHASE_5_OPERATIONAL_VERIFICATION.md) (Part D)._

Widgets (Phase 5.15 auth + reviews health, AECI-206): sign-ins by `outcome` · sign-ins by
`method` · auth failure rate (`100 × failed / total`, with a 30% marker) · review submits by
`outcome` · moderation actions by `action`/`outcome` · toxicity scoring latency p50/p95/p99 ·
toxicity scoring error rate (`100 × failed / total`, with a 50% marker) · moderation queue
oldest-pending age (h) + depth (with a 48h backlog marker). Note the sign-in widgets read
`aeci.auth.signin`, which carries `service:aeci-web` (the SSR Worker), unlike the rest of the
Phase 5 metrics on `aeci-api`.

### `AECi Phase 6 — Requests / Moderation`

- **Definition (for record):** `observability/datadog/dashboard-requests-moderation.json`
- **Live URL:** https://us5.datadoghq.com/dashboard/k86-25g-8rx/aeci-phase-6--requests--moderation _(applied 2026-06-20 — AECI-219; the 3 Phase 6 monitors were applied in the same pass with `@chrisw@thewbsproject.com` substituted for the placeholder)._

Widgets (Phase 6.12 requests/moderation health, AECI-219 — all `aeci-api`, already emitted by the
6.4–6.7 feature issues): Linear issue creation by `outcome` · by `kind` · issue-creation failure rate
(`100 × failed / terminal`, `skipped_exists` excluded, 50% marker) · issue-creation latency p50/p95/p99 ·
site→Linear sync by `outcome` · by `to_status` · sync latency p50/p95/p99 · webhook receipts by `action` ·
webhook HMAC failures (`sum:`, 3/1h marker) · reconciliation backlog gauge (`aeci.linear.reconcile.stuck`) ·
reconciliation attempts by `outcome` (`sum:`) · persistent failures (`sum:`, any > 0 pages) · admin-alert
email seam by `outcome`. **No ban-action widget** — `aeci.moderation.ban` is deferred to AECI-218 / Phase
6.11 (see the catalog note above). The two duration distributions need percentile aggregations enabled
(gotcha 2); `…reconcile.attempt`/`…persistent_failure` submit row counts, so they use `sum:` (gotcha 3).

## Monitors

Each monitor's `message` links the matching runbook in `docs/RUNBOOKS.md` and routes to
the team notification channel. The committed JSON keeps the `@NOTIFICATION_CHANNEL_TBD`
placeholder (env-agnostic for record); substitute the real handle **at apply time**. The
resolved handle is `@chrisw@thewbsproject.com` (Datadog email notification; AECI-222) — the
then-nine monitors were applied 2026-06-12 with that substitution; the Phase 3–7 monitors were
applied in their own phase passes, and AECI-279 (Phase 8.1) added two more, bringing the committed
set to **23**. One exception to the handle rule: the informational
`monitor-data-quality-check-warn.json` (AECI-279) uses a distinct `@NOTIFICATION_CHANNEL_LOW_TBD`
placeholder — substitute a low-urgency handle, or leave it literal to keep that warn monitor
**UI-only / non-paging** (the daily digest already carries its rows).

| Monitor | Condition | Definition |
|---|---|---|
| Cache hit rate low | hit rate < 70% sustained 15m | `observability/datadog/monitor-cache-hit-rate.json` |
| Detail render slow | p95 detail render (cache MISS) > 1.5s sustained 10m | `observability/datadog/monitor-detail-render-p95.json` |
| Worker error rate high | combined SSR+API 5xx rate > 1% over 5m | `observability/datadog/monitor-error-rate.json` |
| Algolia index drift | any index's \|drift\| > 0 (daily); or no data for 48h | `observability/datadog/monitor-algolia-index-drift.json` |
| Algolia sync failed | any `outcome:failed` push in the last 1d | `observability/datadog/monitor-algolia-sync-failed.json` |
| Algolia sync not running | no successful (`outcome:ok`) cron push for 48h | `observability/datadog/monitor-algolia-sync-no-data.json` |
| Algolia orphan sweep capped | any `aeci.algolia.orphans_skipped_cap` > 0 (the safety cap refused a large orphan purge) | `observability/datadog/monitor-algolia-orphan-sweep-capped.json` |
| Home stats compute failed | any `aeci.stats.compute.key{outcome:failed}` or job-level `aeci.stats.compute{outcome:failed}` (the latter covers a pre-compute crash) in the last 1d | `observability/datadog/monitor-stats-compute-failed.json` |
| Home stats not running | no `aeci.stats.compute{trigger:cron}` heartbeat for ~26h | `observability/datadog/monitor-stats-compute-no-data.json` |
| page_views write errors | write error rate > 10% over 10m | `observability/datadog/monitor-pageviews-write-errors.json` |
| Auth sign-in error rate | sign-in failure rate > 30% over 15m (`service:aeci-web`) | `observability/datadog/monitor-auth-error-rate.json` |
| Toxicity scoring outage | Toxicity-scoring failure rate > 50% over 15m | `observability/datadog/monitor-toxicity-outage.json` |
| Moderation queue backlog | oldest pending review > 48h (daily); or no snapshot for ~26h | `observability/datadog/monitor-moderation-queue-age.json` |
| Linear pipeline failure | Linear write failure rate (`issue` + `sync`, terminal attempts) > 50% over 1h | `observability/datadog/monitor-linear-pipeline-failure.json` |
| Linear webhook HMAC failures | `aeci.webhooks.linear.hmac_failure` > 3 over 1h | `observability/datadog/monitor-webhook-hmac-failure.json` |
| Linear reconciliation: persistent stuck requests | any `aeci.linear.reconcile.persistent_failure` in the last 1h | `observability/datadog/monitor-linear-reconcile-stuck.json` |
| Linear reconciliation sweep not running | no `aeci.linear.reconcile.stuck` gauge for ~1h (no-data liveness) | `observability/datadog/monitor-linear-reconcile-no-data.json` |
| Data quality check — error severity | any `severity:error` check (`broken_integration_refs`, `reviews_missing_anonymized_at`) reports issues > 0 (daily) | `observability/datadog/monitor-data-quality-check.json` |
| Data quality check — warn severity (informational) | any `severity:warn` check reports issues > 0 (daily); **non-paging** (AECI-279 split) | `observability/datadog/monitor-data-quality-check-warn.json` |
| Data quality job failed | job-level `aeci.data_quality.job{outcome:failed}` > 0 in the last 1d | `observability/datadog/monitor-data-quality-failed.json` |
| Data quality job not running | no `aeci.data_quality.job{trigger:cron}` heartbeat for ~26h | `observability/datadog/monitor-data-quality-no-data.json` |
| WAF rate-limit / challenge spike | `sum:aeci.waf.ratelimit.blocked` (`.as_count()`) > 500 over 15m (`env:production`) | `observability/datadog/monitor-waf-ratelimit-spike.json` |
| WAF poll not running | no successful `aeci.waf.poll{outcome:ok,trigger:cron}` for ~3h (no-data liveness) | `observability/datadog/monitor-waf-poll-no-data.json` |

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
**pre-compute crash** (a DB-client-init throw before `runHomeStats`), which emits the job-level
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

The Phase 5 monitors (AECI-206) split the same way. **"Auth sign-in error rate"** and **"Toxicity
scoring outage"** are **traffic-driven error-rate** monitors — like page_views, no `notify_no_data` (zero
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

The Phase 6 monitors (AECI-219) follow the **same failure + liveness split**, across two surfaces.
**"Linear pipeline failure"** is a **traffic-driven error-rate** monitor (like the Phase 5 pair): the
combined `aeci.linear.issue` + `aeci.linear.sync` `outcome:failed` rate over **terminal** attempts
(`skipped_exists` / `skipped_no_issue` excluded from the denominator so an idempotent re-fire or a
no-issue sync can't dilute the ratio), no `notify_no_data` (the pipeline is traffic-driven and the
absent-key path emits nothing, so zero is healthy). It catches **systemic** breakage (revoked key,
drifted board ids, Linear down) earlier than the per-row reconcile backstop, and is the **only** alert
covering the outbound **sync** path, which has no reconciliation retry. **"Linear webhook HMAC failures"**
is also error-driven (count `> 3`/1h, no `notify_no_data` — a bad signature is the only thing that emits
it): a security/mis-config signal where a sudden burst paired with a drop in `aeci.webhooks.linear.receipt`
means the signing secret rotated out of sync. The reconciliation sweep keeps the AECI-214 failure monitor
(**"persistent stuck requests"**, `aeci.linear.reconcile.persistent_failure > 0`, no `notify_no_data` — the
§6.2 backstop alert) and now gains its **fixed-cadence liveness** companion (**"sweep not running"**): the
every-15-min sweep emits the `aeci.linear.reconcile.stuck` gauge on **every** run (0 on a clean run), so a
`notify_no_data` check (`no_data_timeframe` ~60m ≈ 4 missed sweeps) means the cron stalled and stuck rows
are no longer retried. That monitor's value threshold is intentionally unsatisfiable (the gauge is ≥ 0) —
its sole job is the no-data heartbeat; the backlog *value* is alerted by the persistent-failure monitor.
Same rule as Algolia/stats: keep the failure and liveness concerns on separate metrics. Thresholds
(50% / 3-per-hour / ~1h) are launch-tunable starting points. The Phase 6 **ban-action** metric
(`aeci.moderation.ban`) and its monitor are deferred to AECI-218 / Phase 6.11 (the feature is unbuilt).

**"WAF rate-limit / challenge spike"** (AECI-262) is a single **threshold** monitor on
`sum:aeci.waf.ratelimit.blocked{env:production}.as_count() > 500 / 15m`, **no** `notify_no_data` —
a quiet hour emits nothing (no attacks = healthy), so a no-data alert would be constant noise, and
the metric is value-bearing so it uses `sum:` + `.as_count()` (gotcha 3). Detection lags up to ~1h
because the source is an hourly poll. Cron-liveness is intentionally **not** folded in here — it
rides the separate always-emitted `aeci.waf.poll{outcome:ok}` heartbeat (same failure + liveness
split as Algolia/stats). **AECI-279 (Phase 8.1) added that liveness monitor** —
`monitor-waf-poll-no-data.json`, `notify_no_data` on `aeci.waf.poll{outcome:ok,trigger:cron}` over a
3h window (~2 missed hourly polls) — so a silently-dead poll now pages instead of going unnoticed. The
500/15m threshold is a launch-tunable placeholder — set it once baseline mitigation volume is known.

The **data-quality monitors** (AECI-241, Phase 7.6) follow the same failure + liveness split, plus a
**severity split added by AECI-279** (Phase 8.1). The daily 04:00 UTC job emits `aeci.data_quality.check`
per check (0 = clean, **-1** = the check threw) tagged with both `check:` and `severity:`
(`error` | `warn`). **"Data quality check — error severity"** pages on the two integrity checks
(`broken_integration_refs`, `reviews_missing_anonymized_at`); **"Data quality check — warn severity"** is
the informational, non-paging companion for the eight hygiene checks (it carries the
`@NOTIFICATION_CHANNEL_LOW_TBD` placeholder, and the daily email digest already delivers the rows). Before
the split, a warn finding (e.g. a known duplicate candidate) paged identically to a broken-integration
ref; the split lets warn checks be muted or tuned independently — the AECI-279 "tighten warn-level alerts"
tuning. **"Data quality job failed"** (`outcome:failed`, no `notify_no_data`) catches a thrown check or a
pre-run crash; **"Data quality job not running"** is the `{trigger:cron}` no-data liveness (~26h). None
auto-repairs — the job is report-only.

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

## PostHog (client product analytics, AECI-239 / §14.1)

PostHog is the **client-side** product-analytics layer — funnels, cohorts, feature
adoption, retention — complementing the server-side `page_views` table (§14.2, which
sees the Cloudflare context PostHog can't). It is **not** part of the Datadog pipes
above. Implemented in `apps/web/src/app/analytics/`.

**How it loads (cache-neutral, opt-in).** The SSR Worker inlines the public config as
`window.__AECI_POSTHOG__ = {key, host}` before `</head>` (`posthog-bootstrap-inject.ts`)
— deployment-env-only, so it's safe to cache (§9.1a). In the browser, the `Analytics`
service loads `posthog-js` (dynamic import) and calls `posthog.init()` **only after the
visitor accepts the consent banner** (`consent-banner.ts`); Do-Not-Track is honored as a
hard decline (no load, no banner). Init uses `capture_pageview: 'history_change'` (auto
pageviews incl. SPA navigations), `autocapture: false`, and
`disable_external_dependency_loading: true` (so the CSP `script-src` stays untouched —
only the two `connect-src` PostHog US hosts are needed).

**Dimensions on every event.** `locale` + `theme` ride every event. For the 8 custom
events they're merged into the event properties (`analyticsDimensions()` reads
`<html lang>` / `data-theme`); for autocaptured pageviews they're registered as PostHog
super-properties in the `loaded` callback (before the first pageview). `theme` is always
`light` today (dark removed in AECI-226) but the dimension is still emitted so the schema
is stable when dark returns.

**Event catalog (§14.1).**

| Event | Fired from | Properties |
|---|---|---|
| `search_performed` | `search-controller.ts` (root stats settle, one per distinct non-empty query — the empty initial `/search` load is skipped) | `query`, `results_count` (federated), `filters_applied[]` |
| `product_viewed` | `products/product-detail.ts` (`afterNextRender`) | `product_id`, `source` (`search`/`browse`/`direct`, from the previous in-app route) |
| `integration_viewed` | `integrations/integration-detail.ts` (`afterNextRender`) | `integration_id` |
| `review_submitted` | `reviews/review-form.ts` (submit success) | `product_id` |
| `claim_requested` | `requests/request-form-body.ts` (submit success) | `target_type`, `slug`, `request_id` |
| `correction_requested` | `requests/request-form-body.ts` (submit success) | `target_type`, `slug`, `request_id` |
| `external_link_clicked` | `[aecTrackExternalLink]` directive on detail-page outbound anchors | `destination`, `source` |
| `mailing_list_signup` | the shared signup band (`home/home-closing-cta.ts` + directory/detail mounts, AECI-327) and the `/updates` page (`updates/updates.ts`, AECI-536), on subscribe success (`created` only — re-submitting an existing email is not tracked) | `source` (`home_closing_cta` / `mailing_list_band` / `updates_page`) |

**Consent caveat — signups (AECI-326).** `mailing_list_signup` is consent-gated like every
other event, so PostHog records only the **consented** signup funnel. The authoritative,
consent-independent signup count is the `mailing_list` D1 table (fed by `POST /api/subscribe`),
mirrored to Datadog as `aeci.email.send{template:landing-signup}` (the operator notification on
each new insert). Read the PostHog event for funnel/attribution; read the table for the true count.

**Documented deviation — claim/correction identifier.** §14.1 names `vendor_id` /
`product_id`, but the request form holds only `(target_type, slug)` by design
(`request-form-body.ts`) and the submit response returns only `request_id` — the client
never sees the UUID. So those two events record `{ target_type, slug, request_id }`: the
slug is the stable public identifier (1:1 with the entity) and is sufficient to join
back to it. Resolving the UUID would require an extra round-trip for no analytical gain.

**Region is pinned to US.** `POSTHOG_HOST` defaults to `https://us.i.posthog.com`; the
static CSP `connect-src` allowlists `us.i.posthog.com` + `us-assets.i.posthog.com`.
Switching to EU is a code change (host default + the two CSP hosts).

## Credentials

| Credential | Used by | Where it lives | Notes |
|---|---|---|---|
| `DD_API_KEY` | Worker runtime — logs **and** metric submission | Wrangler secret (both Workers, all envs) | Already provisioned (AECI-31). Metric submission needs only this key. |
| `DD_APP_KEY` | **Operator only** — creating/reading dashboards + monitors | Local shell / CI secret at apply time | **Never** a Worker secret; never in `wrangler.jsonc` / `.dev.vars`. |
| `DD_SITE` | both | Wrangler `vars` | `us5.datadoghq.com`. The metrics host is `api.{DD_SITE}`. |
| `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` | `apps/web` **browser RUM** (client-exposed) | Wrangler secret on the **web Worker only**, CI-pushed from the shared un-suffixed `DD_APPLICATION_ID` / `DD_CLIENT_TOKEN` GH secrets | AECI-326. The single `aeci` RUM app on us5; the per-env `env` field separates envs, so one pair is reused everywhere (like `DATADOG_API_KEY`). Absent → no `window.__AECI_DD__`, so RUM — including Core Web Vitals — no-ops (fail-open). |
| `POSTHOG_KEY` | `apps/web` browser (client-exposed project key) | Wrangler secret on the **web Worker only**, CI-pushed from `POSTHOG_KEY_{STAGING,PRODUCTION}` | AECI-239. Publishable; stored as a secret only to keep it out of git. Absent → analytics no-ops (fail-open). |
| `POSTHOG_HOST` | `apps/web` browser | Wrangler `vars` (web Worker, per env) | `https://us.i.posthog.com`. Defaulted in code when unset. |

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
