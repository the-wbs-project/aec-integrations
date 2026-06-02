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

`aeci.ssr.render` (AECI-103) is one count per SSR render, fired on **every** branch
of `handleSsr` — including the edge-cache HIT path and the non-cacheable branch, both of
which the `aeci.page.render.duration_ms` distribution skips. It is the bounded pipe-health /
render-volume signal that replaced the per-render `ssr.render` *log* firehose. Tags are kept
deliberately low-cardinality (`cache_status` + `status_class`, no path/slug) so cost can't
balloon. `cache_status:non_cacheable` is the slice for the `**` 404 wildcard and non-GET
requests.

Every metric also carries the base tags `env`, `app:aeci`, `service` (`aeci-web` /
`aeci-api`), `worker`, `locale` — the same vocabulary as the log `ddtags` string.

### Two gotchas when querying

1. **Datadog lowercases tag values.** `cache_status:HIT` is stored and queried as
   `cache_status:hit`; `status_class:5xx` stays `5xx`. All dashboard/monitor queries
   use lowercase.
2. **Distribution percentiles must be enabled.** `aeci.page.render.duration_ms` and
   `aeci.api.query.duration_ms` are distribution metrics — to query `p50/p95/p99` you
   must enable percentile aggregations under **Metrics → Summary → (metric) → Manage
   distribution metrics → Add percentile aggregations**. Done once per metric.

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

## Dashboard

- **Name:** `AECi Phase 2 — Traffic`
- **Definition (for record):** `observability/datadog/dashboard.json`
- **Live URL:** _TBD — filled in after the live apply (AECI-66 verification step)._

Widgets: top routes by request count · cache hit rate per `route_class` · p50/p95/p99
render per `route_class` · p95 API query per endpoint · 4xx/5xx error rate over time ·
purge events by source.

## Monitors

Each monitor's `message` links the matching runbook in `docs/RUNBOOKS.md` and routes to
the team notification channel (replace `@NOTIFICATION_CHANNEL_TBD` with the real handle
at apply time).

| Monitor | Condition | Definition |
|---|---|---|
| Cache hit rate low | hit rate < 70% sustained 15m | `observability/datadog/monitor-cache-hit-rate.json` |
| Detail render slow | p95 detail render (cache MISS) > 1.5s sustained 10m | `observability/datadog/monitor-detail-render-p95.json` |
| Worker error rate high | combined SSR+API 5xx rate > 1% over 5m | `observability/datadog/monitor-error-rate.json` |

The p95-detail monitor is scoped to `cache_status:miss` on purpose: HITs are served
from the edge and would mask a genuinely slow render.

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
