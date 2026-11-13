# Runbooks

Operational response guides for AECi's alerts. Subscription, catalog and legal procedures live in
the other files in this folder. [`README.md`](./README.md) lists them all.

> **Keep the heading anchors stable.** Alert messages in `observability/posthog/alerts.json`, the
> CI workflows and other docs cite these headings by name.

> **Cloudflare account (2026-10-04, AECI-1161).** Every "Cloudflare dashboard" reference below means **The WBS Project** account (`004dc1af737b22a8aa83b3550fa9b9d3`) from the cutover. Workers Logs and workflow instance history before that date are on the old AEC Integrations account only, and the old account is deleted 30 days after the cutover. [ADR 0036](../adr/0036-move-to-the-wbs-project-cloudflare-account.md).

## Which console just paged you

**PostHog.** It is the only observability plane (ADR 0024). The alert set is
committed as `observability/posthog/alerts.json` and applied to the **production**
project (`aec-integrations`, 354071); alerts are deliberately production-only, so a
failing cron on staging or demo does not page anyone.

Two properties of the alert model matter mid-incident:

- **Alerts evaluate hourly.** Not every 5 minutes. If you are looking at a graph that
  is clearly bad and no alert has fired, that is expected within the hour — do not
  assume the alert is broken. A few are checked **daily** instead, because their window is a
  day or longer: `data-quality-error`, `indexnow-failure-rate` and the email-rate alerts. Each
  carries its reason in `observability/posthog/alerts.json`.
- **Nothing in PostHog detects absence.** "The 08:00 cron never ran" is caught by the
  **CI liveness sweep** (`.github/workflows/posthog-liveness-sweep.yml`, every 3 h),
  which fails red in GitHub Actions and emails. If a cron is silent, check that job's
  run history, not PostHog.

