# Runbooks

Operational response guides for AECi Datadog alerts.

> **Status: stubs (AECI-66).** Each runbook below has enough to triage during Phase 2.
> Full incident procedures (severity matrix, comms, post-mortem template) land in
> Phase 6. Linked from the Datadog monitor messages — keep the heading anchors stable.

Dashboard for all three: **AECi Phase 2 — Traffic** (URL in `docs/OBSERVABILITY.md`).

---

## Low cache hit rate

**Alert:** `AECi — cache hit rate < 70% (15m)`
**Metric:** `aeci.page.render.duration_ms` — `count{cache_status:hit} / count{*}`.

**What it means:** Too many SSR requests are missing the edge cache and re-rendering.
At scale this raises render latency and API/Supabase load.

**First checks**

1. Did someone just run `POST /admin/purge`? Check the "purge events by source" widget
   and the `aeci.cache.purge` metric. A broad/accidental purge causes a temporary, self-
   healing dip — confirm it recovers within a TTL window.
2. Recent deploy? A new deploy invalidates the edge cache; expect a short dip as it
   refills. Correlate with `GET /api/version`.
3. Is the dip isolated to one `route_class`? Pivot the hit-rate widget. A single class
   suggests a TTL or cache-key regression for those routes (see `docs/CACHE_STRATEGY.md`).
4. Cache-key poisoning: verify cacheable responses are visitor-state-neutral (no
   `Vary: Cookie`, theme cookie stripped) per `docs/CACHE_STRATEGY.md` §6.

**Escalation:** If not explained by a purge/deploy and not recovering, treat as a
caching regression — page the on-call engineer (Phase 6 rotation TBD).

---

## High p95 detail render

**Alert:** `AECi — p95 detail page render > 1.5s (10m)`
**Metric:** `aeci.page.render.duration_ms{route_class:detail,cache_status:miss}` p95.

**What it means:** Server render of detail pages on a cache MISS is slow. Scoped to
MISS because HITs are edge-served and don't reflect render cost.

**First checks**

1. Is the API slow? Check `p95:aeci.api.query.duration_ms by {endpoint}` for the detail
   endpoints (`/api/products/:slug`, `/api/vendors/:slug`, `/api/integrations/:id`).
2. Supabase health: connection/latency via Datadog logs (`service:aeci-api`) and the
   Supabase dashboard.
3. Recent deploy to `apps/web`? An Angular SSR regression (heavy resolver, blocking
   work) can inflate render time — correlate with `GET /api/version`.
4. Is it global or one entity? A single slow slug points at data shape, not the platform.

**Escalation:** Sustained > 1.5s with a slow API → investigate the query/DB. With a fast
API → investigate the SSR render path. Page on-call if user-facing.

---

## High Worker error rate

**Alert:** `AECi — Worker error rate > 1% (5m)`
**Metric:** combined SSR + API 5xx count / total across both Workers.

**What it means:** Users are hitting server errors. Highest-severity of the three.

**First checks**

1. Recent deploy? `GET /api/version` on both Workers; if a deploy lines up with the
   spike, consider rolling back (`promote-to-prod` / AECI-71).
2. Read the errors: Datadog logs `service:(aeci-api OR aeci-web) status:error` — the API
   error handler logs `trace_id` + stack.
3. Which side? Split the error-rate widget by `service`. API-dominant → DB/Prisma/
   Supabase or a handler bug. SSR-dominant → render crash or a bad upstream response.
4. Cloudflare platform: check the Workers dashboard for exceptions / CPU-limit errors.

**Escalation:** > 1% sustained is page-worthy. Capture a `trace_id` from the logs before
mitigating so the post-mortem can reconstruct the failure.

---

## Algolia index drift

**Alert:** `AECi — Algolia index drift (Supabase ≠ Algolia)`
**Metric:** `aeci.algolia.index_drift` — signed `supabase − algolia` count per `entity`/`index`
(AECI-140, §23.1 daily data-quality check).

