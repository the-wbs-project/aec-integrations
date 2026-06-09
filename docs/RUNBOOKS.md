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