**Cloudflare email.** One page comes from Cloudflare, not PostHog: the "Logpush job
disabled" notification for the edge request log (ADR 0045). Runbook:
[Logpush job disabled](#logpush-job-disabled).

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
event** (`deploy_kind` ∈ `deploy` / `promote` / `auto_rollback`), which is
how you answer "did a deploy cause this" with a join rather than a guess.

## Alert → runbook

Every signal that can page you today, and the runbook for it. The PostHog alerts are committed in
`observability/posthog/alerts.json`, where each carries a `runbook` pointer to a heading below. Old
thresholds of retired alerts are in `observability/posthog/README.md` "Monitor disposition".

**PostHog alerts (production only, checked hourly unless marked daily).**

| Alert | Runbook |
|---|---|
| Worker error rate > 1% (1 h) | [High Worker error rate](#high-worker-error-rate) |
| p95 detail page render > 2.5 s (1 h) | [High p95 detail render](#high-p95-detail-render) |
| API requests stalled (5+ over 10 s, 1 h) | [API requests stalled](#api-requests-stalled) |
| Cron failure email not sent, or post-write sync failed | [A scheduled job failed](#a-scheduled-job-failed) |
| Data quality check found ERROR-severity issues (daily) | [Data quality job failed or not running](#data-quality-job-failed-or-not-running) |
| Retention prune runaway (> 5,000 rows/table/day) | [Retention prune skipped, failed, or not running](#retention-prune-skipped-failed-or-not-running) |
| Algolia orphan sweep capped | [Algolia index drift](#algolia-index-drift) |
| Linear reconciliation: persistent stuck requests | [Linear reconciliation — stuck requests](#linear-reconciliation--stuck-requests) |
| Linear pipeline failure rate > 50% (1 h) | [Linear pipeline failure](#linear-pipeline-failure-issue-creation--sync) |
| Linear webhook HMAC failures > 3 (1 h) | [Linear webhook HMAC failures](#linear-webhook-hmac-failures) |
| Auth sign-in error rate > 30% (1 h) | [Auth sign-in error-rate spike](#auth-sign-in-error-rate-spike) |
| Account record could not be created (any, 1 h) | [Account record could not be created at sign-in](#account-record-could-not-be-created-at-sign-in) |
| Account erasure left a sign-in record behind (any, 1 h) | [Erasure left an `auth.users` row behind](#erasure-left-an-authusers-row-behind) |
| Toxicity scoring outage (> 50% errors, 1 h) | [Toxicity scoring outage](#toxicity-scoring-outage) |
| page_views write error rate > 10% (1 h) | [Page-view writes failing](#page-view-writes-failing) |
| Raw page-view store missed a capture (any, 1 h) | [Raw page-view store missed a capture](#raw-page-view-store-missed-a-capture) |
| page_views archive failed or unbound (daily) | [page_views archive failed](#page_views-archive-failed) |
| Turnstile verdicts unknown > 20% (1 h) | [Turnstile verdicts unknown](#turnstile-verdicts-unknown) |
| WAF rate-limit / challenge spike (> 2,000 / 1 h) | [WAF rate-limit / challenge spike](#waf-rate-limit--challenge-spike) |
| Search-engine pings refused (> 90% over 72 h, daily) | [IndexNow submissions refused](#indexnow-submissions-refused) |
| The five email alerts: failure rate, volume spike, held back in production, bounce rate, complaint rate (daily) | No runbook here. `docs/email.md` for the transport and delivery webhooks, `docs/NOTIFICATIONS.md` for what each template is |

**Other signals.**

| Signal | Where it comes from | Runbook |
|---|---|---|
| `[AECi] Scheduled job failed: <job>` email | The Worker, after the last retry of any cron | [A scheduled job failed](#a-scheduled-job-failed), then the job's own runbook |
| A cron's heartbeat is missing or stale | The CI liveness sweep, every 3 h, fails red in GitHub Actions | [Cron runs missing or stuck in flight on `/admin/system`](#cron-runs-missing-or-stuck-in-flight-on-adminsystem) |
| "Logpush job disabled" email | Cloudflare | [Logpush job disabled](#logpush-job-disabled) |
| Promote strand audit fails red | GitHub Actions, daily | `docs/runbooks/catalog.md` "Promote strand audit is red" |
| Stripe reconcile changed subscriptions email | The Worker, daily | `docs/runbooks/subscriptions.md` "Stripe reconcile changed subscriptions" |
| Data-quality WARN findings, a skipped retention prune, Algolia drift, moderation backlog | The daily digests and PostHog dashboards. Not paged | [Data quality job failed or not running](#data-quality-job-failed-or-not-running), [Retention prune skipped, failed, or not running](#retention-prune-skipped-failed-or-not-running), [Algolia index drift](#algolia-index-drift), [Moderation queue backlog](#moderation-queue-backlog) |

### A scheduled job failed

**Signal:** a `[AECi] Scheduled job failed: <job>` email to `SUPPORT_EMAIL`
(`cron-job-failed-alert`, AECI-1587). It sends once per job, UTC day and failure reason, after
the last retry. It carries the reason, the deployed commit and the `job_runs` detail.

**Triage.**

1. Read the reason in the email.
2. Compare the deployed commit with `main`. A fix that has merged but not reached production
   fails the same way every day until it is promoted.
3. Open the job's own runbook below. `/admin/system` holds the full record (`job_runs`, 90-day
   window), and the PostHog dashboard **"AECi — Scheduled jobs and data cleanup"** holds the trend.

**The backstop alert:** `AECi — Cron failure email not sent, or post-write sync failed`. Its label column names one of three cases.

- **`failure email not sent: <job>`.** The job failed and the email did not go out. Check
  `/admin/system` for the job, then `RESEND_API_KEY`, `EMAIL_FROM` and `SUPPORT_EMAIL` on the
  production API Worker.
- **`aeci.algolia.sync (promote)` or `aeci.stats.compute... (promote)`.** A post-promote
  refresh failed. These run outside `withJobRun`, so no email goes out. Use the Algolia sync or
  home-stats runbook below.
- **`aeci.algolia.sync (vendor)`.** The by-id Algolia sync after an owner or admin write failed.
  The write committed, so the records are stale in search until the next daily sync picks them
  up. Find the entity and reason in the warn log for that route. Use the Algolia sync runbook
  below if the failure repeats.

A job that never ran sends no email. The CI liveness sweep owns that case.

### Two limits of the alert model

State these before an incident, not during one.

1. **Alert cadence is hourly at best.** PostHog's `every_15_minutes` needs the
   Boost add-on and `real_time` needs Scale/Enterprise. Plan detection time
   accordingly: a 5xx spike can run for an hour before anything pages. The
   escape hatch, if it bites, is PostHog's *log*-alert type — 5/10/15/30/60-minute
   windows, no add-on, max 20 per project (`observability/posthog/README.md`,
   manual step 4).
2. **Absence detection depends on GitHub Actions being up.** No PostHog tier has
   `notify_no_data`, so all eight no-data monitors are replaced by
   `.github/workflows/posthog-liveness-sweep.yml`, which runs every 3 hours
   **outside** the Worker, which a Worker-hosted check cannot be. If GitHub Actions is degraded, cron
   liveness is **unchecked**, and the sweep says so rather than passing: **exit 0** =
   all fourteen fresh, **exit 1** = a heartbeat is MISSING or STALE (with a
   `::error::` annotation naming the cron and its allowance), **exit 2** = the sweep
   could not run (PostHog 5xx, or no `POSTHOG_CLI_API_KEY`). **Exit 2 is red, not
   green — "the sweep could not run" is not "the crons are fine."** Never add
   `continue-on-error` to that workflow. The independent second record, when the
   sweep is dark, is `/admin/system` + the two daily digest emails.

Dashboard for the render / error-rate runbooks below: **AECi — Traffic, speed and errors**
in PostHog (URLs in `docs/OBSERVABILITY.md`). Edge cache HIT-rate is in **neither** — it lives on the
Cloudflare Workers observability dashboard (WC-8; see below).

---

## Sitemap is stale

**Symptom:** `/sitemap.xml` lacks a URL a write should have added, or still lists one a retire removed. No alert fires on staleness. The only alert-class signal is `sitemap-rebuild` going silent, which the CI liveness sweep catches (heartbeat `aeci.sitemap.rebuild.run`, allowance 90 minutes).

**How it works (AECI-1505).** Writers mark the sitemap dirty. The `sitemap-rebuild` cron runs at minutes 7, 22, 37 and 52, rebuilds only when `sitemap:dirty` is newer than `sitemap:built_at`, then purges the `sitemap` edge tag once. A write shows up within 15 minutes plus the edge purge. The `0 5 * * *` digest also marks dirty, so the 05:07 tick rebuilds daily. Mechanism and keys: `CACHE_STRATEGY.md` §5, "The sitemap rebuild".

1. **Check the job.** Open `/admin/system` and read the `sitemap-rebuild` row. `skipped` with reason `not_dirty` is a healthy quiet tick. `ok` carries `builtAt`, `urlCount` and `base` in its detail. `failed` means the build threw. The queue retries, nothing was stored or purged, and the old build keeps serving. Read the API Worker logs for the error. A cron added in the last 15 minutes can have missed its first tick, which is not a defect.
2. **Read the two markers.** Run these from `apps/api`. Use the block for the env you are checking. The first command prints the time of the newest URL-changing write. The second prints the time the stored build started. A build is current when `sitemap:built_at` is later than `sitemap:dirty`.

   ```bash
   pnpm exec wrangler kv key get sitemap:dirty --binding TAXONOMY_KV --env production --remote
   ```

   ```bash
   pnpm exec wrangler kv key get sitemap:built_at --binding TAXONOMY_KV --env production --remote
   ```

   For staging or demo, change `production` to `staging` or `demo`.
3. **Force a rebuild.** Put `sitemap:dirty` to the current time. The next tick rebuilds and purges. Do this after a change that moves URLs without a write, such as an API deploy that changes the trade floor.

   ```bash
   pnpm exec wrangler kv key put sitemap:dirty "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" --binding TAXONOMY_KV --env production --remote
   ```

4. **The retraction CLI does not mark dirty.** `apps/api/scripts/retract-product.ts` removes URLs without touching `sitemap:dirty`. After a retraction, put the marker as in step 3, or wait for the 05:07 tick.
5. **Dirty is older than built_at but the edge copy is old.** The build is right and the edge copy has not been purged. The rebuild's purge may have failed to enqueue, which only logs a warning. The edge copy ages out within its hour. To skip the wait, run `POST /admin/purge` with the tag `sitemap`.

The first read after the first deploy in an env finds no stored build and builds inline, so that one request is slow.

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

## Native cache rollback

Use this when a tier's native Workers Cache serves something wrong and a purge does not fix it.
Cached tiers (AECI-1443): staging, demo and production. Demo was enabled on 2026-10-21 and
production by the second AECI-1443 change.

1. Delete that env's `exports` block in `apps/web/wrangler.jsonc`. Leave the top-level block alone.
2. Merge, then deploy the tier: staging deploys from `main`; demo and production go through
   `promote-to-demo` and `promote-to-prod` (`docs/environments.md`).
3. HITs stop at that deploy. Each Worker version is its own cache namespace
   (`cross_version_cache` off), so the new uncached version never reads the old copies. Those
   copies expire on their own TTL, 15 minutes for detail pages (`docs/CACHE_STRATEGY.md` §4).
4. Confirm with `Cf-Cache-Status` on a detail page: it should no longer read `HIT`.

Any curl check of `Cf-Cache-Status` needs a browser user agent, for example
`curl -sI -A 'Mozilla/5.0' https://www.aecintegrations.com/`. A bare curl gets a Cloudflare challenge instead. That is a 403
with `cf-mitigated: challenge`, and it never shows `cf-cache-status`.

The purge queue consumer stays wired. With no cache it acks each message as
`outcome:no_cache`. Background: ADR 0020, 2026-10-21 amendment.

---

## High p95 detail render

**Alert:** `AECi — p95 detail page render > 2.5 s (1 h)`, 2,500 ms threshold, hourly.
**Metric:** `aeci.page.render.duration_ms{route_class:detail,cache_status:miss}` p95.
**Sample floor:** an hour with fewer than 40 MISS detail renders reads 0 and cannot fire
(AECI-1137; the floor was 20 until 2026-09-28). The label column shows the hour's count.

> **How to read the number.** PostHog stores render times as histogram buckets
> (bounds `5,10,25,50,75,100,250,500,750,1000,1500,2500,5000,7500,10000` ms), so the
> insight reports the **upper edge of the bucket the 95th observation fell in**, not an
> exact p95. `2500` means the slowest 5% were between 1.5 and 2.5 s. PostHog's upper bound
> is **strict**, so `2500` does not fire; a firing means the value read `5000` or more,
> i.e. the true p95 is above 2.5 s. The arithmetic was verified against the raw buckets
> on production on 2026-09-10 (`observability/posthog/README.md` manual step 2).
>
> **Why the threshold is 2500, not 1500.** The alert was 1500 ms until it became the
> alert's typical reading. Production ran with no edge cache until AECI-1443, so every
> detail render was a MISS and reached this series (50–800 renders/hour); the cache flip
> changed that for about 2.5% of detail GETs only, so volume did not fall. The 95th
> observation landed in the 1000–1500 bucket in about a third of all hours, so the alert
> read `1500` ("Not firing") as its normal state and only moved when it jumped to the next
> band. Raising to 2500 means the alert fires on true p95 above 2.5 s, which is the signal
> we want. The remaining latency in the 1.5–2.5 s range is the cold isolate, tracked as
> **AECI-1575**; a MISS in a colo with no MISS in the previous 10 s takes about 1,400 ms
> at p50 and about 350 ms when the previous MISS was under 1 s earlier.
>
> For everyday reading prefer the Traffic board tile *Page speed spread — how many were
> fast, how many were slow*, which is a straight read of the bucket counts.

**What it means:** Server render of detail pages on a cache MISS is slow. Scoped to
MISS because HITs are edge-served and don't reflect render cost. Under native Workers Cache a MISS
is exactly "the Worker ran", so this alert is **unaffected** by the front-of-Worker migration
(WC-3/WC-8) — it keeps measuring real render cost.

**First checks**

0. **Where is the production D1?** Run this from `apps/api`, so wrangler resolves the
   name through the production binding:

   ```bash
   env -u CLOUDFLARE_API_TOKEN pnpm exec wrangler d1 info aeci-app-production --env production
   ```

   `uuid` must be `1f4378db-dabb-4724-b5b8-d0a9ab6c6a3b` and `running_in_region` must
   say `ENAM`. Most traffic is US. Every D1 query from a US request travels to the
   database's region and back, so a far region slows every render. Production ran in
   APAC from the 2026-10-04 account move until the AECI-839 move. If the uuid is
   `3bbbd4ca…` or the region is `APAC`, the binding points at the retired copy. Checking
   `aeci-app-production-us` by name proves nothing here, because that database is always
   ENAM whatever the binding says. See `scripts/ops/2026-10-prod-d1-us-move/README.md`.

0b. **Is placement active on the API Worker?** Production's API Worker runs under
   targeted placement (`placement.region: aws:us-east-1`), from AECI-839. It stays unless
   evidence shows the location is wrong (Chris, 2026-11-02). The API is private, so you cannot curl it. Open the Cloudflare dashboard at Workers →
   `aeci-api-production` → Settings and confirm placement targets `aws:us-east-1`.
   Targeted placement has no analysis period, so there is nothing to wait for. A
   `cf-placement` header of `remote-XXX` means a Worker ran away from the visitor's
   colo. `local-XXX` means it ran at the edge. A production page response does not
   show the API's value. That header belongs to the SSR Worker, which is never placed. The visitor's colo stays the same either way. Read it
   from the edge request log (`docs/ANALYTICS.md` §11a). Workers Logs no longer carries
   `$workers.event.request.cf.colo`, because invocation logs are off since AECI-1594.

   Judge the pin by API handler time, `aeci.api.query.duration_ms`. Production, excluding
   the 2026-10-28 IAD incident:

   | Endpoint | Before the pin, p50 / p95 band | Pin and cache, p50 / p95 band |
   | --- | --- | --- |
   | `/api/products/:slug` | 250 / 1000 ms | 75 / 500 ms |
   | `/api/vendors/:slug` | 50 / 750 ms | 25 / 100 ms |
   | `/api/integrations` | 100 / 500 ms | 75 / 250 ms |

   Do not judge it by gateway wall time. The gateway writes the arrival row since AECI-1297,
   and its wall time likely includes that background work. AECI-1575 replaces this test.
   The pin has one cost: an IAD incident slows every production API request (AECI-1527).

1. Is the API slow? Check `p95:aeci.api.query.duration_ms by {endpoint}` for the detail
   endpoints (`/api/products/:slug`, `/api/vendors/:slug`, `/api/integrations/:id`).
2. D1 health: the API's `db.batch` / query spans in the logs (`service:aeci-api`) and
   the Cloudflare D1 dashboard. (Supabase is Auth-only and is not on the render path.)
3. Recent deploy to `apps/web`? An Angular SSR regression (heavy resolver, blocking
   work) can inflate render time — correlate with `GET /api/version`.
4. Is it global or one entity? A single slow slug points at data shape, not the platform.
5. **Was it a scanner burst?** A few slow renders inside one minute, with no deploy and a
   normal API, is often a probe burst loading the Worker. On 2026-09-27 a 16:02 UTC burst of
   secret-file 404s pushed 8 detail renders to about 1.8 s and fired this alert. Check the
   Worker's invocation graph for a spike at the same minute, then see
   [Scanner probes reaching the Worker](#scanner-probes-reaching-the-worker).

**Escalation:** Sustained > 2.5s with a slow API → investigate the query/DB. With a fast
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
**dashboard** read (PostHog "AECi — Search" → *Is Algolia out of step with our database?*)
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
self-heals** (AECI-266) and the next day's run reads 0.

**Positive** drift is *not* auto-repaired, and the 08:00 incremental sync is only a partial fix
(corrected by AECI-789 — this runbook previously said the sync repaired it outright). That sync is
watermark-windowed: it re-upserts only rows whose own `updated_at` falls in `(watermark, cutoff]`,
and the watermark advances on every successful run. **A record missing from the index whose row was
last touched before the watermark will never be re-pushed by the cron, no matter how many times it
runs.** Repairing that needs a full index rebuild, or a write that bumps the row's `updated_at`.

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
- **Positive drift (missing rows):** the 08:00 incremental sync repairs only what is still inside
  its watermark window. A row updated within the window is re-upserted on the next run; a record
  stuck outside it re-syncs only when something next touches it (e.g. a re-promote). **Waiting for
  another sync is not a repair for anything older than the watermark.**

  The real repair is a full index rebuild via the Access-gated `apps/datatool` Worker, which
  rebuilds from D1 and purges edge cache afterwards. It covers all four tiers, `demo` included —
  the drift CLI above does not (`--env` accepts `staging|production` only):

  ```
  POST /api/reindex   { "target": "demo", "entities": ["integrations"] }
  ```

  Omit `entities` to rebuild all three indexes. (The Node bulk-reindex CLI referenced here before
  was retired under D1, ADR 0016, and the "Worker-triggered full re-sync is a tracked follow-up"
  note this replaces was stale — it shipped.)

  **Before rebuilding the `integrations` index, confirm the deploy carries AECI-789.** The 09:00
  orphan sweep's membership id-set was single-table until then, so on a pre-AECI-789 Worker the
  09:00 sweep deletes every `connector_evidenced_pairs` object the rebuild just wrote, and the
  watermark-windowed 08:00 sync does not put them back — the rebuild is undone within a day and
  has to be repeated after the fix ships.

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
**After AECI-1587:** the failure half is the Worker's `cron-job-failed-alert` email. It was the combined `AECi — Cron job failed (any
daily/hourly job)` alert — read the `label_column` in the breach email to see it was this job —
and it becomes **trigger-agnostic**, so a failed `trigger:promote` sync alerts too. The liveness half moves to the **CI
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
   (a graceful no-op, not a failure) — expected on local dev, never on staging/production.
4. Algolia status? Check https://status.algolia.com — an Algolia outage surfaces as transient
   push failures that self-heal on the next run.
5. Liveness alert ("sync not running"): this is the no-data variant of the `outcome:ok`
   cron series — the 08:00 UTC (= 03:00 EST) cron (`apps/api/src/scheduled.ts`) hasn't reported a successful
   push for 48h, so it likely isn't firing. Check the staging/production API Worker's scheduled
   invocation in the Cloudflare dashboard / `wrangler tail`. (The "sync failed" alert does not
   use no-data — `outcome:failed` is absent on a healthy run.)

**Repair:** a failed entity is retried by the next daily cron (the watermark wasn't advanced).
There is no bulk-sync CLI. The AECI-138 `db:algolia-bulk-sync` script never landed (AECI-1039).
Two repair paths exist instead.

- **Records missing, index otherwise correct:** reset that entity's watermark so the next
  08:00 UTC run sweeps it whole without emptying the index. Procedure and flags:
  `docs/SEARCH_RANKING.md` §1.2. The production dry run for `integrations` is below. Swap
  `--entity` for `products` or `vendors`, and add `--apply --allow-production` to write.
- **Records must be rebuilt now:** the datatool reindex (`apps/datatool`, "Reindex now").
  It clears the index first, so search returns zero hits until it finishes. Run it off-peak.

```bash
node scripts/ops/2026-09-algolia-integration-watermark-reset/reset-watermark.mjs --env production --entity integrations
```

**Escalation:** failures across multiple consecutive runs with Algolia healthy point at a data
shape / transform regression (`apps/api/src/lib/algolia-sync.ts`) or a rotated admin key — page
on-call and capture a failing `reason` from the logs for the post-mortem.

---

## Home stats stale or compute failed

**Alerts (PostHog, hourly):** `AECi — Home stats compute failed (daily cron)` (one or more `home.*`
keys failed) and `AECi — Home stats not running (no daily compute)` (the cron stopped firing — the
freshness alert). **After AECI-1587:** the failure half is the `cron-job-failed-alert`
email, which names the job and the reason. It also covers a failed per-key compute. The freshness half moves to the **CI liveness sweep** (`home-stats`, 26 h).
**Metric:** `aeci.stats.compute.key{outcome:failed}` (failed per-key computes) **+** the job-level
`aeci.stats.compute{outcome:failed}` count — the job-level term covers a pre-compute crash that
emits no per-key points. The freshness/liveness alert watches the `aeci.stats.compute{trigger:cron}`
heartbeat (one point per completed run, any outcome) via `notify_no_data` instead (AECI-178 compute;
AECI-180 monitors).
Companion signals: `aeci.stats.compute{outcome:success|partial|failed}` (job rollup),
`aeci.stats.compute.duration_ms` + `aeci.stats.compute.key.duration_ms` per run.

**What it means:** The daily home-stats compute (`apps/api/src/scheduled.ts` → `lib/home-stats.ts`,
07:00 UTC = 02:00 EST) recomputes the eleven `home.*` `stats_cache` rows. Each
key computes/validates/upserts independently, so a single failed key leaves **that** cached value
stale (or absent) while the rest refresh — e.g. a failed `home.popular_products` keeps yesterday's
"Popular:" row. The home page never errors; it just serves the last good numbers. The "not running" freshness
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

**Alert:** `AECi — page_views write error rate > 10% (1 h)` — PostHog, hourly. 10%
threshold, with a **≥20-write minimum-denominator floor**
(`if(total >= 20, ratio, 0.0)`), so a quiet hour reads 0 instead of paging on one failure out of
three.
**Metric:** `aeci.pageviews.write{outcome:failed}` / `aeci.pageviews.write` (all) — the failed-insert
ratio over 10m (AECI-177 write; AECI-180 monitor). Companion signal: the `aeci.api.page_view.capture_failed`
log carries the `reason`.

**What it means:** `POST /api/page-views` validates the body, returns **204 immediately**, and
inserts one `page_views` row via `ctx.waitUntil()`. A failing insert is **user-invisible** (the 204
already went out) — but `page_views` is the **only** source for `home.trending_products` and
`home.popular_products`, so a sustained insert regression silently **zeroes both** at the next 07:00 UTC
daily compute (popular drains more slowly, over its 30-day window). This
monitor exists to surface the regression *before* the home page changes. (Distinct from "Home
stats compute failed": there the compute job breaks; here the upstream data the compute reads stops
arriving.)

An empty `home.popular_products` switches the hero's "Popular:" row to the five largest categories
(AECI-1572). That happens by design when no product clears the `TRENDING_MIN_VIEWS` floor (currently 3)
in a low-traffic window, so category links there look the same as a write regression. That is why this write-rate metric, not the home's appearance,
is the alerting signal. Corollary when triaging: a short "Popular:" row, or one that names categories, is **not** on its own
evidence of a page-views regression; confirm against `aeci.pageviews.write{outcome:failed}`.

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

## Raw page-view store missed a capture

**Alert:** `AECi — Raw page-view store missed a capture (any, 1 h)` (`pageviews-raw-unsent`, AECI-1384) —
PostHog, hourly, production only. It fires when `aeci.pageviews.raw` has any `outcome:failed` or
`outcome:skipped` in the last hour. Not applied until `apply.sh` is run (Chris's step).

**What it means:** every capture that reaches the API writes a raw JSON envelope to the `PAGE_VIEW_RAW`
Pipelines stream, which lands in the `aeci-page-views-raw-<env>` R2 bucket (ADR 0041). The D1 `page_views`
row and every traffic figure are fine. The hole is in the backup.

- **`failed`**: `stream.send()` threw, or the envelope could not be built. The log
  `aeci.api.page_view.raw_failed` carries the `reason` and the D1 `outcome`.
- **`skipped`**: the `PAGE_VIEW_RAW` binding is absent from the deployed config. In production that
  means the `pipelines` entry was lost from `apps/api/wrangler.jsonc`. It is normal on demo and locally.

**First checks**

1. Read the failure: PostHog logs, `service:aeci-api source:page-views`, message
   `aeci.api.page_view.raw_failed`.
2. Confirm the binding is in the deployed config: the production block of `apps/api/wrangler.jsonc` must
   carry `"pipelines": [{ "binding": "PAGE_VIEW_RAW", "stream": "<id>" }]`. Bindings are not inherited
   between wrangler environments. `GET /api/version` names the deployed commit to check against.
3. Confirm the stream still exists: `wrangler pipelines streams get <stream id>` (read only). Also check
   the sink and pipeline still point at `aeci-page-views-raw-production`.
4. Recent deploy or Cloudflare incident? A step change right after a deploy points at the config. A
   scatter of `failed` points at Pipelines itself.

**Impact:** a missed envelope is gone. Nothing queues or retries it, and the `page_views` row cannot
recreate the raw headers or `request.cf`. The gap matters only for a later back-fill from source.

**Repair:** restore the binding or the stream and deploy. New captures resume at once. There is no
back-fill. Note the window in the issue so a later rebuild knows the hole exists. Do not "fix" it by
making the D1 write wait on the raw write.

## page_views archive failed

**Alert:** `AECi — page_views archive failed or unbound (any, 24 h)` (`pageviews-archive-failed`,
AECI-1228). PostHog, daily, production only. It fires when `aeci.pageviews.archive` has any
`outcome:failed` or `outcome:archive_unbound` in the last 24 hours. Not applied until `apply.sh` is
run (Chris's step).

**What it means:** the 03:00 retention job copies each `page_views` day to the permanent R2 archive
at 371 days old, before the 400-day prune may delete it (ADR 0050, `ADMIN_PANEL_SPEC.md` §7.4 rule 5).
The D1 rows are untouched either way.

- **`failed`**: a day was not copied and confirmed, or the step crashed. No ledger row was written, so
  the next night retries the day. A day has 29 nights of retries before the prune needs it.
- **`archive_unbound`**: the production config has no `PAGE_VIEWS_ARCHIVE` binding. The prune then
  refuses every `page_views` day it would delete, so pruning stops until the binding is back.

**First checks**

1. Read the failure: PostHog logs, `source:retention-prune-cron`, message
   `aeci.pageviews.archive.failed` (the days and one reason per day) or `aeci.pageviews.archive.crashed`.
   The `retention-prune` row in `job_runs` carries the same in `detail.archive`.
2. Read the reason. `put_refused` or a thrown R2 error points at R2 or the bucket. `head_mismatch` means
   R2 stored something other than what was sent. `count_changed` means rows for that day were written or
   deleted during the copy, which should not happen at 371 days old.
3. For `archive_unbound`, confirm the production block of `apps/api/wrangler.jsonc` carries
   `{ "binding": "PAGE_VIEWS_ARCHIVE", "bucket_name": "aeci-page-views-archive-production" }` in
   `r2_buckets`, and that the bucket still exists. `GET /api/version` names the deployed commit.

**Repair:** fix the cause and wait for the next 03:00 run. It retries every unconfirmed day, 7 a night,
oldest first. Never add a lifecycle rule to the archive bucket. Never insert a ledger row by hand: a
ledger row is what lets the prune delete the day.

## Turnstile verdicts unknown

**Alert:** `AECi — Turnstile verdicts unknown > 20% (1 h)` (`pageviews-turnstile-unknown`, AECI-1457).
PostHog, hourly, production only. It fires when `unknown` is over 20% of `pass + fail + unknown` on
`aeci.pageviews.turnstile` in the last hour, once at least 20 verdicts ran. Not applied until
`apply.sh` is run (Chris's step). Silent on a tier with no `TURNSTILE_SITE_KEY`: its beacons carry no
token and count as `verdict:absent`, which the ratio excludes. Production carries a site key since
AECI-1581, so it can fire there once applied. An excluded visitor's beacon also counts as `verdict:absent`.

**What it means:** the API asked Cloudflare's siteverify about a Turnstile token and got no usable
answer. Every page view is still written. Its `turnstile_verdict` is `unknown`, which the traffic
classifier never reads as automation evidence (ADR 0049). The cost is lost evidence, not lost rows.

**First checks**

1. **Check the secret first.** A share near 100% almost always means siteverify refuses the secret.
   `TURNSTILE_SECRET_KEY` on the API Worker must belong to the same widget as the web Worker's
   `TURNSTILE_SITE_KEY` for that env. A rotated widget, a typo, or a staging secret on production all
   look like this. List the secret names on the env (read only):

```bash
wrangler secret list --env production
```

   Run it from `apps/api`. Compare the widget in the Cloudflare dashboard under Turnstile. CI pushes
   the secret on every deploy from the GH secret `TURNSTILE_SECRET_KEY_STAGING`, `_DEMO` or
   `_PRODUCTION` (ruling 2026-10-29). Fix the GH secret and redeploy. A `wrangler secret put` by hand
   is overwritten by the next deploy.
2. **Siteverify itself.** A partial share (20 to 60%) with the secret right points at Cloudflare, or at our 4 s timeout. A local run saw 2 of 14 calls time out, so the threshold is not yet trusted. Compare with the staging share before acting. Check
   the Cloudflare status page for Turnstile. `lib/turnstile.ts` maps a timeout over 4 s, a non-2xx and a
   network error to `unknown`.
3. **Spent tokens.** `timeout-or-duplicate` is also `unknown`. A client that reuses a token, or a token
   older than 300 s, earns it. A rise right after a web deploy points at `TurnstileService` reusing a
   token. Each token must be used once.
4. **Split by writer.** Read the source insight `alert-pageviews-turnstile-unknown`, then split
   `writer:spa` from `writer:arrival`. One writer alone points at that path's code, not the secret.

**Impact:** rows written in the window carry `unknown` and keep it. Nothing re-verifies them, because
a token is single-use.

**Repair:** fix or re-put the secret, or wait out the Cloudflare incident. New views verify at once.
Do not make the page-view write wait on siteverify, and do not drop `unknown` rows.

## Logpush job disabled

**Alert:** Cloudflare's "Failing Logpush Job Disabled" notification (policy "AECi edge log: Logpush job
disabled", alert type `failing_logpush_job_disabled_alert`), by email to Chris (AECI-1447). Cloudflare sends
it after a job has failed to push for more than 24 hours and been disabled. It is not a PostHog alert and
has no row in the table above.

**What it means:** Cloudflare stopped one of the two Logpush jobs that write the edge request log to
`aeci-edge-log-prod-us` (ADR 0045). It does this after deliveries keep failing. The site and every
`page_views` figure are fine. The hole is in the permanent copy of Cloudflare's request record.

**First checks**

1. Which job: the email gives the destination. Its path starts `http_requests/` (job `1978506`) or
   `firewall_events/` (job `1978507`).
2. Read its state from the zone Logpush API, `GET /zones/<zone id>/logpush/jobs/<job id>`. Look at
   `enabled`, `last_complete` and `last_error`. The job ids are in `environments.md` "Edge request log".
   The AECI-1447 one-off token is revoked after setup. A read needs a token with zone Logs Read or Logs Edit. The
   request is in `scripts/ops/2026-10-edge-log-logpush/README.md` step 3.
3. Confirm the bucket still exists and the destination credentials still work. A deleted bucket or a
   revoked R2 token is the usual cause.

**Impact:** Logpush never back-fills. Every hour the job is off is missing from the log unless a GraphQL
pull recovers it. Cloudflare keeps requests for 90 days and firewall events for only 31.

**Repair:**

1. Fix the cause and re-enable the job through the same API, `PUT … { "enabled": true }`. This needs a
   token with zone Logs Edit. Create a one-off token and revoke it afterwards, as when the jobs were
   created. If the cause is a revoked R2 token, create a new bucket-scoped Object Read & Write R2 token
   and `PUT` a new `destination_conf` with its key pair. Do not revoke that one.
2. Fill the gap from GraphQL with `scripts/ops/2026-10-traffic-history/pull.mjs`, before the 31-day or
   90-day limit. Upload the output under `graphql-backfill/` in the same bucket.
3. Note the window and how it was filled in the issue.

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

**Alert:** `AECi — Auth sign-in error rate > 30% (1 h)` — PostHog, hourly. 30%
threshold, with a **≥5-attempt floor**. The floor is deliberate: at current volume one failed
sign-in out of two is 50% and would page.
**Metric:** `aeci.auth.signin{outcome:failed}` / `aeci.auth.signin` (all) — the failed-completion ratio
over 15m, `service:aeci-web` (AECI-206). `attempts = sum over outcomes`; failure `reason` ∈
`link_invalid` / `missing_code` / `auth_not_configured`. The user lands on `/auth/login?error=<reason>`,
which shows a notice for each reason (AECI-1100), so a report of "it said my link expired" is `link_invalid`.

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

**Alert:** `AECi — Toxicity scoring outage (> 50% errors, 1 h)` — PostHog, hourly. 50%
threshold, with a **≥5-call floor**.
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
(threshold plus a `notify_no_data` cron-liveness check) was retired in AECI-651.

> **The backlog does not alert.** It is a **dashboard** read
> (PostHog "AECi — Sign-ins, reviews and moderation" → *Moderation queue — how deep, and how
> long the oldest has waited*), and the liveness half moves to the **CI liveness sweep** (`moderation-snapshot`, 26 h).
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
PostHog, hourly. 1 h window, 50% threshold, with a **≥3-attempt floor**. Traffic-driven, so
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
2. **Why?** Pivot the failing metric by `reason`: `http_error 401/403` → `LINEAR_API_KEY` revoked or
   over-scope (`wrangler secret list` on the Worker; a **missing** key produces no metric at all, and
   since AECI-851 the prod promote fails closed on one, so 401/403 here means the key is present but
   bad); `graphql_error` → a bad label/assignee/project/state
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
PostHog, hourly. It stays
its own alert rather than folding into the cron-failure email, because it is a **security**
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

## Claim ticket un-started after 24 hours

**Email:** `[AECi] N claim tickets un-started after 24h` → `SUPPORT_EMAIL`
(`support@aecintegrations.com`; it went to `founders@thewbsproject.com` before AECI-1220). Emitted by the `25 */6` `claim-stale-check` cron
(`apps/api/src/lib/claim-stale-check.ts`, AECI-862).

**Production only since AECI-1220.** The alert is `envRule: 'production-only'`, so staging and
demo suppress it (`outcome:suppressed`). Their crons still run and still emit every metric,
so a demo claim left un-started is visible in `aeci.linear.claim_stale.stale` without
mailing anyone. If this alert arrives carrying a `demo.aecintegrations.com` admin link, the
tier rule has been removed from the registry entry.

**Nothing is broken.** That is the whole point of this being a separate message to a separate
address. `stuck-request-alert` below means the pipeline failed and the operator must fix it. This
one means the pipeline worked, the ticket exists in Linear, and no human has picked it up. The
action is to triage the ticket, not to restart a job.

**A row marked "Closed in Linear" (AECI-1421).** The ticket is Done or Canceled, but the claim is
still undecided. The claim can be `open` or `in_review`: starting the ticket first moves it to
`in_review`, and the later Done changes nothing. Closing a claim's ticket does not decide the
claim: the webhook writes nothing for it, by design. Open the Administer link and Grant or Reject the claim there. That closes the
ticket again on its own, and the row drops out of the next run.

**Metrics:** `aeci.linear.claim_stale.stale` (gauge, the finding) and
`aeci.linear.claim_stale.checked` (gauge, the population). Read them **together** — "0 stale" out of
0 eligible and "0 stale" out of 40 eligible are different facts. `aeci.linear.claim_stale.job`
(`outcome:ok|failed`) is liveness only: **a run that finds ten stale tickets is `outcome:ok`.**

### Triage

1. Open each ticket from the **Linear** link in the email. Move it to In Progress, Done or Canceled.
   Any of the three silences it, because the check tests `state.type` for
   `started` / `completed` / `canceled`, not for a specific state name.
2. If the claim needs evidence rather than a decision, open the **Administer** link
   (`/admin/claims/:id`) — that is where the claimant's LinkedIn profile, the `domain_match` signal
   and the operator note live.
3. To park a claim deliberately (the §5.2 pure-connector case in
   `STAGE_2_VENDOR_PORTAL_SPEC.md`), write the operator note AND move the Linear ticket out of
   Backlog. Leaving it in Backlog is what keeps the warning firing.

### If the numbers look wrong

| Symptom | Cause | Action |
|---|---|---|
| `read_failure{reason:no_api_key}` on a non-prod tier | Expected. AECI-851 provisions `LINEAR_API_KEY` on production only | None. It logs at `info` there, not `warn` |
| `read_failure` with a transport reason in production | Linear was unreachable this run. **No warning was sent, and `stale` is 0 because nothing was asserted** — not because nothing is stale | Check Linear's status. The next run re-derives everything; no state is lost |
| `webhook_drift` sustained non-zero | Linear reports the ticket started, but `vendor_requests.status` is still `open`. The §6.3 inbound webhook is not delivering. A closed ticket is not drift since AECI-1421: it is listed in the digest as "Closed in Linear" | Check `LINEAR_WEBHOOK_SIGNING_SECRET` on the production API Worker and whether a webhook is registered in Linear at `POST /api/webhooks/linear` — still the open operator action on AECI-851. **This job never repairs the row**, by design |
| `stale > 0` but no email arrived | Band throttling, working as intended: one email as the ticket crosses 24 h, then one a day | None. Unthrottled this would send four a day per ticket, against the Resend account that also carries Supabase magic links |
| `outcome:duplicate` on `stale-claim-ticket-alert` | A second run in the same window (a double cron tick) rebuilt the same `stale-claim-ticket-alert:{requestId}:{bandIndex}` key, so the send ledger refused it (AECI-1203) | None. The first run's email is the one that counts |
| A ticket you already closed is still listed | The digest was composed from the state at run time | It drops out of the next run |

### Tuning

`STALE_THRESHOLD_HOURS` (24) is a **business-response** threshold, not a system one. Lower it if
vendors complain about reply latency; raise it if founders are being paged for tickets that are
deliberately parked. `STALE_CHECK_INTERVAL_MINUTES` **must** stay equal to `CLAIM_STALE_CRON` —
`claim-stale-check.spec.ts` asserts the pair, because the email bands are computed from the cadence
and a silent drift would either double-send or skip a band with nothing failing.

## Linear reconciliation — stuck requests

**Alert:** `AECi — Linear reconciliation: persistent stuck requests` (PostHog, hourly). Two
monitors used to share this runbook — that one
(the persistent-failure signal; deliberately **no** `notify_no_data` — the count is emitted only when the
failure condition holds, so zero points is healthy) and its liveness companion `AECi — Linear
reconciliation sweep not running` (AECI-219 / Phase 6.12; a `notify_no_data` check on the always-emitted
`aeci.linear.reconcile.stuck` gauge — no point for ~1h ≈ 4 missed sweeps means the cron itself stalled).

> **After AECI-651** the persistent-failure half stays its **own** PostHog alert rather than folding
> into the cron-failure email — the sweep is healthy; a **user-visible vendor request** is
> stuck, and the operator action is to open that request, not to restart a job. The liveness half
> moves to the **CI liveness sweep** (`request-reconcile`), whose window is **relaxed 60 → 90 min**.
> The extra 30 minutes is margin for the *sweep's own* lateness, not the job's — the sweep runs every
> 3 hours, so a 60-minute allowance would false-positive on the checker rather than the checked.
**Metric:** `aeci.linear.reconcile.persistent_failure` (count) — requests stuck past the persistent
threshold (~60m) AND still failing after a retry; companion `aeci.linear.reconcile.stuck` (backlog
gauge) and `aeci.linear.reconcile.attempt` (`outcome:cleared|still_failing`). Emitted by the
reconciliation sweep, `lib/reconciliation-sweep.ts` (AECI-214 / Phase 6.7), every 15 min. The
`level:error` `source:reconcile` log carries the stuck `request_ids` **and, since AECI-854, a
parallel `reasons` array** — read that first, it usually ends the investigation.

> **AECI-854: the email and the metric now have different cadences. Read the email's absence
> correctly.** The metric and the error log still fire on **every** sweep — they are the §6.2
> guaranteed backstop and this alert's input, and nothing throttles them. The **email** is
> band-throttled: one at 60 min, one at 6 h, then one a day. So `persistent_failure > 0` with no new
> email is the normal steady state for a row already reported, **not** evidence the email seam broke.
> Before this, one stuck row sent 96 identical messages a day, forever, against the same Resend
> account the Supabase magic-link sender uses (`docs/email.md`) — a long outage could have burned the
> allowance and stopped sign-in. The trade: a skipped sweep can defer a row's email to the next band,
> which is why only the email is throttled and never the metric.
>
> **AECI-1203: a replay in one band is a `duplicate`, not a second email.** The email carries the
> send-ledger key `stuck-request-alert:{requestId}:{bandIndex}`. A queue retry or a double cron tick
> rebuilds the same key, so `notification_sends` gets a `duplicate` row and Resend gets no call.
> `aeci.email.send{template:stuck-request-alert,outcome:duplicate}` is that refusal, not a fault.
> When its retry creates the issue, the sweep sends `claim-submitted-alert` under the submit's own
> key, `claim-submitted-alert:{requestId}`. If the submit-time alert went out, or its outcome is
> `unknown`, this is a `duplicate` and no mail: find the link in Linear or `/admin/claims/:id`. If
> Resend refused the submit-time alert, this send is the first alert, with the link.

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
2. Why is creation failing? **Read the alert email first — since AECI-854 it names the cause per
   row** (`no_api_key`, `http_error`, `graphql_error`, `timeout`, `network`, `empty_response`,
   `db_error`, or the rebuild blockers `target_missing` / `workflow_missing`), with a one-line gloss
   and a link to the listing. The same tokens are in the `source:reconcile` error log's `reasons`
   array beside `request_ids`. Only if both are empty, pivot `aeci.linear.issue{outcome:failed}` by
   `reason`: `http_error 401/403` →
   the `LINEAR_API_KEY` is missing/revoked/over-scope (a **missing** key is a silent no-op that emits
   no `aeci.linear.issue` metric, but the sweep still counts the row as stuck — confirm the secret is
   set on the Worker with `wrangler secret list --env production`. **Since AECI-851 a missing key on
   production should be impossible**: `promote-to-prod.yml` fails the promote in preflight and
   re-asserts the key on the live Worker after deploy. If it is genuinely absent, either the Worker
   has not been promoted since AECI-851 or the secret was deleted out of band — both are worth
   recording, because this exact gap ran undetected from the 2026-07 apex cutover to 2026-09-10); `graphql_error` → a bad label/assignee/project id (the board constants in
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
to `SUPPORT_EMAIL` (`aeci.linear.reconcile.email{outcome:sent|failed|skipped|suppressed}`), but it is fail-open:
when `RESEND_API_KEY` / `SUPPORT_EMAIL` are absent the outcome is `skipped`, so **this alert +
the `/admin/requests` queue remain the guaranteed notification** (§6.2). On a non-production tier
with no `LINEAR_API_KEY`, the sweep sends no email at all (AECI-1198). The key is production-only,
so a stuck row there is expected and not paged by mail. Make sure on-call routes a
persistent failure to whoever owns the Linear pipeline. (The 15-min cadence + ~60m persistent threshold are launch-tunable —
see `docs/OBSERVABILITY.md` and the constants in `lib/reconciliation-sweep.ts`.)

---

## Data quality job failed or not running

**Alerts (PostHog, hourly):**
- `AECi — Data quality check found ERROR-severity issues (by check)` — an integrity check (`promotion_status_invariant`, `reviews_missing_anonymized_at`) found defects. **Pages.**
- `AECi — Data quality check found WARN-severity issues (by check)` — a hygiene check found issues. **Informational / non-paging** (AECI-279 severity split; the digest carries the rows).
- `AECi — Data quality job failed (daily cron)` — a check threw or a pre-run crash.
- `AECi — Data quality job not running (no daily run)` — the cron stopped firing.

**After AECI-651** the four split four ways, and the split is worth knowing before you triage:

- **ERROR severity stays its own PostHog alert** — the job **succeeded**; the DATA is wrong.
  Different runbook entirely (triage the finding, don't restart the job). The query uses
  `max(abs(value))`, so a check that **threw** (sentinel `-1`) also fires. Since
  2026-10-29 PostHog checks it **daily**, not hourly, so a finding sends one email per run, not
  24. The email can arrive up to a day after the 04:00 UTC run; `/admin/system` shows it sooner.
- **WARN severity stops alerting** — dashboard ("AECi — Scheduled jobs and data cleanup" →
  *Nightly data-quality checks*) plus the daily digest, which already carries the rows.
- **"Job failed" is the Worker's** `cron-job-failed-alert` email, which names the job and the reason.
- **"Not running" moves to the CI liveness sweep** (`data-quality`, 26 h).

**Metrics:**
- `aeci.data_quality.check{check:<id>}` — per-check issue count (0 = clean; **-1** = the check threw).
- `aeci.data_quality.job{outcome:failed}` — run-level failure heartbeat.
- `aeci.data_quality.job{trigger:cron}` — liveness heartbeat (one per completed run).
- `aeci.data_quality.email{outcome:…}` — digest delivery (sent / failed / skipped / suppressed / not_needed). `not_needed` = the run had nothing the tier emails about.

**What it means:** The daily 04:00 UTC §23.1 data-quality job (AECI-241 / Phase 7.6) ran the
read-only integrity checks (orphan products/vendors, the AECI-592 `promotion_status_invariant` guard,
the AECI-962 `taxonomy_missing_description` guard, anonymized reviews missing `anonymized_at`, stale
`stats_cache`, duplicate vendor/product candidates, the AECI-1056 SEO metadata pair
(`duplicate_page_titles` and `default_meta_description`), a Brandfetch logo-404 sample, the reused AECI-140
Algolia drift, the AECI-1354 `license_mirror_drift` guard on the `verified` mirror, and the three
telemetry tripwires —
AECI-868's `arrival_cf_coverage`, AECI-876's `landing_cf_coverage` and AECI-1715's
`browser_evidence_coverage`). *(The count is deliberately not
stated here; `ADMIN_PANEL_SPEC.md` §14.1 is the only place that states it. This line read "eleven" for
two roster additions before AECI-876 corrected it.)* The job **does not auto-repair** — humans
triage. The email digest to the support inbox (`support@aecintegrations.com`) carries the offending rows.

> **`promotion_status_invariant` is not a data-repair finding either — it means something wrote a column
> nothing is supposed to write.** It fails when any `products` or `vendors` row reads a
> `promotion_status` other than `'promoted'`. `POST /api/promote` is D1's only INSERT path into either
> table and hard-codes `'promoted'` on all four branches; the promote payload carries no status field;
> and retraction is a hard `DELETE` (`apps/api/src/lib/retract-product.ts`). So a finding here is a
> **new writer**, not a stale row — most likely a Tier-1 retract endpoint that writes `'retracted'`
> instead of hard-deleting, or hand-written D1 SQL. Do not "fix" the row and move on: find the writer
> first. Until you do, four things are silently wrong — `products.created_at` is no longer the exact
> first-promote timestamp (`ADMIN_PANEL_SPEC.md` §13 D6), and the `catalog.*_promoted` keys in
> `metrics_daily`, their historical backfill, and the `promoted_at` set-once rationale all rest on the
> same assumption. This check replaced two unreachable ones (AECI-592); see `STAGE_1_SPEC.md` §23.1.

> **`license_mirror_drift` means something wrote `verified` or a subscription outside `lib/license.ts`.**
> It counts vendors whose `verified` disagrees with EXISTS(a live subscription). It is the only mirror
> check. Its entitlement twin, `entitlement_mirror_drift`, was retired 2026-10-17 (AECI-1375).
> E4.1 grants and E4.2 revokes move `verified` through subscriptions, and every subscription batch ends with
> the mirror reconcile, so drift needs a hand write: D1 SQL against the tier, or the
> `apps/datatool` worker. `license_mirror_drift` is `error` since AECI-1355 (E1.6), so it trips the
> `data-quality-error` alert: plan resolution reads subscriptions, so drift means a vendor's `verified`
> disagrees with what it can edit. Do not edit D1 by hand to fix it. A subscription grant, extend or
> revoke on the vendor's Billing tab re-runs the reconcile and corrects `verified`. If no subscription
> change is right for the vendor, file a Linear issue for it.
>
> *As built (AECI-1358, 2026-10-17).* This block used to say "run `ops:backfill-licenses`", and the
> AECI-1356 cutover order re-ran it before the 11:00 UTC expiry sweep. Both back-fills ran on every
> tier and are deleted with the `vendor_entitlements` readers. The source is in git history.

> **`arrival_cf_coverage` is not a data-repair finding — do not triage it like one.** It fails when
> full-document `page_views` arrivals exist in the last 24 h and fewer than 95% carry a `cf_asn`, which
> means the SSR arrival write lost `request.cf` and six columns are being stored NULL. Start at the
> cache gateway's `cf` merge (`CACHE_STRATEGY.md` §4a.1, the AECI-868 defect) and at `GET /api/version`
> to see which build is live. **Nothing repairs the affected rows** — the columns are not
> reconstructable from D1 — so the whole repair is "stop the bleeding, then mark the window". While it
> is failing, the day's traffic figures, human/bot split, swarm ratios and visitor counts are all
> unusable: say so in the health report rather than charting across the gap
> (`POST_LAUNCH_MONITORING.md` §0b, `ADMIN_PANEL_SPEC.md` §9.8).

> **`review_mirror_drift` means the review app holds a stale or absent copy of an owned vendor's
> records** (AECI-1455). It has its own section: [Review-app mirror drift](./catalog.md#review-app-mirror-drift).

> **`browser_evidence_coverage` means the browser report path is broken.** It has its own entry
> below: [Browser evidence coverage](#browser-evidence-coverage).

**First checks**

1. **Which check?** The "found issues" alerts are split `by {check}` **and by `severity:`** — the
   **error** monitor pages, the **warn** monitor is informational (AECI-279). Pivot on the `check:` tag
   (or read the digest) to see the specific check and its count. The full offending rows are in the email and in
   the `source:data-quality-cron` logs (`aeci.data_quality.check <id> count=…`).

   **Since AECI-583, start at `/admin/system` instead.** The run stores its whole result set in
   `job_runs.detail`, and the page opens on it — same rows the email carried, no inbox needed, no
   `?recompute=1` click, and stamped with the run's own time so you can tell a stale result from a fresh
   one. "Run data-quality checks" re-runs the suite live once you have made a fix. The stored history
   also makes "when did `license_mirror_drift` start failing" answerable, which it was not before.
2. **A check errored (-1 / job failed)?** Read the `source:data-quality-cron` error logs
   (`aeci.data_quality.check <id>` with `reason`, or `aeci.data_quality.crashed` for a pre-run crash).
   A pre-run crash is usually a missing `DB` binding or a deploy regression — check `GET /api/version`.
3. **No-data (job not running)?** The cron isn't firing. Check the staging/production API Worker's
   scheduled invocation in the Cloudflare dashboard / `wrangler tail` (`source:data-quality-cron`), and
   that the `aeci-data-quality-<env>` queue exists.
4. **Digest not received?** If the run fired (metrics present) but the support inbox got no email, check
   `aeci.data_quality.email{outcome}`: `skipped` = `RESEND_API_KEY` / `DATA_QUALITY_EMAIL_FROM` /
   `SUPPORT_EMAIL` not set on the Worker (fail-open by design); `not_needed` = nothing to report, which is
   the normal clean-day result (production sends only on an `error` or `warn` finding or a check that failed;
   demo only on an `error` finding or a check that failed); `suppressed` = the tier is
   staging (or local), because the digest sends from production and demo only since AECI-1220; `failed` = a Resend error — check
   the `source:data-quality-cron` log for the HTTP status and Resend's delivery log.

**Repair:** report-only — triage the digest and fix the underlying data (attach a vendor to an orphan
product, stamp a missing `anonymized_at`, dedupe a vendor, re-run the Algolia bulk sync for drift, etc.);
the next daily run auto-detects the fix. Three checks are the exception and are diagnosed at the writer,
not the row — `promotion_status_invariant`, `arrival_cf_coverage` and `landing_cf_coverage`, all noted
above. The third is `warn`, so it never reaches this alert at all; read it on `/admin/system` or in the
digest. It means new `mailing_list` rows are losing their network metadata on the SSR `/api/*`
passthrough — check `withForwardedLandingCf`, and note the path is a POST, so the AECI-868 cache-gateway
`cf` override is not the cause. `browser_evidence_coverage` is diagnosed at the report path too; see
[Browser evidence coverage](#browser-evidence-coverage) below. A no-data/liveness failure is a Worker scheduling issue — escalate to
whoever owns the API Worker's crons.

### Browser evidence coverage

**Check:** `browser_evidence_coverage`, severity `warn` (AECI-1715, epic AECI-1711). It never pages.
Read it on `/admin/system` or in the digest.

**What it measures.** The share of the previous UTC day's Turnstile-pass arrivals that carry a
browser report (`page_views.browser_evidence` is `ran` or `interacted`). The population is
`ssr-arrival` rows with `turnstile_verdict = 'pass'`, `privacy_signal = 0`, and a known country
outside the held regions (`isHeldRegionCountry` in `@aeci/shared`). Privacy-signal and held-region
rows are "not collected", so they are in neither number.

**Why Turnstile pass is the denominator.** A pass proves our page script ran in that page load. So
every row in the population should have sent its report. A gap there is the report path failing,
not visitors declining. Raw arrivals would be the wrong base: crawlers that never run the script
would read as a broken path.

**Starting values, not rulings.** AECI-1715 records the first production reading, and these move
to fit it.

| Constant | Value | Meaning |
| --- | --- | --- |
| `BROWSER_EVIDENCE_COVERAGE_MIN` | `0.8` | Fires below this share |
| `BROWSER_EVIDENCE_COVERAGE_MIN_ROWS` | `20` | Below this many rows, "nothing to measure" and a pass |

**Not applicable.** On a tier whose API var `BROWSER_EVIDENCE_ENABLED` is not `"true"`, the check
reports *Skipped*. Production reads *Skipped* until Privacy Policy 1.1 is in force and capture is
switched on (`docs/environments.md` "Browser report check per tier").

**What a firing means.** Pages loaded and Turnstile passed, but the report did not land on the row.
Something on the report path is broken. Look at these first, in this order:

1. **The flag.** The SSR Worker's `BROWSER_EVIDENCE_ENABLED` must match the API's on that tier. If
   the web var is off, the browser never sends a report. Check `GET /_version` and
   `GET /api/version` for the live builds.
2. **The ray stamp.** The browser reads the page load's Ray ID from the gateway's
   `Server-Timing: cfray` entry. Load a page with devtools open and read the response's
   `Server-Timing`. The Turnstile verdict joins on the same ray, so a lost stamp empties both
   numbers. The check then reads "nothing to measure", not a firing. A busy tier that reads
   "nothing to measure" is a sign to start here.
3. **The endpoint.** `POST /api/page-views/browser-evidence` answers 204 to any well-formed body,
   matched or not, and runs the UPDATE in `waitUntil`. So a 204 does not prove the row moved. Read
   Workers Logs for 400s and for errors from the deferred UPDATE.
4. **The rate-limit bucket.** The endpoint shares the `token` bucket, keyed by IP, with the
   Turnstile verdict post. A 429 drops the report. `docs/waf-rate-limits.md` §6.4 says which layer
   stopped it.
5. **A client regression.** A web release that broke the tracker. Compare the firing day with the
   web deploys, and check the browser console on a fresh page load.

**Repair.** Nothing repairs the lost rows: a report that never arrived cannot be rebuilt. Fix the
path, then say in the health report that the day's human floor is low by the gap.

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
   series on the PostHog "Scheduled jobs and data cleanup" dashboard). If the heartbeat is present, look for `aeci.job_runs.write{outcome:failed}` and the
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
5. **PostHog Logs show `aeci.scheduled.queue_binding_missing` (AECI-1423)?** A queue-backed job
   found no producer binding on a deployed tier, so it ran inline without the queue's retries. The
   `job` attribute names it. Compare that env's `queues` block in `apps/api/wrangler.jsonc` with
   `queueForJob` in `apps/api/src/scheduled.ts`. Bindings are not inherited across envs, so the
   fix is to add the producer and consumer to the block that lacks them and redeploy. The job's
   own runs are healthy meanwhile. A `scheduled: "<job>" is queue-less by design` info line is not
   this case: that job has no queue in any env on purpose.

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
> `cron-job-failed-alert` email (AECI-1587; the old combined alert read `aeci.metrics_snapshot.run{outcome:failed}`
> heartbeat is in the query, and the `label_column` names it), **and** it is one of the crons
> in the CI liveness sweep's registry (`observability/posthog/project-config.json`, 26 h window).
> So after AECI-651 both halves — "it failed" and "it never ran" — are covered. Until then,
> `/admin/system` and the `aeci.metrics_snapshot.run` series remain the only signals, and the
> sweep is **already running**, so its red is worth reading even during the dual-run.

**Metrics:**
- `aeci.metrics_snapshot.run{outcome:ok|partial|failed}` — one per completed run; the always-emitted
  series is the liveness signal. Note `partial` exists **here but not in `job_runs`**, which records
  a partial run as `failed` (§7.2) — the metric is the finer-grained view.
- `aeci.metrics_snapshot.metric{metric,outcome:written|failed}` — per-key, 20 keys per run. This is
  what tells you *which* series is broken.
- `aeci.metrics_snapshot.run.duration_ms` — run duration.
- `aeci.metrics_snapshot.crashed` / `.enqueue_failed` — the handler threw, or dispatch failed.

**What it means:** The daily **00:15 UTC** §7.1 snapshot (AECI-581 / Phase 8.3 P2.1,
`apps/api/src/lib/metrics-snapshot.ts`) writes one `metrics_daily` row per `(day, metric)` for all
21 `ADMIN_SNAPSHOT_METRIC_KEYS`, capturing the prior **complete** UTC day. It is the only writer.

**Since AECI-827 the same job has a SECOND pass** (ADR 0027): after the capture it re-checks the
trailing ~33 days and rewrites the `traffic.*` days the operator retro-join moved. It emits its own
`aeci.metrics_snapshot.recheck.*` family, and its result lands in the same `job_runs` row under
`detail.recheck`. **Triage the two halves separately** — `detail.metrics` is the capture,
`detail.recheck` is the correction — and note the asymmetry that decides who to wake: a re-check
**failure** turns the run red, but a re-check **refusal** (`detail.recheck.status = 'skipped'`) is the
guard working and leaves the run green. The refusals and what to do about them:

| `detail.recheck` says | What it means | What to do |
|---|---|---|
| `status: 'ok'`, `corrected: 0` | Nothing moved. The healthy steady state, most nights | Nothing |
| `status: 'ok'`, `corrected: 1-3` | Retro-join drift converging — an operator session lapsed and its anchor has now landed | Nothing. This is the job doing its work |
| `status: 'skipped'` with a `reason` naming the day ceiling | More than ten days moved at once. That is a definition change, an `is_bot` backfill, or data loss — not drift — and the pass wrote **nothing**. `corrected` and `corrections` here are a *preview* of what would have moved, not a record of writes, which is why no `recheck.correction` count is emitted for them | Run `ops:backfill-metrics-daily` **dry** over the same range and read `buildValueDiffProbes`' per-day report before deciding. Do not raise the ceiling to make it pass |
| `refusals` with `reason: 'increase'` | A recomputed value came out **higher** than stored. The retro-join can only remove rows, so this cannot be convergence | Look for a recent predicate change or an `is_bot` backfill. The audited backfill is the vehicle for either |
| `refusals` with `reason: 'raw_rows_absent'` | A stored day's `page_views` rows are gone, so the recompute would have written 0 over the only surviving record. Refused | Check `PAGE_VIEWS_RETENTION_DAYS` overrides and recent ops scripts. `metrics_daily` still holds the truth for that day — **do not** "fix" it by widening the window |
| `uncovered` non-zero | Days in the window with no stored `traffic.page_views_human` row. The pass never inserts (see below), so it cannot see whether those days moved | Fill coverage with `ops:backfill-metrics-daily`. This is the same gap that aborts the 03:00 prune |

**Why it refuses to insert a missing day**, because it looks like an easy improvement and is not:
§7.4's `findSnapshotGap` probes `metrics_daily` with **no `metric` predicate**, so one inserted row
would tell the 03:00 prune that day is captured while every stock key — unrecoverable retroactively —
is still missing, and the prune would then delete that day's `page_views` permanently.

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
   `production`; the top-level local block deliberately has none, so local dev runs no crons). Confirm against the
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

**Read the diff it prints before you `--apply`.** Since AECI-688 the dry run reports, per series and
per day, every stored value the run would change and by how much. That is not decoration: precedence
protects the *reconstructed* series only. A `measured` series — all three `traffic.*` keys,
`catalog.products_created` and `accounts.sign_ins_new` — upserts **unconditionally**, cron-written rows
included. That is intended (it is what let AECI-688 correct the AECI-683 definition change), but it
means this script rewrites a table retained indefinitely, and "how many statements" is the wrong
question to ask first. The precedence rule in full: a `reconstructed` write applies only over an absent
or already-`reconstructed` row, so a reconstruction never degrades a real snapshot.

**The diff has two blocks, and only the first one is a promise.** Days listed as changing (`≠`) are
what the run writes. Days listed under `stored day(s) NOT corrected by this run` are days whose source
rows are all gone, so the series' `SELECT` returns nothing for them: the aggregate writes nothing and
the zero-fill is `DO NOTHING`, and the stored value survives the run untouched. That is deliberate —
§7.4's prune deletes raw `page_views` once `metrics_daily` has captured the day, so a run that zeroed
those days would erase the long memory for every day whose source rows had aged out. Correct such a day
by hand, or leave it; the script will keep reporting it on every dry run until you do.

**Always pass `--to <yesterday>`.** With `--to` omitted the upper bound defaults to `max(day)` across
`page_views` / `audit_log` / `products` / `profiles`, which is **today** on any tier with traffic today.
That writes a partial UTC day into the long memory. The 00:15 cron would normally correct it the next
morning — that capture is an unconditional `measured` upsert, so it overwrites the partial value — but
the cron is queue-less and a missed run is never retried.

**AECI-827's re-check does not close this hole, and cannot.** Its window ends at `today - 2`, so it
never sees the partial day on the morning the capture would have fixed it; and once it does reach the
day, the full recompute is **higher** than the partial value, which is exactly the shape the increase
guard refuses (ADR 0027 — the retro-join can only remove rows, so an increase is never convergence).
The run reports it as `refusals[].reason = 'increase'` and leaves the partial value in place. So a
partial day is repaired only by re-running the capture for that day or the backfill with a correct
`--to`. Pass `--to` and mean it.

## Retention prune skipped, failed, or not running

**Alerts (PostHog, hourly):**
- `AECi — Retention prune skipped (metrics_daily gap)` — a day inside the `page_views` cut window has no snapshot, so **nothing was deleted from either table**. **Informational / non-paging** — the failure direction is safe — but do not sit on it.
- `AECi — Retention prune deleted an unexpected number of rows` — >5,000 rows in a day for one table. **Pages.**
- `AECi — Retention prune failed (daily cron)` — the job threw; the batch is atomic, so nothing was deleted.
- `AECi — Retention prune not running (no daily run)` — the cron stopped firing.

**After AECI-651**, also four ways: **runaway stays its own PostHog alert, threshold unchanged at
5,000 rows/table/day** (a *successful* run with the wrong effect — its runbook is "find out what was
deleted before it ages out", which shares nothing with "the job failed"); **failed folds into the
combined** cron-failure alert, now the `cron-job-failed-alert` email (AECI-1587); **not-running moves to the CI liveness sweep** (`retention-prune`,
26 h); and **skipped stops alerting**, becoming a dashboard read ("AECi — Scheduled jobs and data cleanup" →
*Old-data cleanup — what was deleted, and what was not*) alongside the digest that already carries
it.

**Metrics:**
- `aeci.retention.prune{outcome:ok|skipped|failed}` — one heartbeat per completed run; the always-emitted series is the liveness signal. On a skip, `reason` is `metrics_daily_gap`, `archive_gap` or `archive_mismatch` (AECI-1228).
- `aeci.retention.rows_deleted{table}` — rows removed per table, **emitted every run including zeros**.
- `aeci.retention.prune.truncated{table}` — the per-table run budget (10,000 rows) stopped the run short.
- `aeci.retention.prune.duration_ms` — run duration.

**What it means:** The daily **03:00 UTC** §7.4 retention prune (AECI-584 / Phase 8.3 P3.2,
`ADMIN_PANEL_SPEC.md` §7.4) deletes `page_views` older than **400 days** and `job_runs` older than
**90**, in bounded chunks. It is the system's only scheduled `DELETE`, and the only cron that writes
an `audit_log` row — exactly one `retention.pruned` summary row per run, in the same atomic batch as
the deletes (the ADR 0022 exception).

Two facts shape every response here. **Deletion is effectively permanent**: D1 Time Travel recovers
only ~30 days. (The databases on The WBS Project account are imports from the 2026-10-04 cutover, so their history starts there. AECI-1161.) And **`metrics_daily` is the only D1 aggregate that survives a `page_views` prune**, which is
why the job verifies a `metrics_daily` row exists for *every* day inside its cut window before
deleting anything, and refuses the whole run — the `job_runs` half included — if one is missing.

`metrics_daily`, `audit_log`, `workflow_instances` and `workflow_transitions` are never touched
(§26.6 / §7.4 rule 3), asserted by test rather than by comment.

Since AECI-1228 the job also copies each `page_views` day to the permanent R2 archive first, and
refuses the whole run if a day in the cut window is not confirmed there (§7.4 rule 5). The gate is on
in staging and production.

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
   **`reason=archive_gap`?** A day in the cut window has `page_views` rows and no archive ledger row.
   The archive step has been failing for at least 29 nights. Work
   [page_views archive failed](#page_views-archive-failed). The prune resumes on its own the night
   after the archive confirms the day.

   **`reason=archive_mismatch`?** D1 holds more rows for a day than the archive counted. Something wrote
   `page_views` rows for that day after it was archived. Find out what before anything else. To
   re-archive the day, delete its ledger row. The next run copies the day again, overwrites both
   objects, and the prune follows the night after. Set `DAY` to the day from `missing_days`:
   ```bash
   DAY=2027-06-30
   wrangler d1 execute aeci-app-production --env production --remote \
     --command "delete from page_views_archive_days where day = '$DAY'"
   ```
   The re-archive takes the day as D1 now holds it and overwrites the first copy. A truncated prune may
   already have deleted some of that day's rows from D1. So first download both objects for the day
   from the bucket in the dashboard, and attach them to the issue.
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
API in one shot, so a 15-minute window over an hourly-emitted series saw the whole hour's count land in
one bucket. `500 × 4 = 2,000`.
The poll-liveness half moves to the **CI liveness sweep** (`waf-poll`, 180 min unchanged).

**Metrics:**
- `aeci.waf.ratelimit.blocked{rule,action,host,source}` — Cloudflare WAF mitigations (blocks + challenges),
  **value is the event count → query with `sum:` / `.as_count()`**.
- `aeci.waf.poll{outcome:ok|failed|skipped_no_creds}` — the hourly poll's heartbeat (`outcome:ok` = liveness).

**What it means:** The §15.1 WAF rules (rate-limit Rule A `/api/requests/*`, Rule B `/api/reviews`, the
scraper-UA Managed-Challenge custom rule, and the path-only Block rules for scanner probes — `docs/waf-rate-limits.md`
§2 and §2a) mitigated an unusual volume of requests. **If the `rule` tag is one of the two AECI-1138 probe rules alone,
it is a scanner burst being blocked as designed.** One burst is several hundred blocks, and two in one clock hour
can pass 2,000. No action is needed.
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
3. **No data / heartbeat gaps?** The spike monitor has **no** `notify_no_data` — but silence means "no
   *mitigations*", which is **not** the same as "no attacks". A healthy poll over an **uncovered host**
   reports the same flat ~0, and that is exactly how AECI-659 hid for months: the rules are host-scoped and
   `www.` was in none of them, so live production looked quiet while it was entirely unprotected. Before
   reading a sustained ~0 as calm, confirm coverage:
   `node scripts/ops/2026-09-waf-host-scope/verify.mjs` — a `200 / 200` row means the rules stopped matching
   that host. Poll health is the separate `aeci.waf.poll{outcome:ok}` series, now watched by the `AECi — WAF poll not running`
   liveness monitor (AECI-279, no-data over ~3h) — if it stopped, the cron isn't running; if it shows
   `outcome:skipped_no_creds`, `CF_ANALYTICS_API_TOKEN` is unset on that env's Worker (the metric is then
   absent by design until the token is provisioned). `outcome:failed` → read the `source:waf-metrics-cron`
   error log for the Cloudflare GraphQL `reason` (e.g. an expired/under-scoped token — it needs
   `Zone Analytics: Read`).

**Repair:** the WAF itself is already mitigating — this alert is **awareness**, not an outage. Escalate only
if a legitimate surface is being blocked (re-tune the rule) or if the volume suggests a targeted attack worth
a manual Cloudflare block. The threshold is a launch placeholder; re-tune it in
`observability/posthog/alerts.json` (2,000/1 h) once baseline volume is known. That figure is
the old 500/15 m threshold rescaled 4× for the hourly window. Keep the rescale in mind when
re-tuning.

**Do not re-tune this layer for an in-Worker complaint.** Since AECI-773 there are two limiting
layers with different owners, and the whole triage risk is fixing the wrong one — see the sibling
runbook below before touching a rule here.

---

## Scanner probes reaching the Worker

**No alert of its own.** It shows up as a side effect: a `High p95 detail render` firing with no
deploy, a spike in `aeci-web-production` invocations, or a column of 404s in the edge request log.
Governing doc: `docs/waf-rate-limits.md` §2a (AECI-1138).

**What it means:** An automated scanner is requesting secret files, config files or other
stacks' endpoints (`/terraform.tfstate`, `/.vite/manifest.json`, `/api/config`, `/inngest`) and
the WAF did not stop them, so each one costs a full
SSR render. **It is not a breach.** None of these files exist, and every probe 404s. It is a cost
and a metrics-noise problem.

**First checks**

1. **Find the paths.** They are **not** in `page_views`, which records 2xx renders only. Query
   the edge request log (`docs/ANALYTICS.md` §11a) for `EdgeResponseStatus = 404` on `www.` and group by
   `ClientRequestPath`. It keeps every request for 400 days. Workers Logs no longer hold 404s, because
   invocation logs are off since AECI-1594. The 2026-09 Workers Logs method is in
   `docs/waf-rate-limits.md` §2a.
2. **Would the rules have caught them?** A probe that reached the Worker is by definition one
   no Block rule matches. Save the paths in the `observed-404s-2026-09.json` shape and run
   `check-corpus.mjs`. It prints the coverage and lists the unmatched paths.
3. **Is it the known scanner?** The 2026-09 scanner is Google Cloud AS396982, `page_views` UA hash
   `a27d5a1c…`, one-minute bursts, a different country each burst. Its real page views
   (`/`, `/products`, `/categories/*`) still land in `page_views` and are not blocked.

**Repair**

- **New path family:** add it to the matching §2a ` ```wirefilter ` block first, following the
  collision rules written there. Re-run `scripts/ops/2026-09-waf-secret-file-block/check-corpus.mjs`,
  then edit the live rule. Match on path only. **Never add an ASN or country term.** Every scanner
  seen so far rotates both.
- **Leave generic names and random strings alone.** `/health`, `/info`, `/docs` and twenty-character
  random paths are about 6% of the 2026-09 scanner. Blocking them risks real routes, and Pro has
  no regex for the random ones.
- **Rule missing or disabled:** re-apply per that directory's README §2.
- **Confirm:** a `curl` of one probed path returns 403, and Security → Events filtered on the
  rule id shows Block events at the next burst.

**Do not** raise the p95 threshold to quiet a scanner burst. Block the paths.

---

## In-Worker rate limiter tripped (AECI-773 / ADR 0026)

The sibling of the WAF runbook above, for the layer that lives in the API Worker rather than on the
zone. Read the two together: **almost every mis-triage here is re-tuning the wrong layer.**

**Metrics:**
- `aeci.api.ratelimit{bucket,outcome,key_source}` — one count per event. `outcome:limited` is a
  rejection; `outcome:unconfigured` is a tier with no binding.
- `aeci.review.submit{outcome:rate_limited}` — the separate §15.1 hourly per-user review cap, which
  is a D1 count rather than the binding and therefore never appears on the series above.

**Tell them apart first.** A caller blocked by the WAF and a caller blocked in the Worker see
completely different things, and that is the fastest discriminator:

| | WAF (edge) | in-Worker |
|---|---|---|
| Response | Cloudflare's own **403 block page**, HTML | `429` + the §3.3 JSON envelope, `code: RATE_LIMITED` |
| `Retry-After` | absent | always present |
| Duration | **1 h hard block**, no self-service recovery | the bucket window; the counter does not advance while denied |
| Evidence | Cloudflare → Security → Events, `aeci.waf.ratelimit.blocked` | PostHog `aeci.api.ratelimit`, plus a `console.warn` carrying path, method and `key_source` |
| Fix lives in | `docs/waf-rate-limits.md` + `scripts/ops/` | `RATE_LIMIT_BUCKETS` in `apps/api/src/rate-limit-middleware.ts`, then a normal deploy |

**First checks**

1. **`outcome:unconfigured` on a deployed tier is the urgent one.** It means that tier's Worker has
   no `ratelimits` binding and is limiting **nothing** — the AECI-659 failure shape, where a
   protection that covers nothing looks exactly like a protection with nothing to do. Check the
   tier's block in `apps/api/wrangler.jsonc`; `ratelimits` is **not inherited**, so each bucket is
   declared five times. `apps/api/src/wrangler-ratelimits.spec.ts` should have caught it before
   merge, so if this fires in production, find out why it did not. Note the series is emitted
   **once per isolate** — read it as presence/absence, never as a rate.
2. **A rising `key_source:absent` on `bucket:token`** means `cf-connecting-ip` stopped arriving
   through the SSR service binding, so every anonymous caller now shares one counter. Still a limit,
   a much blunter one. The fix is the existing strip-then-set pattern in
   `apps/web/src/server-runtime.ts` (`applyCfContextHeaders`), which exists because `request.cf`
   already does not survive that hop.
3. **`outcome:limited` with `key_source:user` or `vendor`** is a specific customer being stopped.
   Read the `console.warn` for the path. If it is a legitimate burst — a vendor bulk-authoring
   product versions, say — the answer is to raise `RATE_LIMIT_BUCKETS.write` and ship, **not** to
   touch the zone. Note the counters are **per Cloudflare colo**, so a distributed client sees a
   higher effective ceiling than the configured number; that is documented Cloudflare behaviour and
   not a bug.
4. **A `500` on an authenticated write, with `limit()` never called**, means `rateLimit()` was
   registered *before* its authz guard. The middleware refuses to guess a key rather than silently
   degrading a per-user cap into a per-NAT one. Fix the registration order in
   `apps/api/src/index.ts`.

**Repair:** nothing here is an outage on its own — a 429 with `Retry-After` is a working control.
The two cases that are real problems are (1) above (a tier protecting nothing) and a legitimate
customer being stopped repeatedly. Neither is fixed in the Cloudflare dashboard.

---

## API requests stalled

**Signal:** the PostHog alert *"AECi — API requests stalled (5+ over 10 s, 1 h)"*
(`observability/posthog/alerts.json` → `api-requests-stalled`, hourly). The check is hourly, so the
stall may be over when the email arrives. The chart symptom is a P999 spike on `Request duration`
for both `aeci-web-production` and `aeci-api-production`.

**What it means:** five or more API requests were still open after 10 seconds. One slow request is
routine. Five means something the API waits on has stalled. The web Worker only waits on the API.

### Triage

1. Find the window. In Workers Logs, filter `aeci-api-production` on the message `api.request.slow`.
   Read `route`, `d1_in_flight`, `oldest_d1_ms` and `oldest_d1_sql`.
2. Open a stalled request's trace in Workers Observability, and read its `Starting` and `Finished D1
   Query` lines by `$workers.requestId`.
3. Read the result against this table:

| What you see | Meaning | Next step |
|---|---|---|
| D1 span is long, `sql_duration_ms` is small, `total_attempts` is above 1 | D1 routing or retries | Send the window and request ids to Cloudflare support |
| D1 spans are long and share one `served_by_region` | One replica is stuck | Consider pinning those reads to the primary |
| D1 spans are short, another span is long | The cause is not D1 | The span names the call |
| No span covers the wait | The Worker itself stalled | Check the platform and placement. The API is pinned to `aws:us-east-1` |

4. Check whether it is us. Read D1 analytics per minute: zero queries in the window means the requests
   never reached D1. Check cloudflarestatus.com for IAD, ENAM, D1 and Workers. Compare `aeci-api-demo`,
   which runs the same code unpinned, and other Workers on the account.
5. Rule out a deploy with `gh run list --workflow promote-to-prod.yml`.

### History

**2026-11-11 16:55:35 to 16:56:12 UTC:** the first stall with traces. Five catalog reads waited 18 to
37 s. Every D1 call started in that window returned in the same millisecond, 16:56:12.12, with
`outcome: ok`. Server time stayed under 8 ms, each call made 1 attempt per statement, and all were
served by the primary in EWR (ENAM). Read replication is off on prod D1, so no replica was involved. No
D1 call completed during the 37 s. API isolates in IAD and SIN both stalled, so it was the database
path, not one isolate. No deploy since 2026-11-09 and no matching status incident. Three web visitors
gave up and cancelled. Closest to row 1 of the table, but with no retries. Sent to Cloudflare support
(case 02428986, AECI-1686).

**2026-11-03 03:31 to 03:34 UTC:** six API requests waited up to 102 s, and the five still open released
within 300 ms. D1 analytics show zero queries for 03:32 and 03:33, and the slowest query in the window
took 60 ms. No deploy within the hour and no matching status incident. Cause unknown, because no trace
data existed yet. **2026-10-28 09:36 UTC:** 11 requests up to 141 s, not investigated.

## Account record could not be created at sign-in

**Signal:** the PostHog alert *"AECi — Account record could not be created (any, 1 h)"*
(`observability/posthog/alerts.json` → `profile-ensure-failed`, hourly, AECI-1099). Its label
column names the source or sources that failed: `auth-callback`, `self-heal`, or both.

**What it means:** someone signed in, and no D1 `profiles` row could be created for them.
`POST /api/auth/profile/ensure` is the only thing that creates that row (`AUTH_AND_RLS.md`
§3.1a). On `auth-callback` the user was signed out and sent to
`/auth/login?error=profile_unavailable` after three attempts. On `self-heal` they saw a 503
`PROFILE_UNAVAILABLE` on `/account`. A vendor with no `profiles` row cannot be seated, so treat
a failure during a seating as blocking.

### Triage

1. **Is the API Worker up?** The callback reaches ensure over the SSR → API service binding. A
   burst of `auth-callback` failures with nothing else wrong usually means the API Worker was
   unreachable. Check `GET /api/version` and the Worker error-rate board.
2. **Is D1 answering?** A `self-heal` failure is the insert itself failing. Look for D1 errors
   on the API Worker's logs in the same hour.
3. **Is it one person or many?** One failure that the user retried past needs no action. The
   self-heal recovers them on their next `/account` visit. Many failures in one hour is an
   outage. Follow [High Worker error rate](#high-worker-error-rate).

### Confirming it is fixed

The alert clears on the first hourly check with no failed ensures. A user who was stuck
recovers on their next `GET /api/account`, with no operator step. If one does not, read their
row in D1 before touching anything. An erased account is refused on purpose.

---

## Erasure left an `auth.users` row behind

**Signal:** the PostHog alert *"AECi — Account erasure left a sign-in record behind (any, 1 h)"*
(`observability/posthog/alerts.json` → `erasure-auth-delete-orphaned`, hourly, AECI-531). Its
label column names the outcome: `skipped_no_creds`, `failed`, or both. Each erasure also writes
an error log on the API Worker. The message starts `account.deleted: auth.users delete`, and
its `user_id` field is the id to clean up.

**What it means:** someone deleted their account. `DELETE /api/account` erased their D1 data,
then could not delete their Supabase `auth.users` row (seam #3, `AUTH_AND_RLS.md` §8 step 4).
Their email, provider links and sign-in history are still held, and the sign-in itself still
works. The erasure is not complete until the row is gone.

Only a production erasure deletes the row (AECI-1468). The login is shared across tiers
(ADR 0017), so staging, demo and local dev keep it on purpose and count
`skipped_non_production`. That outcome never fires this alert and is never an orphan.

- `skipped_no_creds`: the production API Worker has no `SUPABASE_SERVICE_ROLE_KEY`. Every
  production erasure will orphan a row until the key is back.
- `failed`: GoTrue refused the delete or did not answer within 5 s. Usually one row.

### Triage

1. **Collect the ids.** Filter the API Worker's PostHog logs for the message above over the
   alert window. Note each `user_id` and the time.
2. **On `skipped_no_creds`, restore the key first.** The key is a single shared GitHub secret
   pushed to the API Worker by `deploy.yml` and `promote-to-{demo,prod}.yml` (AECI-530). Run
   `wrangler secret list --env production` from `apps/api` and confirm
   `SUPABASE_SERVICE_ROLE_KEY` is listed. If it is not, re-run the promote, which re-pushes it.
3. **Load the service-role key into your shell.** `apps/api/.dev.vars` holds the live key for
   the one shared auth project (ADR 0017). From the repo root:

```bash
set -a; . apps/api/.dev.vars; set +a
```

4. **Check the row still exists.** Set `ORPHAN_ID` to one `user_id`, then run the request below.
   A `404` means the row is already gone and there is nothing to do for that id.

```bash
curl -s -o /dev/null -w '%{http_code}\n' "$SUPABASE_URL/auth/v1/admin/users/$ORPHAN_ID" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

5. **Check no tier still uses the id.** One auth project backs staging, demo and production. An
   account erased on staging may still be someone's live production login, and deleting the
   auth row would sign them out everywhere. Run each read from `/tmp`, not the repo, so the
   bare names resolve to the live databases. Production is `aeci-app-production-us`; the bare
   `aeci-app-production` is the retired copy and returns nothing.

```bash
cd /tmp && for DB in aeci-app-production-us aeci-app-demo aeci-app-staging; do npx wrangler d1 execute "$DB" --remote --command "SELECT '$DB' AS db, id FROM profiles WHERE id = '$ORPHAN_ID'"; done
```

   Any row returned means **stop**: that person still has an account on that tier. Record the
   id on the issue and leave the auth row alone.

6. **Delete the auth row.** Only when step 4 answered `200` and step 5 returned no rows. A
   `200` or `204` is success.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE "$SUPABASE_URL/auth/v1/admin/users/$ORPHAN_ID" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

7. **Prove it.** Re-run step 4. It must answer `404`.

### Orphans from before the signal existed

Two windows left orphans that no log or metric recorded. Before AECI-530 no deployed API Worker
had the key, so every erasure was skipped. Before AECI-531 a skip logged nothing. That set is
found only by reconciliation:

1. Read every production erasure. `audit_log` is never pruned
   (`apps/api/src/lib/retention-prune.ts`), so this list is complete. Staging and demo
   erasures are not orphans. Since AECI-1468 those tiers keep the shared login on purpose.

```bash
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT entity_id, created_at FROM audit_log WHERE action = 'account.deleted' ORDER BY created_at"
```

2. Drop every id that still has a `profiles` row on **any** tier (step 5 above).
3. Run step 4 on each id left. A `200` is a confirmed orphan.
4. Post the confirmed ids and erasure dates on the tracking issue, and get the operator's go-ahead.
5. Run steps 6 and 7 for each.

Match on the `account.deleted` row, never on a missing profile. An auth user with no `profiles`
row anywhere is usually a person who signed up and never finished the first sign-in, not an
erasure.

### Confirming it is fixed

The alert clears on the first hourly check with no skipped or failed deletes. On
`skipped_no_creds`, confirm the key is listed with `wrangler secret list --env production`.
Do not test on staging: since AECI-1468 a staging erasure records `outcome:skipped_non_production`
and never calls GoTrue.

---

## IndexNow submissions refused

**Signal:** the PostHog alert *"AECi — Search-engine pings refused (> 90% over 72 h)"*
(`observability/posthog/alerts.json` → `indexnow-failure-rate`, checked **daily**). Its label
column names the submission count and how many were refused. It was hourly until 2026-09-24.
An hourly check re-read the same 24 h window and emailed on every firing check, so one
refusal episode sent dozens of emails. Expect at most one email a day now.

**The window is 72 h since AECI-1136.** The IndexNow request goes out once a day, so there is
at most one submission a day. Since AECI-1476 a GitHub Actions runner sends it at 00:20 UTC
(`indexnow-send.yml`); before that the 00:05 cron sent it from the Worker. A 24 h window held one submission and never met the ≥3 floor. With three
daily runs in the window, the alert fires when all three were refused.

**What it means:** the pages we changed are not reaching Bing or Yandex. IndexNow is the
**only** automated discovery channel we have on either engine. AECI-747 deleted the Google
Indexing ping, and Google discovery is still a manual human step, though since AECI-946 it is
a **recorded** one: the URLs queue themselves into `gsc_recrawl_queue` and an operator works
`/admin/reindex` (`environments.md` → "Request indexing by hand (Google)"). Discovery falls
back to ordinary sitemap crawling, which is measured in days rather than minutes. **Nothing is
lost**: the buffered URLs stay in `indexnow_queue` and the next daily send (00:20 UTC) retries
them, highest tier first, up to a seven-day ceiling. Seven days is seven attempts.

**This alert says nothing about the Google side.** The two channels share a gate
(`INDEXNOW_KEY` + `PUBLIC_SITE_URL`) and nothing else. A 100% IndexNow refusal leaves
`gsc_recrawl_queue` filling normally, and a Google worklist nobody has touched in a month
leaves this alert silent. Do not treat one as evidence about the other.

**Since AECI-944 this alert has a second input.** Every vendor-portal write now appends to
`indexnow_queue`, so the buffer is non-empty on days it used to be empty. Since AECI-1186 only a
vendor with an active entitlement appends, so a Free seat's write adds nothing here. The ≥3-submission
floor therefore clears more often and the alert evaluates more often. The threshold has not
moved (`OBSERVABILITY.md`).

**This alert exists because its absence was the defect.** Production ran at a 100% HTTP 429
failure rate from at least 2026-09-07 to 09 and nothing noticed, because the hook fails open
by design and the only evidence was a warn log nobody reads (AECI-826).

### Triage

1. **Read the status, not just the rate.** In PostHog Logs, filter
   `message = 'aeci.indexnow.submit_failed'` from the `indexnow-runner` source
   (`indexnow-drain-cron` before AECI-1476). The `reason` field carries
   `indexnow_<status>: <body>` and `batchId` names the batch. The same status, reason and
   batch id are kept in D1 in the `job_runs` row for `indexnow-send` (step 5). The
   `indexnow-send` Actions run log prints them too, with the runner's egress IP.

   | Status | Means | Do |
   |---|---|---|
   | **429** | Rate-limited by the aggregator. The limit is undocumented | **`attempts: 1` is the expected shape here, not a truncated retry** — a bare 429 is deliberately not retried (AECI-833), so a throttled run costs one request and tomorrow's run is the backoff. Check the send is still daily (`indexnow-send.yml`, `20 0 * * *`, AECI-1476) and that nothing else is submitting (`ops:submit-trade-urls` run by hand, a second env pointed at the same host). Prod showed Bing accepting the first request after 00:00 UTC, so a manual submit earlier in the UTC day can spend that allowance. If it persists for days at one request a day, the limit is no longer frequency-shaped. IndexNow also uses 429 for "potential spam", so check what we send before the key: see step 4. Then suspect the key (below) — `POST_LAUNCH_MONITORING.md` §3 has the retune procedure |
   | **403 / 422** | The key or the payload is rejected | This is the case a 429 has always hidden. Go to "the key is unverified" below |
   | **5xx** | Aggregator outage | Nothing to do. The transport already retried twice — a 5xx is a fault rather than a rate limit, so it keeps the blind backoff a 429 lost — and tomorrow's run retries again. Watch `aeci.indexnow.pending` and confirm it drains when they recover |
   | **0** | Never reached `api.indexnow.org` — DNS, TLS or egress | Since AECI-1476 this is the GitHub runner's network, and the `indexnow-send` run is red. Re-dispatch it once; a second failure is a GitHub-side outage, not ours |

2. **Check the buffer is not stranded.** `aeci.indexnow.pending` should return to 0 after a
   healthy daily run (unless a day held more than 10,000 URLs, which leaves tier 4 behind). A number that climbs day over day confirms nothing is getting through.
   Subtract `aeci.indexnow.deferred` first (AECI-1130). Those rows are URLs IndexNow accepted
   in the last 7 days. They wait out the resend window on purpose and are not stranded.
   `aeci.indexnow.expired` going non-zero means URLs have now been dropped unsent after seven
   days — that is a real loss of announcement, though the sitemap still covers those pages.

3. **Confirm the cron is alive at all.** A refused submission and an absent cron look
   different: `aeci.indexnow.drain` is emitted on **every** run, including empty ones. If it
   is missing, this is a cron-liveness problem — see
   [Cron runs missing or stuck](#cron-runs-missing-or-stuck-in-flight-on-adminsystem), and
   the CI liveness sweep should already be red (its allowance is 26 h since the drain went
   daily). A run that **throws** (a D1 error) also
   lands here: the heartbeat is emitted after the drain returns, so a throw emits nothing.
   If the heartbeat is present, read its `outcome`. `failed` is a local fault, today an
   unparseable `PUBLIC_SITE_URL`, and it also sends the `cron-job-failed-alert` email
   (AECI-864). Before AECI-1476 `refused` here was the refusal this alert measures. The cron
   sends nothing now, so it never reports `refused`. The runner has its own heartbeat,
   `aeci.indexnow.batch`; see "The runner is red, or its heartbeat is missing" below.

4. **Check what we are sending, if a 429 persists at one request a day (AECI-1130).** Bing
   refused every daily request from 2026-10-13. The key, the request rate and other submitters
   were ruled out. What was left was the list itself: mostly hub and facet pages whose counts
   had changed. Two checks:

   - In Bing Webmaster Tools, compare URLs submitted with URLs crawled for the host. On
     2026-10-16 it read 5.1K submitted, 84 crawled and 78 indexed. A ratio that low says Bing
     sees our submissions as noise.
   - Read the last few batches from `recrawl_submissions` by `batch_id`. Query production D1
     read-only from `/tmp` with `wrangler d1 execute --remote --command`, never `--file`, which
     returns no rows. Count tier-4 URLs and hub or facet paths
     (`/products`, `/categories/…`, `/audiences/…`, `/phases/…`, `/`). On 2026-10-16, 38 of 67
     were tier 4.

   The rules that answer it are ADR 0025's 2026-10-16 amendment. A hub or facet page is queued
   only when its list of entries changes. The drain defers a URL accepted in the last
   `INDEXNOW_RESEND_MIN_DAYS` (7) days. If hub paths still dominate a batch, a producer is
   queuing them on a count change: look at `affectedUrlsForPromote` and `productEditRecrawl`.
   Done when an `accepted` batch lands and this alert clears.
   A refused batch does not fire that alert, so this ratio alert is the only page for it.

5. **Read what each run sent and what came back (AECI-1183).** The drain logs every URL it
   sends in `recrawl_submissions`, one row per URL per attempt, with `outcome`
   (`accepted`, `refused` or `failed`) and `http_status`. A refused run keeps its URLs buffered
   and adds a fresh row per URL on tomorrow's retry, so one URL can have several rows. Each run
   shares one `batch_id`. Find the latest runs' ids first. Since AECI-1476 the result route
   writes one `job_runs` row per recorded send, job `indexnow-send`, whose `detail` names the
   batch, the status, the attempts and the counts. A refused batch is named there too, though it
   has no audit row.

   ```bash
   wrangler d1 execute aeci-app-production --env production --remote --command "select started_at, outcome, json_extract(detail, '$.batchId') as batch_id, json_extract(detail, '$.status') as status, json_extract(detail, '$.reason') as reason from job_runs where job = 'indexnow-send' order by started_at desc limit 5"
   ```

   Then count that run's rows by outcome. `http_status` is null for a transport error.

   ```bash
   wrangler d1 execute aeci-app-production --env production --remote --command "select outcome, http_status, count(*) from recrawl_submissions where batch_id = 'PASTE-BATCH-ID' group by outcome, http_status"
   ```

   An empty-queue run and a run whose rows were all retired slugs have no rows and no
   `indexnow-send` row. A run whose result was never recorded (the runner went red after
   sending) has neither either; its `batchId` is in the `indexnow-send` Actions run log. For one URL's history, filter on `url` instead. To see why a URL was queued, join
   `recrawl_submission_causes` on `submission_id = recrawl_submissions.id`. A row queued before
   AECI-1184 shipped has no cause row. The log is never pruned. A Google clear that said
   "requested" appears here as channel `gsc_manual`, outcome `requested`, and records what the
   operator did, never that Google indexed the page. `DATABASE_SCHEMA.md` §9.6a and §9.6b hold
   the columns.

### The key is unverified, and a 429 cannot tell you otherwise

> **Update 2026-09-28 (AECI-1136):** prod accepted submissions on 09-23, 09-25 and 09-27, each
> the first request after 00:00 UTC. An accepted submission means IndexNow fetched and accepted
> the key, so the key is good as of that date. The section below still applies if a later
> 403 or 422 appears.

**A 429 proves the transport reached the aggregator and proves nothing about the key.** Bing
throttles *before* it fetches `<key>.txt`, so a wrong key and a rate limit are
indistinguishable from our side. The `INDEXNOW_KEY` value is also **unrecoverable** —
`wrangler secret list` and `gh secret list` both return names only, and the SSR route serves
the file solely at the exact `/{key}.txt` path, so the URL cannot be built without already
knowing the key. **The Bing Webmaster Tools IndexNow panel is not a recovery route** either;
IndexNow never requires registering a key with Bing (`docs/runbooks/launch-cutover.md` §2a).

Rotation is the only way to a known value, and it is cheap — IndexNow supports it by design:

```
openssl rand -hex 16
gh secret set INDEXNOW_KEY_PRODUCTION
gh workflow run promote-to-prod.yml
```

Then approve the run's `deploy-prod-workers` job in the Actions UI. It waits for Chris (AECI-1239).

Record the value in the password manager **at the moment you generate it**. Then
`https://www.aecintegrations.com/<key>.txt` is checkable by hand, which proves the
file-serving half independently of any submission.

### Confirming it is fixed

`aeci.indexnow.submit{source:runner,outcome:ok}` non-zero in production (`source:cron` before
AECI-1476). Nothing else counts — not a green deploy, not a merged PR. It needs a real catalogue
write to buffer something to send, so after a fix, promote a product and wait for the next
00:20 UTC `indexnow-send` run, or dispatch it by hand after that day's 00:05 cron.

### The runner is red, or its heartbeat is missing (AECI-1476)

Since AECI-1476 the request leaves from a GitHub-hosted runner, `.github/workflows/indexnow-send.yml`
at 00:20 UTC, because IndexNow refused the shared Cloudflare Worker egress IPs. The Worker
still decides what to send and writes every ledger row. Two signals belong to the runner:

- **The `indexnow-send` run is red.** The script exits 1 when our API fails or IndexNow is
  unreachable. A refusal (a 4xx from IndexNow) is green with a `::warning::`, because the
  72 h alert above judges a run of them.
- **The liveness sweep reports `indexnow-send` MISSING or STALE.** Its heartbeat,
  `aeci.indexnow.batch`, is emitted by `POST /api/internal/indexnow/batch` on every
  authenticated call. A 401 emits nothing, so a missing token reads as `MISSING` here. For
  this row the sweep's message names the workflow, not a Cloudflare cron trigger (AECI-1568).

Read the red run's log first. It prints the target, the egress IP, the batch id and each
status. Then match it here.

| What the log shows | Means | Do |
|---|---|---|
| `INDEXNOW_RUNNER_TOKEN is empty` (exit 2) | The GitHub secret `INDEXNOW_RUNNER_TOKEN_PRODUCTION` is not set | Generate a token, set the GitHub secret, then run promote-to-prod so it reaches the Worker |
| `Batch route returned 401` | The Worker has no `INDEXNOW_RUNNER_TOKEN`, or it differs from the GitHub secret | Set both from the same value. Only `promote-to-prod` pushes the Worker secret from the GitHub one, so setting or rotating the GitHub secret does nothing until the next promote. Push it the same day: re-run `promote-to-prod` on the current prod SHA, or run `wrangler secret put INDEXNOW_RUNNER_TOKEN --env production` from `apps/api`. Then dispatch `indexnow-send` and confirm a green run. AECI-1568: the secret was set two days after the last promote, and the runner 401ed for six days |
| `Batch route returned 500` | An unparseable `PUBLIC_SITE_URL`, or a D1 error | The 00:05 cron's `aeci.indexnow.drain{outcome:failed}` names the first. PostHog Logs under `source:indexnow-runner` carries the trace id for either |
| `The result for batch … was not recorded` | IndexNow got the request, but the result POST failed three times | Nothing is lost: the rows stay queued and tomorrow resends them. This send has no log row. Re-dispatching is safe, because the result route is idempotent on `batchId` and a new run mints a new batch |
| `IndexNow did not answer usefully (status 0)` or a 5xx | The runner could not reach IndexNow, or IndexNow failed | Re-dispatch once. Do not loop it: each run is a request against the same limit |

If the heartbeat is missing and there is no red run, the schedule did not fire. GitHub
disables a scheduled workflow after 60 days without repository activity, and can delay or
drop a scheduled run under load. List the recent runs to tell which:

```bash
gh run list --workflow indexnow-send.yml --limit 5
```

Check the secret exists on both sides by name. Neither store returns the value.

```bash
gh secret list
```

```bash
pnpm --dir apps/api exec wrangler secret list --env production
```

To send by hand, dispatch the workflow after that day's 00:05 cron has run:

```bash
gh workflow run indexnow-send.yml
```

### There is no runbook for an unworked Google queue, and that is a decision

**No alert exists on `gsc_recrawl_queue` depth, and none should.** This is recorded here rather
than left as an omission, following the precedent `ADMIN_PANEL_SPEC.md` sets for declining a
thing in writing.

**The reason is that a healthy queue is a non-empty queue.** Every promote and every vendor
write appends to it, and the operator drains it against a daily quota Google does not publish.
Tier 4 is explicitly a bucket that may never be reached (`STAGE_1_SPEC.md` §20.2). So depth
alone cannot separate "nobody has looked at this in three weeks" from "it is Saturday and the
catalogue is busy". An alert on it would fire on ordinary days, and an alert that fires on
ordinary days is the thing that trained everyone to ignore the review-queue zero.

**What is in place instead**, in increasing order of latency:

1. **A nav badge.** The Re-index entry inside the Operations panel carries the depth. Since
   2026-11-04 the closed Operations trigger and the header account menu leave it out, so the
   operator has to open the panel to see it. Zero renders no badge.
2. **A daily checklist row** (`POST_LAUNCH_MONITORING.md` §1, row 11). It is the one row on
   that list that is work rather than a read.
3. **The Googlebot sitemap-coverage figure** (§3a-bis of the same doc), read weekly. It is the
   only *outcome* signal, and it degrades slowly.

**Re-open this decision if** the badge proves ignorable, which would look like a tier-1 row
sitting unworked for more than a week while the operator was active in the console. The signal
to build first is **oldest tier-1 or tier-2 row age**, not total depth. Depth conflates a busy
catalogue with a neglected queue; age does not.

**If you are triaging a queue that has genuinely been abandoned**, there is nothing to repair.
Rows do not expire, by design, so the work is all still there. Open `/admin/reindex`, filter
`?priority=1`, and spend that day's quota from the top. The one thing to check first is that
the queued hosts still match `PUBLIC_SITE_URL`, since an environment re-point leaves URLs the
operator cannot paste into that Search Console property.

## gsc-inspect halted on quota or failed

**Signal:** `aeci.gsc_inspect.run{outcome:quota}` or `{outcome:failed}` for the `gsc-inspect` cron
(AECI-1236, `0 13 * * *`). `outcome:failed` also sends the `cron-job-failed-alert` email.
`/admin/system` shows the run's `job_runs.detail`: `{ job, runId, remaining, next, inspected,
closed, tagged, errors, halted? }`.

**What the job does.** It asks Google's read-only URL Inspection API about queued rows and deletes
the ones Google re-crawled after the page last changed. It requests nothing. A run is up to 1,500
rows in chunks of 100, chained through `aeci-gsc-inspect-{env}`. A row whose inspection failed
(`errors`) is left as it was. The chained message carries its id in `skipIds`, so later chunks of
the same run skip it, and the next day's run tries it again.

**`outcome:quota`: do nothing.** Google answered 429 and the run stopped on purpose. This is
routine. Rows not reached keep their place, because the next run reads never-inspected rows first.
Tomorrow's run continues. The worklist is as long as it was, so work it from the top as usual. Look
again if `quota` appears on most days with a low `inspected` count. We do not know why that would
happen. File an issue with the `job_runs` rows. The run budget of 1,500 is under Google's
published 2,000 calls a day per property.

**`outcome:failed`: check the key, the property, then the queue.**

1. Read the run's `job_runs.detail` on `/admin/system` and the warn log from the same time. A key Google refused is a `401` or `403`.
2. Confirm the service account is still a user on the Search Console property
   `sc-domain:aecintegrations.com` and the Search Console API is enabled on its Google project.
3. Confirm `GSC_SA_KEY_JSON` is set on the production API Worker. A missing key reads
   `outcome:skipped`, not `failed`. Re-run `promote-to-prod.yml` or put the secret by hand if the
   GH secret `GSC_SA_KEY_JSON_PRODUCTION` was rotated.
4. If the log says `aeci.gsc_inspect.chain_enqueue_failed`, confirm the queue
   `aeci-gsc-inspect-production` exists (`wrangler queues list`). The deploy creates it, so a
   missing queue means a deploy step was skipped.

**What is safe to ignore.** A failed or halted run never deletes a row it did not inspect, and it
never closes a row on a failed page fetch. The cost of a dead run is a longer list, not lost work.
The manual fallback is step 0 of `docs/runbooks/gsc-reindex.md`.

**`outcome:skipped` is the correct state outside production**, and in production before the key is
provisioned. It is not a fault.

## Backfill traffic classifications

Not an alert. Use this to classify past `page_views` days at the current classifier version
(AECI-1444, `DATABASE_SCHEMA.md` §9.7). Each tier runs once, staging first, then demo, then
production. Each run needs Chris's go-ahead on the day.

**Run this with every `TRAFFIC_CLASSIFIER_VERSION` bump, over the full history.** Ruled by Chris on
2026-11-07 (AECI-1584): every rule change backfills every surviving `page_views` day at the new
version, unless Chris rules on that bump that it is not needed. The consumer accepts days up to 370
days old, so "full history" starts at the later of the earliest surviving day and that limit.
`home.popular_products` counts only views with a row at the current version (AECI-1586). Without a backfill of at least the trailing 30 days,
the next home stats recompute writes `[]`. The home's "Popular:" row then names categories, and
rebuilds from one day of views at a time.

**How it works.** The script sends one `traffic_classify` message carrying
`trafficClassify: { day, through }` onto `aeci-traffic-classify-{env}`. The consumer classifies
that one day, then sends the next day itself. The chain ends when `day` equals `through`. Each day
writes one `job_runs` row. A day already at the current version writes 0 rows, so a re-run is
safe. The queue runs one message at a time, so the chain and the 00:45 nightly run never overlap.

**1. Read the range ends.** `--from` is the earliest surviving `page_views` day. `--through` is the
day before the first day already stored at the current version. Run both reads on the tier's D1.
The staging form is below. For production, run the reads from `/tmp` against
`aeci-app-production-us`, as `POST_LAUNCH_MONITORING.md` §3c step 2 says.

```bash
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-staging --env staging --remote --command "SELECT substr(min(created_at), 1, 10) AS earliest_day FROM page_views"
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-staging --env staging --remote --command "SELECT classifier_version, min(view_day) AS first_day, max(view_day) AS last_day, count(*) AS n FROM page_view_classifications GROUP BY classifier_version"
```

**2. Shadow-run the range.** Run `ops:traffic-shadow` over the same days and show Chris the report
before any push. Old days mostly read `unresolved`. That is expected.

**3. Dry-run, then apply.** Read the queue id, dry-run, then apply with that id in place of
`QUEUE_ID` and the two days in place of `FROM_DAY` and `THROUGH_DAY`. Production also needs
`--allow-production`. `--apply` needs `CLOUDFLARE_API_TOKEN` with Queues Edit, and
`CLOUDFLARE_ACCOUNT_ID`.

```bash
pnpm --filter @aeci/api exec wrangler queues info aeci-traffic-classify-staging
pnpm --filter @aeci/api ops:backfill-traffic-classifications -- --env staging --from FROM_DAY --through THROUGH_DAY
pnpm --filter @aeci/api ops:backfill-traffic-classifications -- --env staging --from FROM_DAY --through THROUGH_DAY --apply --queue-id QUEUE_ID
```

The script refuses a range the consumer would refuse. `--through` must have closed, which is 30
minutes after it ends. `--from` must be at most 370 days old.

**4. Watch the chain.** One row per day, in order. A healthy chain ends at the row whose
`detail.day` equals `through`. A refused message writes a row with no `backfill` flag, only
`detail.reason`, so the query matches that reason too.

```bash
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-staging --env staging --remote --command "SELECT started_at, outcome, json_extract(detail, '$.day') AS day, json_extract(detail, '$.rowsWritten') AS written, json_extract(detail, '$.through') AS through, json_extract(detail, '$.reason') AS reason FROM job_runs WHERE job = 'traffic-classify' AND (json_extract(detail, '$.backfill') = 1 OR json_extract(detail, '$.reason') LIKE 'backfill_refused:%') ORDER BY id DESC LIMIT 10"
```

| What you see | Meaning | Do |
|---|---|---|
| The last row's `day` equals `through` | Done | Nothing |
| Rows stop before `through`, the last one `failed` | The chain died. `max_retries` is 3 and there is no dead-letter queue, so the message is gone | Read `aeci.traffic_classify.crashed` for the cause. Fix it, then push again from the failed day |
| Rows stop before `through`, the last one `ok`, and no new row for an hour | The next message was lost after a send that reported success | Push again from the day after the last `ok` row |
| One `skipped` row with `reason` `backfill_refused:…` | The consumer refused the message. Nothing was written | Read the reason. `OBSERVABILITY.md` lists them. Fix the range and push again |

**Resume.** A resume is a new push with `--from` set to the next day and the same `--through`. A
day that was already written writes nothing, so starting one day early is harmless.

**Never purge `aeci-traffic-classify-{env}` near 00:45 UTC.** The queue also carries the nightly
message. A purge then drops that night's run, and the liveness sweep goes red the next day.

**What it does not touch.** The liveness sweep counts only `trigger:cron`, so backfill heartbeats
cannot hide a missed nightly run. A backfill `failed` still sends the `cron-job-failed-alert` email.

## Brand asset removal (AECI-1618)

Use this when `aeci.brand_assets.removal.run` reports `outcome:failed`, the liveness sweep says `brand-asset-removal` is missing, or a company's logo is still there more than 14 days after its claim ended.

What the job does: once a day at 16:00 UTC it finds every company with `claim_ended_at` set and `brand_assets_removed_at` empty. It puts the retained AECi logo back on each row with `logo_source = 'vendor'`, deletes the R2 objects nothing references, then stamps `brand_assets_removed_at`. The stamp comes last, so a company whose cleanup failed stays due and the next run retries it. The queue also retries a failed message three times. `STAGE_2_5_SPEC.md` §11.2, ADR 0051.

1. Open `/admin/vendors` and read "Pending logo removals". A company listed there is due. The columns show the claim end, the day-14 limit, the next run and any hold.
2. If a company is held, lift the hold unless there is a reason to keep it. A hold never survives past 13 days after the claim ended, so a held company still clears in time.
3. If a company is due and not held, check the last run. `/admin/system` shows the `brand-asset-removal` row. A `failed` row names the reason.
4. List the companies still due with the next command.

```
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT slug, claim_ended_at, brand_assets_hold_at FROM vendors WHERE claim_ended_at IS NOT NULL AND brand_assets_removed_at IS NULL ORDER BY claim_ended_at"
```

5. A failure that repeats on one company is usually R2. Fix the cause, then wait for the next 16:00 run. No stamp was written, so nothing needs undoing.
6. A company that got a seat back before the run is not due. The seat return clears `claim_ended_at`, the hold and the removed stamp, and the logos stay. That is correct.
7. A new cron trigger takes about 15 minutes to propagate after a deploy. A first run that is a day late right after the deploy is not a defect.

An objection from a logo owner is a different path: `docs/runbooks/listing-submissions.md` §6a.

## Acceptance evidence removal (AECI-1636)

Use this when `aeci.agreement.evidence_removal.run` reports `outcome:failed`, the liveness sweep says `acceptance-evidence-removal` is missing, a run's `job_runs.detail` says `truncated: true` two days running, or an acceptance more than 90 days old still shows an IP address on the admin Billing tab.

What the job does: once a day at 17:00 UTC it finds every `agreement_acceptances` row accepted more than 90 days ago that still holds an `ip` or a `user_agent`. It nulls both and stamps `evidence_removed_at`, 80 rows per batch, at most 10 batches a run. Each batch writes one `agreement.evidence_removed` audit row listing the acceptance ids. Email, time and version stay. The Privacy Policy "Retention" promises this deletion. `DATABASE_SCHEMA.md` §8.6d.

1. Check the last run. `/admin/system` shows the `acceptance-evidence-removal` row. A `failed` row names the reason. The queue retries a failed message three times, and a retry is safe: rows already cleared no longer match.
2. List the rows still due with the next command. An empty result means the promise holds.

```
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT id, source, accepted_at FROM agreement_acceptances WHERE accepted_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days') AND (ip IS NOT NULL OR user_agent IS NOT NULL) ORDER BY accepted_at"
```

3. Rows listed there after a successful run are newer than that run's cutoff. They go at the next run.
4. `truncated: true` means more than 800 rows were due. The rest go the next day. Two truncated days in a row means the claim rate outgrew the cap. File an issue to raise `EVIDENCE_REMOVAL_MAX_CHUNKS`.
5. A new cron trigger takes about 15 minutes to propagate after a deploy. A first run that is a day late right after the deploy is not a defect.
6. Never restore a removed IP from D1 Time Travel. The policy says it is deleted.

## Runbooks kept in other files

The index of every runbook is [`README.md`](./README.md).

- **Promote, the strand audit, retractions, the ownership mirror, removal requests, slug renames:** [`catalog.md`](./catalog.md).
- **Subscriptions, Stripe billing, pilot and granted terms, ending a vendor:** [`subscriptions.md`](./subscriptions.md).
- **Legal events with a deadline (data breach, accessibility demand letter, subpoena, litigation hold):** [`legal.md`](./legal.md).
