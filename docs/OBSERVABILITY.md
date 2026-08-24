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

### Not a pipe: local dev tracing (AECI-548)

`wrangler dev` captures OpenTelemetry traces for every **local** Worker invocation and serves
them over a read-only SQL endpoint. **This is a separate thing from everything else in this
document — do not conflate the two.**

| | Local tracing | The three pipes above |
|---|---|---|
| Where | Inside the `wrangler dev` process | Deployed tiers |
| Lifetime | Wiped when the dev server exits | 7–15 day retention |
| Transport | **None** — never leaves the machine | HTTP intake, `ctx.waitUntil` |
| Content | Every span of every local request | Curated `aeci.*` catalog + gated logs |
| Configured by | Nothing — automatic | Wrangler vars + `DD_API_KEY` / `POSTHOG_KEY` |

Consequences worth stating plainly: a local span **never** reaches Datadog or PostHog, so it
can neither pollute a dashboard nor be used as evidence about deployed behaviour; and nothing
in the metric catalog below has a local-dev equivalent. Full schema, guardrails, and the
debugging recipes live in **`docs/local-tracing.md`**.

The one place they touch: because the §26.5 Datadog forwards run through `ctx.waitUntil`, they
appear in local traces as outbound `fetch` spans to `http-intake.logs.us5.datadoghq.com` and
`api.us5.datadoghq.com`. That is a cheap way to confirm a forward actually fires without
opening Datadog.

## Custom metric catalog (Phase 2 §14)

> **⚠️ Front-of-Worker cache (WC-3 AECI-317 · WC-8 AECI-322).** Native Cloudflare Workers Cache serves cacheable HITs **without running the SSR Worker** (preview + staging; demo/production still gated). So the two SSR render metrics only ever record `cache_status:MISS`/`miss` (the Worker runs only on a native-cache miss) or `non_cacheable` — **there is no `cache_status:hit` series.** HIT-rate visibility lives on `Cf-Cache-Status` + the Cloudflare Workers observability dashboard (see "Front-of-Worker cache: HIT observability" below). **WC-8 (AECI-322) completed the rework:** the `cache hit rate < 70%` monitor + its dashboard widget were **retired** (their `cache_status:hit` numerator is now permanently ~0 — they would flatline / alert forever), and the crawler-`noindex` decision is now baked into the cached payload so a HIT can't leak an indexable non-prod page (`docs/CACHE_STRATEGY.md` §7.1).