**What it means:** An Algolia index's object count no longer matches the promoted Supabase
rows it should mirror. **Positive** drift = the index is *missing* rows (a sync didn't run
or half-failed). **Negative** = the index holds *orphans* (rows fell out of `promoted` but
weren't pruned — the AECI-138 bulk sync upserts and does not delete). This is **report-only**;
nothing auto-repairs.

**First checks**

1. Which index? The alert is split `by {index}` — note `<env>_products` / `_vendors` /
   `_integrations` and the sign/magnitude (logged with the gauge).
2. Recent promotes? Drift right after a `POST /api/promote` is expected until a sync runs.
3. No-data variant: if the alert is "no data for 48h", the daily cron
   (`apps/api/src/scheduled.ts`) didn't report — check the staging/production API Worker's
   scheduled invocation in the Cloudflare dashboard / `wrangler tail`, and that
   `ALGOLIA_APP_ID` / `ALGOLIA_ADMIN_KEY` are set on the Worker.

**Repair:** re-run the AECI-138 bulk reindex for the affected env (idempotent upsert):

```bash
pnpm --filter @aeci/api db:algolia-bulk-sync -- --env <staging|production>
```

To re-check on demand without waiting for the 09:00 UTC (= 04:00 EST) cron:

```bash
DIRECT_URL=<DIRECT_URL_{STAGING,PRODUCTION}> ALGOLIA_APP_ID=… ALGOLIA_ADMIN_KEY=… \
  pnpm --filter @aeci/api db:reconcile-algolia-drift -- --env <staging|production>
```

**Escalation:** persistent negative drift after a re-sync means orphan objects the upsert
can't remove — a deliberate prune is out of scope for AECI-140; open a follow-up.

---

## Algolia sync failed

**Alerts:** `AECi — Algolia sync failed (daily cron)` (a failed push) and
`AECi — Algolia sync not running (no successful cron push)` (the cron stopped firing).
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
2. Read the failure: Datadog logs `service:aeci-api` — `aeci.algolia.sync` (per-entity, with
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

**Alerts:** `AECi — Home stats compute failed (daily cron)` (one or more `home.*` keys failed) and
`AECi — Home stats not running (no daily compute)` (the cron stopped firing — the freshness alert).
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
   Stats" dashboard by `key`, and read Datadog logs `service:aeci-api source:stats-cron`
   (`aeci.stats.compute <key> status=failed`, with `reason`; `aeci.stats.compute.crashed` is a
   pre-compute throw before any key ran).
3. DB health: the job reads/writes Supabase via Prisma Accelerate. A `DATABASE_URL` problem or a
   Supabase outage surfaces as `aeci.stats.compute.crashed` (pre-compute) or many failed keys —
   check the Supabase dashboard and the Worker's `DATABASE_URL` secret.
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

**Alert:** `AECi — page_views write error rate > 10% (10m)`.
**Metric:** `aeci.pageviews.write{outcome:failed}` / `aeci.pageviews.write` (all) — the failed-insert
ratio over 10m (AECI-177 write; AECI-180 monitor). Companion signal: the `aeci.api.page_view.capture_failed`
log carries the `reason`.

**What it means:** `POST /api/page-views` validates the body, returns **204 immediately**, and
inserts one `page_views` row via `ctx.waitUntil()`. A failing insert is **user-invisible** (the 204
already went out) — but `page_views` is the **only** source for `home.trending_products`, so a
sustained insert regression silently **zeroes trending** at the next 07:00 UTC daily compute. This
monitor exists to surface the regression *before* the home page goes blank. (Distinct from "Home
stats compute failed": there the compute job breaks; here the upstream data the compute reads stops
arriving.)

**First checks**

1. Read the failure: Datadog logs `service:aeci-api source:page-views` —
   `aeci.api.page_view.capture_failed` carries the `reason` (the Prisma/Supabase error).
2. DB health: the insert goes to Supabase via Prisma Accelerate. A `DATABASE_URL` problem, a
   Supabase outage, or pooler saturation surfaces as a broad failure spike — check the Supabase
   dashboard and the Worker's `DATABASE_URL` secret.
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

## page_views duplicate PK (prod data corruption)

**Symptom:** the `refresh-staging` workflow fails at the **"Restore prod data into staging"** step
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

**Alert:** `AECi — Auth sign-in error rate > 30% (15m)`.
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
2. Read the failures: Datadog logs `service:aeci-web` around `/auth/callback`.
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

## Perspective API outage

**Alert:** `AECi — Perspective API outage (>50% errors, 15m)`.
**Metric:** `aeci.perspective.api{outcome:failed}` / `aeci.perspective.api` (all) over 15m; failure
`reason` ∈ `http_error` / `malformed` / `timeout` / `network`. Companion: `aeci.perspective.api.duration_ms`
(latency) and the `service:aeci-api source:perspective` warn logs.

**What it means:** Google's Perspective API (review toxicity scoring, `lib/perspective.ts`, AECI-198) is
failing for most calls. Scoring is **fail-open and flag-never-block**: a failed score stores
`toxicity_score = null` and the review **still enters the moderation queue** — so this is **not
user-facing** and does **not** block submissions. The cost is that the moderation queue temporarily loses
its triage signal (the worst content no longer floats to the top of `/admin/reviews`).

**First checks**

1. Which reason? Pivot the "AECi Phase 5 — Auth/Reviews" dashboard Perspective widgets / the metric by
   `reason`. `timeout`-dominated → Perspective is slow (the client caps at 2s); `http_error` → non-2xx
   (quota/`429`, auth/`403`); `network` → connectivity or a body that won't parse; `malformed` → a 200
   with no TOXICITY summaryScore (an API contract change).
2. Read the failures: Datadog logs `service:aeci-api source:perspective` carry the message + status.
3. Credentials/quota? A **missing** `PERSPECTIVE_API_KEY` is a silent no-op that emits **no** metric (so
   it can't trip this alert) — but a *revoked/over-quota* key shows as `http_error` `403`/`429`. Check the
   key and the Perspective quota in Google Cloud.
4. Provider status: an upstream Perspective outage self-heals; confirm via Google Cloud status.

**Repair:** none required for correctness — submissions keep working with `toxicity_score = null`. Once
Perspective recovers, **new** submissions score normally; reviews submitted during the outage keep their
null score (there is no backfill — they're triaged manually in the queue). If the cause is a bad/revoked
key or exhausted quota, rotate the key / raise the quota and redeploy the secret.

**Escalation:** a prolonged outage isn't urgent (fail-open), but flag it so moderators know the queue's
toxicity ordering is degraded until it clears. A persistent `malformed` reason with Perspective healthy
points at an API contract change — open a follow-up against `lib/perspective.ts`. (The 50% threshold is a
launch-tunable starting point — see `docs/OBSERVABILITY.md`.)

---

## Moderation queue backlog

**Alert:** `AECi — Moderation queue backlog (oldest pending > 48h)` (the threshold), which **also**
fires `notify_no_data` if the daily snapshot stops (the cron-liveness check).
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
   `DATABASE_URL` (a Prisma/Supabase failure logs `aeci.moderation.queue.crashed`, `source:moderation-cron`).

**Repair:** there is no auto-remediation — moderators clear the backlog via `/admin/reviews`. The gauge
self-resolves to 0 once the queue is empty. A persistent no-data with a healthy Worker is a cron/trigger
wiring problem (check 3).

**Escalation:** a chronic backlog is a **staffing/process** issue, not an engineering one — route it to
whoever owns moderation rather than on-call. (The 48h threshold and the daily snapshot cadence — which
adds up to ~24h detection lag — are pre-launch starting points; see `docs/OBSERVABILITY.md`. Move the
cron to hourly if a tighter SLA is needed.)