| Metric | Type | Emitted from | Tags |
|---|---|---|---|
| `aeci.page.render.duration_ms` | distribution | `apps/web/src/server-runtime.ts` (`handleSsr`, cacheable render = native-cache MISS) | `route_class` (detail/index/browse), `cache_status` (`MISS` only — no `hit` series; WC-3/WC-8), `status_code`, `status_class` (2xx/4xx/5xx) |
| `aeci.ssr.render` | count | `apps/web/src/server-runtime.ts` (`handleSsr`, every branch the Worker runs) | `cache_status` (`miss`/`non_cacheable` only — no `hit` series; WC-3/WC-8), `status_class` (2xx/4xx/5xx) |
| `aeci.api.query.duration_ms` | distribution | `apps/api/src/metrics-middleware.ts` (top-level Hono middleware) | `endpoint` (matched route pattern, e.g. `/api/products/:slug`), `status`, `status_class` — **note (AECI-563):** on `endpoint:/api/promote` this now times only the fast kick-off, not the ingest; use `aeci.api.promote.job.duration_ms` for the commit |
| `aeci.api.promote.kickoff` | count | `apps/api/src/routes/promote-kickoff.ts` (`POST /api/promote`, AECI-563) | `outcome` (`created` / `existing` — `existing` is a replayed kick-off attaching to its already-running job, the idempotency guard firing), `payload` (`inline` / `staged` — `staged` means the bundle exceeded the 1 MiB Workflow-params cap and went to `PROMOTE_KV`) |
| `aeci.api.promote.job` | count | `apps/api/src/workflows/promote-workflow.ts` (`runPromoteWorkflow`, AECI-563) | `outcome` (`complete` / `errored`), plus `code` (the `ApiErrorCode`) on `errored` — one heartbeat per finished job; the always-emitted `outcome:complete` series is the ingest-liveness signal |
| `aeci.api.promote.job.duration_ms` | distribution | `apps/api/src/workflows/promote-workflow.ts` (`runPromoteWorkflow`, AECI-563) | `outcome` (`complete` / `errored`) — wall-clock of the whole job (payload load + plan + atomic batch + count recompute). **This is the metric that replaces the old promote request duration**; a slow ingest is no longer visible as a slow request |
| `aeci.api.promote.skipped` | count | `apps/api/src/routes/promote.ts` (`logPromoteSkips`) | `source` (`promote`), `kind` (`integration` / `extension` / `usefulness` / `claim` / `trade` / `vendor` / `product`) — **value = per-kind skip count, query with `sum:`** |
| `aeci.api.promote.stale_id` | count | `apps/api/src/routes/promote.ts` (`logPromoteStaleIds`, AECI-568) | `source` (`promote`), `kind` (`vendor` / `product` / `integration`) — **value = per-kind count, query with `sum:`**. The caller sent a `supabaseId` whose row no longer exists, so the ingest **created** a replacement instead of no-op-updating. Self-healing, but it means the review app was holding a dead pointer — a sustained non-zero series says the two sides are diverging |
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
| `aeci.search.query` | RUM action | `apps/web/src/app/search/search-rum.ts` (`emitSearchQuery`), called by `search-controller.ts` (per-index `connectStats` render + instance `error` event) and `autocomplete-controller.ts` (`runSearch`) — AECI-174; see "Browser search RUM" below | `index` (products/vendors/integrations/federated), `status` (ok/error), `results_bucket` (none/1-5/6-20/21+), `duration_ms` |
| `aeci.stats.compute` | count | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the daily cron + the post-promote refresh) + an inline pre-compute-crash count in `apps/api/src/scheduled.ts` and `apps/api/src/routes/promote.ts` | `trigger` (cron / promote), `outcome` (success / partial / failed) |
| `aeci.stats.compute.duration_ms` | distribution | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the cron + promote hook) | `trigger` (cron / promote) |
| `aeci.stats.compute.key` | count | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the cron + promote hook) | `trigger` (cron / promote), `key` (the `home.*` stats_cache key), `outcome` (written / skipped / failed) |
| `aeci.stats.compute.key.duration_ms` | distribution | `apps/api/src/lib/home-stats-metrics.ts` (`emitHomeStatsMetrics`, from the cron + promote hook) | `trigger` (cron / promote), `key` (the `home.*` stats_cache key) |
| `aeci.metrics_snapshot.run` | count | `apps/api/src/lib/metrics-snapshot.ts` (`emitMetricsSnapshotMetrics`, from the daily 00:15 UTC snapshot cron) + an inline pre-compute-crash count in `apps/api/src/scheduled.ts` | `trigger` (cron), `outcome` (ok / partial / failed) — always emitted, so this doubles as the cron-liveness heartbeat |
| `aeci.metrics_snapshot.run.duration_ms` | distribution | `apps/api/src/lib/metrics-snapshot.ts` (`emitMetricsSnapshotMetrics`) | `trigger` (cron) |
| `aeci.metrics_snapshot.metric` | count | `apps/api/src/lib/metrics-snapshot.ts` (`emitMetricsSnapshotMetrics`) | `trigger` (cron), `metric` (the `metrics_daily` key — one of the 19 in `ADMIN_SNAPSHOT_METRIC_KEYS`), `outcome` (written / failed) |
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
| `aeci.email.send` | count | `apps/api/src/lib/email.ts` (the Resend transactional client, AECI-240 / Phase 7.5, extended by every epic that added a template) | `outcome` (sent / failed / skipped), `template` — **the tag list is the `EmailTemplate` union in `lib/email.ts`, and `docs/email.md`'s catalogue is its prose mirror; keep all three in step.** Currently: `review-submitted` / `review-approved` / `review-rejected` / `account-deleted` / `mailing-list-welcome` / `stuck-request-alert` / `landing-signup` / `landing-feedback` / `claim-approved` / `claim-rejected` / `attestation-silent-counterparty` / `attestation-open-conflict` / `attestation-stale-version` / `attestation-ops-alert` / `entitlement-expiring` / `entitlement-expiring-admin`. Fail-open; `skipped` when `RESEND_API_KEY` / `EMAIL_FROM` / the recipient are absent (see `docs/email.md`) — for the two vendor-addressed sweeps (`attestation-*`, `entitlement-expiring`) that also covers an absent `SUPABASE_SERVICE_ROLE_KEY`, which is the expected local / PR-preview state |
| `aeci.data_quality.job` | count | `apps/api/src/scheduled.ts` (`runDataQualityJob`, daily 04:00 UTC cron, AECI-241 / Phase 7.6) | `trigger` (cron), `outcome` (success / failed) — one heartbeat per completed run (incl. the pre-run crash path); `outcome:failed` is the failure signal, the always-emitted `{trigger:cron}` series is the liveness signal |
| `aeci.data_quality.job.duration_ms` | distribution | `apps/api/src/scheduled.ts` (`runDataQualityJob`, daily cron) | `trigger` (cron) |
| `aeci.data_quality.check` | gauge | `apps/api/src/scheduled.ts` (`runDataQualityJob`, daily cron, AECI-241) | `check` (the check id, e.g. `products_without_vendor` / `broken_integration_refs` / `reviews_missing_anonymized_at` / `algolia_index_drift` / `entitlement_mirror_drift`), `severity` (error / warn) — **value is the issue count or 0** (emitted every run so a monitor can break down by check and detect no-data); a check that threw emits the sentinel **-1**. **`entitlement_mirror_drift` (severity `error`, AECI-609) is Guard 2 of the `vendors.verified` mirror invariant** (`STAGE_2_PAID_TIERS_SPEC.md` §2.1): it counts vendors where `verified = 1` XOR an `active` `vendor_entitlements` row exists. Non-zero means something wrote the mirror outside `lib/vendor-entitlement.ts` — hand-written D1 SQL, the `apps/datatool` Worker, or (the likely one) a §2.4 backfill that ran on one tier and not another. It rides the existing gauge deliberately, so it needed no new metric and no new monitor |
| `aeci.data_quality.email` | count | `apps/api/src/scheduled.ts` (`runDataQualityJob` → `lib/email.ts` `sendEmail`, AECI-241) | `outcome` (sent / failed / skipped) — **`skipped`** when `RESEND_API_KEY` / `DATA_QUALITY_EMAIL_{FROM,TO}` are unset (fail-open; the Datadog monitors are the delivery backstop) |
| `aeci.attestation.detector` | gauge | `apps/api/src/lib/attestation-notify-metrics.ts` (`emitDetectorMetrics`, from the daily 10:00 UTC §7 attestation sweep in `apps/api/src/scheduled.ts` `runAttestationNotifyJob`, AECI-302) | `detector` (`silent-counterparty` / `open-conflict` / `stale-version` / `aeci-denied`) — **value is the finding count or 0**, emitted for every detector in the union on **every** run (a detector dropped from the registry flatlines at 0 rather than vanishing); a detector that threw emits the sentinel **-1**, the same idiom as `aeci.data_quality.check`. **This zero series is the job's only liveness signal until vendors start attesting** — the detectors match nothing while every attestation in D1 is still `source='aeci'` |
| `aeci.attestation.notify.job` | count | `apps/api/src/scheduled.ts` (`runAttestationNotifyJob`, daily 10:00 UTC cron, AECI-302) | `trigger` (cron), `outcome` (success / failed) — one heartbeat per run. Unlike the read-only gauge jobs this one **rethrows** after emitting `outcome:failed`, so the queue consumer retries |
| `aeci.attestation.notify.job.duration_ms` | distribution | `apps/api/src/scheduled.ts` (`runAttestationNotifyJob`, daily cron) | `trigger` (cron) |
| `aeci.attestation.notify.sent` | count | `apps/api/src/lib/attestation-notify-metrics.ts` (`emitNotifyOutcomeMetrics`, same sweep) | `detector`, `outcome` (`sent` / `failed` / `skipped`) — aggregated to one point per (detector, outcome) per run, not one per email. Only findings the sweep actually attempted to send are counted here: **`skipped`** means no resolvable recipient (no `RESEND_API_KEY`, no `ADMIN_ALERT_EMAIL`, or `fetchAuthUserEmails` degraded without `SUPABASE_SERVICE_ROLE_KEY`) and writes no ledger row, so it is retried by the next sweep. Findings **suppressed** by an in-window `audit_log` ledger row (§7.3) are filtered out *before* the send loop, so they never reach this metric — the suppressed count lives in the per-run summary log (`aeci.attestation.notify found=… suppressed=…`), not as an `outcome:` tag here |
| `aeci.entitlement.action` | count | `apps/api/src/routes/admin-entitlements.ts` (`emitEntitlementAction`, AECI-532 — the `PATCH /api/admin/vendors/:id/entitlement` set/renew/clear handler) | `action` (`set` / `renew` / `clear`), `outcome` (`ok` / `invalid_state` / `forbidden`) — one count per attempt, alongside the `vendor_entitlement.set` / `.renewed` / `.cleared` `audit_log` row written in the same `db.batch`. `invalid_state` is the §5.1 422 gate (a `set` on an already-active entitlement, a `renew`/`clear` on one that is not active); `forbidden` is the zero-capability-tier guardrail. **This is the only metric that moves when a Verified badge appears or disappears**, so `action:clear` is the series to watch — `outcome:ok` there means a vendor's badge is coming off every cached page and out of the next nightly Algolia push |
| `aeci.entitlement.expiry_due` | gauge | `apps/api/src/lib/entitlement-expiry-metrics.ts` (`emitExpiryDueMetric`, from the daily 11:00 UTC §7 sweep in `apps/api/src/scheduled.ts` `runEntitlementExpiryJob`, AECI-613) | — (no tags) — terms inside the warning horizon this run, **before** the `expiry_notice_sent_at` fence. A gauge, not a count, because it is a stock rather than a flow: it answers "how much is due" and stays flat while nobody renews. **Emitted on every run including zero**, which is what makes it a liveness signal — every §2.4 backfilled entitlement is perpetual (`period_end IS NULL`) and therefore structurally invisible to this job, so **0 is the healthy steady state for a long time** and no-data is the failure |
| `aeci.entitlement.expiry_notice` | count | `apps/api/src/lib/entitlement-expiry-metrics.ts` (`emitExpiryNoticeMetrics`, same sweep) | `channel` (`vendor` / `admin`), `outcome` (the `EmailOutcome` verbatim: `sent` / `failed` / `skipped`) — aggregated to one point per (channel, outcome) per run, not one per email, so a vendor with four seats is not four identical counts. **`channel:vendor,outcome:skipped` on a deployed tier is a real finding** (a missing `SUPABASE_SERVICE_ROLE_KEY`, or a vendor with no unbanned seat) rather than the expected state it is locally and on PR previews; `channel:admin` needs only `ADMIN_ALERT_EMAIL` and should always land |
| `aeci.entitlement.expiry.job` | count | `apps/api/src/scheduled.ts` (`runEntitlementExpiryJob`, daily 11:00 UTC cron, AECI-613) | `trigger` (cron), `outcome` (ok / failed) — one heartbeat per run. Unlike the attestation sweep this job **does not rethrow**: a retry would re-send every notice whose fence write is what failed, so an unexpected error is an `outcome:failed` heartbeat and a `failed` `job_runs` row and nothing more. Per-notice send failures and batch failures stay `outcome:ok` with the counts in the summary log — the sweep is fail-open and tomorrow's run picks up exactly what this one missed |
| `aeci.entitlement.expiry.job.duration_ms` | distribution | `apps/api/src/scheduled.ts` (`runEntitlementExpiryJob`, daily cron) | `trigger` (cron) |
| `aeci.waf.ratelimit.blocked` | count | `apps/api/src/lib/waf-metrics.ts` (`emitWafEventMetrics`, from the hourly WAF poll in `apps/api/src/scheduled.ts` `runWafMetricsJob`, AECI-262) | `rule` (CF rule id), `action` (block / managed_challenge / …), `host`, `source` (ratelimit / firewallcustom) — **value is the event count, so query with `sum:`** (gotcha 3); only mitigation actions counted |
| `aeci.waf.poll` | count | `apps/api/src/scheduled.ts` (`runWafMetricsJob`, hourly cron, AECI-262) | `trigger` (cron), `outcome` (ok / failed / skipped_no_creds) — one heartbeat per run; the always-emitted `outcome:ok` series is the cron-liveness signal |
| `aeci.analytics_digest.email` | count | `apps/api/src/scheduled.ts` (`runAnalyticsDigestJob` → `lib/email.ts` `sendEmail`, AECI-526, daily 05:00 UTC = noon Jakarta cron) | `outcome` (sent / failed / skipped) — the daily operator digest: **human** page views + top products (`is_bot IS NOT 1`), new/total sign-ins, pending-moderation depth, and a Crawler-activity breakdown (`is_bot = 1`, grouped by `bot_name`). **`skipped`** when `RESEND_API_KEY` / `EMAIL_FROM` / `ANALYTICS_DIGEST_EMAIL_TO` are unset (fail-open); one count per run, so the always-emitted series doubles as the cron-liveness signal (`outcome:failed` also covers a pre-send crash) |
| `aeci.moderation.ban` | count | `apps/api/src/routes/admin-reviewers.ts` (`emitBanAction`, **AECI-218 / Phase 6.11**; `role` tag added **AECI-524** — the `PATCH /api/admin/reviewers/:id` ban/unban write-path) | `action` (`ban` / `unban`), `role` (`reviewer` / `vendor_admin` — the moderated seat's role), `outcome` (`ok` / `invalid_state` / `forbidden`) — one count per ban/unban attempt, alongside the §9 `appendAuditLog()` + `reviewer_ban` `workflow_transition` |
| `aeci.job_runs.write` | count | `apps/api/src/scheduled.ts` (`jobRunSink` → `lib/job-runs.ts`, **AECI-583 / Phase 8.3 P3.1**) | `phase` (start / finish), `job` (the `AdminCronJob` id), `outcome` (ok / failed) — this measures the **recorder, not the job**: a `failed` here means the admin panel's cron liveness under-reports while the job itself completed normally. Emitted on success too, so a silently-broken writer is distinguishable from "no crons ran". 36 series, ~245 points/day. Companion error log: `aeci.job_runs.write_failed`, `source:job-runs` |
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

Every metric also carries the base tags `env`, `app:aeci`, `service` (`aeci-web` /
`aeci-api`), `worker`, `locale` — the same vocabulary as the log `ddtags` string.

### `job_runs` is a second recording surface, not a replacement (AECI-583)

Since AECI-583 every cron also writes a `job_runs` row in D1 (`DATABASE_SCHEMA.md`
§9.4, `ADMIN_PANEL_SPEC.md` §7.2), and `/admin/system` renders it. That does **not**
retire anything below. The two surfaces answer different questions, and the split
is not a matter of taste:

- **Datadog owns absence.** The no-data monitors are the only signal that can fire
  when the Worker **never starts** — a job that does not run writes no `job_runs`
  row either, so its absence is invisible in D1 *by construction*. "The 08:00 sync
  stopped firing" is a Datadog question and always will be.
- **`job_runs` owns the record.** Outcome, duration, and a per-job payload, in
  product, no Datadog login, over a 90-day window. For the data-quality job that
  payload is the whole ten-check result set, which is a thing no metric can carry.

**The invariant a reviewer can check: every cron emits both.** A `job_runs` row with
no matching heartbeat, or a heartbeat with no row, is a bug in the instrumentation
— not a discrepancy to reconcile by hand.

| Cron | `job_runs.job` | Its Datadog liveness signal |
|---|---|---|
| 00:15 metrics snapshot | `metrics-snapshot` | `aeci.metrics_snapshot.run` (`outcome:success\|partial\|failed`) |
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
partial** (per-key and per-entity respectively), and Datadog models that as
`outcome:partial`. `job_runs.outcome` has no such member, so a partial run is
recorded `failed`, derived from the *same* `jobOutcome()` the metric tag uses. The
panel therefore never claims more success than Datadog does for the same run.

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
`(day, metric)` upsert. Until AECI-583's `job_runs` row lands, the always-emitted
`aeci.metrics_snapshot.run{trigger:cron}` series is the only liveness signal — watch it with
`notify_no_data` on a >24h window, the same always-reports pattern as the index-drift gauge.

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
(so a caller-reported `trace_id` pivots straight to the log).

**Since AECI-563 that router only sees the kick-off.** The commit runs in the promote Workflow, so a
`SLUG_CONFLICT` or an unexpected fault during the ingest never passes through `errorHandler` and would
otherwise vanish from Datadog. The Workflow logs it itself: an `error`-level
`aeci.api.promote.job_failed` under the same `source:review-app-promote`, carrying `job_id`, the error
`code`, and the reason — pivot on `job_id` rather than `trace_id` for those. Together with
`aeci.api.promote.job{outcome}` this keeps `REVIEW_APP_PROMOTE_API.md` §6.3's "every rejected promote
is in Datadog" true across both surfaces.

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

All of it is fire-and-forget over the shared transport (no-op without `DD_API_KEY`) and never
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

## Front-of-Worker cache: HIT observability (WC-8 / AECI-322)

Native Workers Cache (WC-3) serves cacheable HITs **without running the SSR Worker**, so
egress-time signals that used to re-run on every response don't fire on a HIT. This is by
design. Where each signal lives now:

- **HIT/MISS + edge HIT-rate** → the **`Cf-Cache-Status`** response header
  (`HIT`/`MISS`/`EXPIRED`/`BYPASS`/`DYNAMIC`) and the **Cloudflare Workers observability
  dashboard** (Workers & Pages → `aeci-web` → Observability). Datadog has **no** HIT-rate series
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

### `AECi Phase 2 — Traffic`

- **Definition (for record):** `observability/datadog/dashboard.json`
- **Live URL:** https://us5.datadoghq.com/dashboard/b5b-edd-gva/aeci-phase-2--traffic _(applied 2026-06-12 — AECI-222, the AECI-66/AECI-161 live-apply)._

Widgets: top routes by request count · **HIT-rate note** (edge HIT-rate → Cloudflare Workers
observability / `Cf-Cache-Status`; the old `cache_status:hit` widget was retired in WC-8) ·
p50/p95/p99 render per `route_class` · p95 API query per endpoint · 4xx/5xx error rate over
time · purge events by source.

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
applied in their own phase passes, AECI-279 (Phase 8.1) added two more (bringing the set to 23),
and AECI-584 (Phase 8.3 P3.2) added four for the retention prune; **WC-8 (AECI-322) retired the
cache-hit-rate monitor**, leaving the committed set at **26**. One exception to the handle rule: the informational
`monitor-data-quality-check-warn.json` (AECI-279) uses a distinct `@NOTIFICATION_CHANNEL_LOW_TBD`
placeholder — substitute a low-urgency handle, or leave it literal to keep that warn monitor
**UI-only / non-paging** (the daily digest already carries its rows).

| Monitor | Condition | Definition |
|---|---|---|
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
| Retention prune skipped (metrics_daily gap) | any `aeci.retention.prune{outcome:skipped}` > 0 (daily) — a day in the cut window has no snapshot, so nothing was deleted. **Non-paging**, but the long memory is at risk | `observability/datadog/monitor-retention-prune-skipped.json` |
| Retention prune deleted an unexpected number of rows | `sum:aeci.retention.rows_deleted` by `table` > 5,000 over 1d (`env:production`) — the §7.4 runaway guard. **Pages** | `observability/datadog/monitor-retention-prune-runaway.json` |
| Retention prune failed | `aeci.retention.prune{outcome:failed}` > 0 in the last 1d | `observability/datadog/monitor-retention-prune-failed.json` |
| Retention prune not running | no `aeci.retention.prune{trigger:cron}` heartbeat for ~26h | `observability/datadog/monitor-retention-prune-no-data.json` |

The **cache-hit-rate monitor was retired in WC-8 (AECI-322).** Under native Workers Cache a HIT
skips the Worker, so its `cache_status:hit` numerator is permanently ~0 — it would fire "cache hit
rate low" forever. Its JSON was deleted from `observability/datadog/`; **the live Datadog monitor
must also be deleted in the UI** (the committed JSON is for-record; the live monitor is source of
truth). Edge HIT-rate now lives on the Cloudflare Workers observability dashboard — see
"Front-of-Worker cache: HIT observability" above.

The p95-detail monitor is scoped to `cache_status:miss` on purpose: HITs are served
from the edge and would mask a genuinely slow render (and under native Workers Cache a MISS is
exactly "the Worker ran", so this monitor is unaffected by the front-of-Worker migration).

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

The generator visits ~20 representative pages (static / index / browse / detail) twice.
Under native Workers Cache the **first pass is a MISS (the Worker runs → a Datadog datapoint)** and
the **second pass is a front-of-Worker HIT that skips the Worker** — so pass 2 does **not** add a
second Datadog datapoint; confirm the HIT via the **`Cf-Cache-Status: HIT`** response header instead
(on preview/staging, where `cache.enabled` is on). Then check Datadog:

- Metrics Explorer: `aeci.page.render.duration_ms` (split by `cache_status` — expect `MISS` only —
  and `route_class`), `aeci.api.query.duration_ms` (split by `endpoint`), `aeci.cache.purge`.
- The dashboard should show data on the render / API / error-rate / purge widgets; the HIT-rate
  slot is now a note pointing to the Cloudflare Workers observability dashboard (WC-8).

---

## PostHog dashboards & alerts (AECI-647 / PH-6)

**Status: committed and applied to non-production only.** Everything above this line
describes the **live Datadog plane**, which stays canonical for the duration of the
dual-run window (`docs/POSTHOG_MIGRATION_SPEC.md` D1). This section describes its
PostHog replacement. AECI-648 (§AW7) rewrites the rest of this document; until then the
two planes are documented side by side on purpose — one is operating, one is staged.

**Source of truth: `observability/posthog/`.** Do not duplicate query text or thresholds
here; that directory is the applied-from-JSON contract, the same way
`observability/datadog/` was.

| File | What it is |
|---|---|
| `observability/posthog/README.md` | The **26-row monitor disposition table** (every Datadog monitor → its new home, with its retired threshold), the AW6 judgement calls, the migration hazards, the numbered manual steps and the operator checklist. |
| `observability/posthog/project-config.json` | Project topology + the twelve-cron liveness registry. |
| `observability/posthog/insights.json` | 7 dashboards, 43 insights. |
| `observability/posthog/alerts.json` | 13 alerts, each carrying the retired Datadog query verbatim. |
| `observability/posthog/apply.sh` | The applier. `--dry-run` / `--verify`; dashboards + insights to both projects, alerts to prod only. |

### Where the 26 monitors went

13 PostHog alerts (covering 16 monitors) · 8 to the external liveness sweep · 2 to the
existing daily digests · 2 dual monitors split across both. The per-monitor table with
old thresholds is in `observability/posthog/README.md`.

Three things changed in the port and are worth knowing before reading a number:

- **Cadence is hourly.** PostHog's `every_15_minutes` needs the Boost add-on and
  `real_time` needs Scale/Enterprise (spec D3). Four Datadog monitors evaluated at
  5–15 minutes; the Worker error-rate alert (5 min → 1 h) is the largest single
  degradation in the migration.
- **Ratio alerts gained minimum-denominator floors** (5 / 5 / 20 / 3 samples). New, and
  deliberate: at current volume one failed sign-in out of two is 50% and would page.
- **The WAF threshold was rescaled** 500/15 min → 2,000/1 h. Same sensitivity — the source
  is an hourly cron reading a whole clock hour, so the 15-minute window was always coarser
  than it looked.

### Absence detection moved out of the vendor entirely

No PostHog tier has `notify_no_data`. All eight absence monitors are replaced by
**`.github/workflows/posthog-liveness-sweep.yml`** (logic in
`scripts/ci/posthog-liveness-sweep.sh`), a scheduled GitHub Actions job that queries the
production project for a per-cron heartbeat every 3 hours and **fails red**.

It runs outside the Worker on purpose — that is the property that made "Datadog owns
absence" true, and a liveness check hosted inside the API Worker cannot detect the API
Worker being dead. **Do not add `continue-on-error` to it.** Every other telemetry step in
this repo is best-effort (`scripts/ci/posthog-deploy-marker.sh` always exits 0), so the
surrounding convention points the other way; the correct precedent is
`.github/workflows/reconcile-counts.yml`.

**New dependency, stated rather than discovered:** absence detection now depends on
GitHub Actions availability, which Datadog's server-side `notify_no_data` did not. The
per-cron windows in `project-config.json` carry margin for the sweep's own lateness
(26 h for daily jobs, 90 min for the 15-minute reconcile). `job_runs`, `/admin/system`
and the two daily digest emails remain an independent second record.

The sweep also **widens** coverage: Datadog watched six crons for absence; the sweep
watches all twelve.

### HogQL, not the metrics UI

Every insight is a `HogQLQuery` over `posthog.metrics` (or, for the two re-homed browser
search widgets, over `events`). PostHog Metrics is alpha and its insight builder is
unsettled, but the underlying table is fully queryable in SQL — so the alerts are ordinary
SQL insights with a threshold, which is a stable surface. Alert-source insights are
aggregates with **no `GROUP BY`**, so they always return exactly one row and a
healthy-but-empty window evaluates to `0` rather than to "no rows".

Three query conventions differ from the Datadog originals and fail **silently** if
forgotten — casing (`lower(cache_status)`; PostHog does not lowercase tag values as
Datadog did), no `env:` filter (the project is the tier boundary), and no
`aggregation_temporality` filter. The reasoning for each is in
`observability/posthog/README.md` §"Migration hazards".

### Applying

```bash
export POSTHOG_PERSONAL_API_KEY=phx_...       # or POSTHOG_CLI_API_KEY
./observability/posthog/apply.sh --dry-run    # plan only; no key needed
./observability/posthog/apply.sh              # apply
./observability/posthog/apply.sh --verify     # read-only drift report
```

Fix drift in the JSON and re-run — never in the UI, because the next run will not know.
`--verify` reports a live query that no longer matches the committed one.

**Live dashboards (non-production, project 525793):**
<https://us.posthog.com/project/525793/dashboard> — Traffic `2025785`, Search `2025786`,
Home/Stats `2025787`, Auth/Reviews/Moderation `2025788`, Requests/Linear `2025789`,
Cron health `2025790`, Alert signal sources `2025791`.

**Production (354071) is not yet applied** — it needs the `phx_` personal key, which is
still an outstanding operator step. Paste the production dashboard URLs here after the
first prod `apply.sh` run (spec §7). The full operator checklist is in
`observability/posthog/README.md`.
