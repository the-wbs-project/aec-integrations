# ADR 0020: Native Workers Cache + cross-Worker purge via Cloudflare Queue

**Status:** Accepted
**Date:** 2026-07-12
**Context owner:** chrisw@thewbsproject.com
**Epic:** AECI-314 (Workers Cache Migration) · this ADR is WC-1 / AECI-315
**Amends:** ADR 0004 (Pro plan + purge-by-Cache-Tag) — Cache-Tag purge is **retained**; only the transport changes.
**Reverses (mechanism only):** ADR 0010 (promote purges Cloudflare directly) — cross-Worker purge moves from a direct HTTP call to a **Cloudflare Queue** consumed by the SSR Worker (ADR 0010's own deferred "Option C").
**Supersedes:** the design rationale in the transitional `docs/workers-cache-migration-plan.md` (that file keeps only shared reference material until the WC-11 docs sweep retires it).

---

## Context

Today (Phase 2 design — `docs/CACHE_STRATEGY.md`, ADR 0004) the SSR Worker **runs on every request**. Inside `handleSsr` (`apps/web/src/server-runtime.ts`) it hand-rolls the whole edge cache:

- **Lookup/write** against `caches.default` (`getEdgeCache()` → `cache.match()` / `ctx.waitUntil(cache.put())`), keyed by a URL it normalizes by hand in `cacheKeyUrl()`.
- **Key normalization** (AECI-100/143/223): strip `utm_*`/`fbclid`/etc., apply a per-route `cacheKeyParams` allowlist, and `searchParams.sort()` for canonical order so `?a=1&b=2` and `?b=2&a=1` collapse to one entry.
- **Invalidation** by a separate **HTTP** `POST /zones/{zone}/purge_cache` call (`callCloudflarePurge` in `packages/shared/src/cache-purge.ts`), driven from `POST /api/promote` (API Worker), `POST /admin/purge` (SSR Worker), and datatool.

Cloudflare shipped **[Workers Cache](https://developers.cloudflare.com/workers/cache/)** — a native cache that sits **in front of** a Worker. A cache HIT is served from the edge **without running the Worker** (zero Worker CPU), it is **tiered by default**, and it **collapses concurrent requests** to the same key. It is configured with `cache.enabled` in `wrangler.jsonc` and purged from inside the Worker with `ctx.cache.purge()`. This replaces most of the bespoke machinery, but two properties of the new model don't map onto our current shape and drive the whole migration:

1. **Cross-Worker purge.** `ctx.cache.purge()` is **entrypoint-scoped**: it evicts only the calling entrypoint's own cache, and *"no zone configuration for caching applies to Workers Caching"* — so our existing zone-level HTTP purge (`callCloudflarePurge`) is **inert** against Workers Cache. But our writer (`POST /api/promote`) lives in the **API Worker** and must invalidate **SSR HTML** cached in front of the **SSR Worker**. The two caches are in different Workers; nothing the API Worker can call directly reaches the SSR Worker's cache.
2. **Cache-key normalization.** The native cache key is the **full, order-sensitive path + query string** (plus entrypoint, `ctx.props`, and — by default — Worker version). `?a=1&b=2 ≠ ?b=2&a=1`; trailing slash matters; `utm_*` fragments the key. Enabling the cache naively would **throw away AECI-100/143/223** and re-fragment the cache on tracking params and facet order.

**Toolchain is already ready** (verified 2026-07-12): `wrangler 4.107.1`, `miniflare 4.20260702.0`, `@cloudflare/workers-types ^4.20260702.1` — meeting both the `cache.enabled` floor (≥ 4.69.0) and the per-entrypoint / `cross_version_cache` floor (≥ 4.107.0). WC-2 only bumps compatibility dates.

> **Update — WC-2 done (AECI-316, 2026-07-16).** Bumped `wrangler ^4.107.0 → ^4.111.0` (all three Workers) and `miniflare ^4.20260702.0 → ^4.20260710.0` (web); both bundle `workerd@1.20260710.1`. `compatibility_date` set to **`2026-07-10`** on all three Workers (`apps/web`, `apps/api`, `apps/datatool`) — matched to the bundled workerd so local `wrangler dev` emits no "compat date ahead of runtime" warning; the date bump enabled **no new default compat flag** (web keeps `nodejs_compat`; api/datatool stay flag-free). `@cloudflare/workers-types` was bumped **past the WC-2 AC's "4.x" ceiling to the new 5.x major** (`^5.20260716.1`) on `apps/api` + `apps/datatool` — the 4.x line stopped at `4.20260702.1`, `wrangler 4.111` peer-wants `^5.x`, and the bump clears the peer warning with typecheck/tests green (drizzle-orm's `>=4` optional peer is satisfied). `wrangler types` still nudges dropping the package altogether in favour of generated runtime types. **Remaining follow-up (not WC-2):** drop `@cloudflare/workers-types` and point `apps/api` / `apps/datatool` `tsconfig` at the generated `worker-configuration.d.ts` (as `apps/web` already does). Toolchain still clears all cache floors.

> **Update — WC-5 done (AECI-319, 2026-07-16).** The cross-Worker purge Queue (§3) is live. A new `CachePurgeMessage` contract (`{ tags?, pathPrefixes?, purgeEverything?, source }`) + `CACHE_PURGE_QUEUE_MAX_TAGS = 1000` live in `@aeci/shared` (`packages/shared/src/cache-purge.ts`). **Producers:** the API Worker's `CACHE_PURGE_QUEUE` binding — `purgeAfterPromote`, the ordered `refreshHomeStatsAfterPromote` home flow (recompute `stats_cache` FIRST, then enqueue `index:home`), and review moderation (`admin-reviews.ts` `purgeProductTag`, `source:moderation`) — all replaced their `callCloudflarePurge` calls with `queue.send({ tags, source })`. **Consumer:** a `queue()` handler on the SSR Worker (`apps/web/src/server/cache-purge-queue.ts`, wired into the default export in `server.ts`) issues `ctx.cache.purge()` and emits `aeci.cache.purge{source,outcome}` (`ok`/`purge_failed`/`no_cache`/`noop`; retry on `!success`). Queues `aeci-cache-purge-{staging,demo,production}` are provisioned by the idempotent `create_queue` step in `deploy.yml` / `promote-to-demo.yml` / `promote-to-prod.yml` (before the SSR deploy). Producer/consumer bindings are per-env in the two `wrangler.jsonc` (staging/demo/production only — no queue on preview/local, a graceful no-op). **Built against the current single-default-entrypoint model** (WC-4's gateway/`Renderer` split has not landed; this issue depends only on WC-2/WC-3), so the purge runs from the default-export `queue()` handler — see the load-bearing consequence in §2: **WC-4 must relocate the purge into the `Renderer` entrypoint**, or the entrypoint-scoped `ctx.cache.purge()` will silently no-op. `CF_ZONE_ID` kept; `CF_PURGE_API_TOKEN` still in use by SSR `/admin/purge` (WC-6) until WC-10. Verified via unit tests; the deployed-staging `Cf-Cache-Status: MISS`-after-promote assertion (Q3) runs post-merge on staging.

## Decision

Adopt **native Workers Cache on the SSR Worker**, and solve the two hard parts as follows.

### 1. Enablement (WC-3) — per-env, prod-gated

`cache: { enabled: true }` is added per **environment** in `apps/web/wrangler.jsonc` (never at top level, so bare `wrangler dev` stays uncached), rolled out **preview → staging first**. The manual `caches.default` match/put pipeline in `handleSsr` is removed; the platform stores from the response's `Cache-Control` and serves HITs before the Worker runs.

**Prod-enable gate:** do **not** set `cache.enabled` on the `demo` or `production` web envs (the two public tiers) until **WC-4 (normalization), WC-5 (queue purge), WC-6 (`/admin/purge` native), and WC-8 (observability + `noindex`)** are merged and validated on staging. Enabling prod early would lose utm de-fragmentation, promote-driven invalidation, and — critically — the `noindex`-on-HIT guarantee.

### 2. Cache-key normalization (WC-4) — gateway + cached named entrypoint

Use Cloudflare's documented **gateway pattern**. The SSR Worker exposes two entrypoints in one Worker:

- A **gateway** = the **default** entrypoint, with `cache.enabled: **false**` (it must run on every request). It normalizes the URL exactly as `cacheKeyUrl()` does today (strip non-allowlisted params incl. `utm_*`, apply the per-route `cacheKeyParams` allowlist, `searchParams.sort()`), then forwards via a loopback `ctx.exports.Renderer.fetch(request, { cf: { cacheKey } })`. A custom `cf.cacheKey` **replaces the path+query** in the key, so passing the normalized string reproduces our invariants precisely.
- A **cached renderer** = a **named** `WorkerEntrypoint` (e.g. `Renderer`), with `cache.enabled: **true**`. It performs the SSR render and sets `Cache-Control` + `Cache-Tag`. Because the cache sits in front of *its* `fetch()`, HITs skip the render.

Per-entrypoint config uses the wrangler `exports` block: `{ "default": { "cache": { "enabled": false } }, "Renderer": { "cache": { "enabled": true } } }`.

> **Load-bearing consequence for WC-5:** the cached entries live in the **`Renderer` entrypoint's** namespace, and `ctx.cache.purge()` is scoped to the entrypoint that calls it. **All purges must be issued from the `Renderer` entrypoint** — the queue consumer must dispatch the purge into `Renderer`, not the gateway or an arbitrary handler.

> **Update — WC-4 done (AECI-318, 2026-07-16).** Shipped as designed. `apps/web/src/server.ts` now exports a **`Renderer`** named `WorkerEntrypoint` (delegates to the existing Hono `app`, forwarding `this.env`/`this.ctx` so Hono's `waitUntil` still fires) and a **`default`** gateway (`cacheGateway` in `server-runtime.ts`) that, for GET/HEAD, computes `cacheKeyFor(url)` and forwards the *original* request via `ctx.exports.Renderer.fetch(request, { cf: { cacheKey } })` (non-GET forwards with no custom key). Per-entrypoint config landed on **preview + staging** as `exports: { "default": { "type": "worker", "cache": { "enabled": false } }, "Renderer": { "type": "worker", "cache": { "enabled": true } } }` — note the **`"type": "worker"`** field is required per entry (a delta from the shorthand sketched above); `demo`/`production` ship the same two-entrypoint code but stay uncached (no `cache`/`exports` block) until WC-5/6/8. Two intentional refinements vs. the original `cacheKeyUrl`: (1) `cacheKeyFor` is **path-relative** — a custom `cf.cacheKey` replaces path+query only, so origin is dropped (each env / Worker version is already an isolated cache namespace); and (2) it **value-sorts multi-select facet CSVs** (`MULTI_VALUE_CACHE_KEY_PARAMS`), so a raw/hand-typed/bot `?category_id=b,a` collapses onto `a,b` at the cache layer, not solely via the producer sidebar. `cloudflare:workers` was already externalized in `apps/web/angular.json`. **Redirect fallout:** because the gateway now normalizes (query-strips) the edge key for every GET, standalone 301s whose `Location` embeds the request query — the `/disciplines/* → /audiences/*` redirect and the apex→`www` canonical flip both preserve `${url.search}` — were switched from the `public`/`s-maxage` TTL to `Cache-Control: private, max-age=3600` (browser-cacheable, edge-EXCLUDED) and had their `Cache-Tag` dropped; otherwise distinct-query links would collapse onto one edge entry and be served the first-warmed `Location` (the apex case is latent today since prod is uncached, but hardened now so enabling prod caching in WC-5/6/8 can't silently mis-route the naked domain). See `docs/CACHE_STRATEGY.md` §4a. Unit coverage: `apps/web/src/cache-key-url.spec.ts` (reworked to `cacheKeyFor` + the gateway loopback), plus the redirect assertions in `server.spec.ts`. The load-bearing WC-5 consequence above still holds — purges must originate from `Renderer`.

### 3. Cross-Worker purge (WC-5) — Cloudflare Queue, SSR consumer

A new **Cloudflare Queue** (e.g. `aeci-cache-purge-{env}`) decouples purge producers from the SSR cache:

- **Producers** — the API Worker (`POST /api/promote`, `/admin/reviews` removal) and datatool enqueue a typed purge message (`{ tags }` / `{ pathPrefixes }` / `{ purgeEverything }`).
- **Consumer** — a `queue()` handler **on the SSR Worker** calls its own `ctx.cache.purge({ tags })` from the **`Renderer`** entrypoint. This mirrors the existing ADR 0013 cron→queue→consumer shape, and reuses the inline-fallback pattern for local/preview where no queue is bound.

This is exactly ADR 0010's deferred **Option C**, now justified: `ctx.cache.purge()` is entrypoint-scoped, the zone HTTP purge is inert, and there is more than one cross-Worker producer (promote + datatool). The Queue adds retry/DLQ durability and back-pressure for bulk purges.

### 4. `POST /admin/purge` (WC-6) and datatool (WC-7)

`/admin/purge` (manual/incident + CI surface) is migrated to enqueue onto the same purge Queue (or call `ctx.cache.purge()` directly if it lives on the SSR Worker's `Renderer` context). Datatool's broad post-copy/seed/reindex purge (`BROAD_CACHE_TAGS`) enqueues a `purgeEverything` (or broad-tag) message. The HTTP transport (`callCloudflarePurge`) and its `CF_PURGE_API_TOKEN` are retired in WC-10 once all three call sites are on the Queue.

### 5. Resolutions of the six open questions

| # | Question | Resolution | Rationale |
|---|---|---|---|
| 1 | `cross_version_cache` | **Leave at the default (per-version isolation; `false`/unset) for the initial rollout.** Adopt `true` later once a post-deploy `purgeEverything` step exists and traffic justifies it. | **This refines the plan doc's initial `true` lean.** With the default, every SSR deploy starts from a cold cache, so a **template/markup change is automatically live** on the first post-deploy request — zero deploy-time ops. The plan's "rely on tag purge" rationale for `true` has a gap: tag purge invalidates *data* changes (a product row → `product:slug`), but a *code/template* deploy changes **every** page's HTML and would need `purgeEverything`, not tag purge — so `true` would serve stale markup up to the TTL (≤15 min) after each deploy unless CI purges everything. At current traffic the re-warm cost of the default is negligible, and the flag is a one-line, trivially reversible change. |
| 2 | Cache-key normalization | **Gateway entrypoint (Option A).** | Preserves utm-strip / per-route allowlist / canonical order (AECI-100/143/223) via `cf.cacheKey` on the loopback. Option B (accept fragmentation) would regress those tickets. |
| 3 | Local-dev / miniflare | **Assume front-of-Worker HIT/MISS is not locally emulated; verify behavior on a deployed preview.** WC-9 local-dev asserts Worker-side observables only. | Workers Cache is an edge-tier behavior (HIT ⇒ Worker never runs); `wrangler dev`/miniflare runs the Worker with no edge tier in front, and Cloudflare's own debugging guide verifies `Cf-Cache-Status` HIT/MISS **only against deployed `*.workers.dev` URLs**. miniflare 4.20260702.0 *does* parse the `cache` config block (confirmed by grep of its dist), but a local HIT/skip emulation is unconfirmed → treat as a deployed-preview assertion. |
| 4 | `stale-if-error` / `stale-while-revalidate` | **Defer.** Keep the migration behavior-preserving; record SWR/SIE as a post-cutover resilience enhancement candidate for detail/index routes. | Adopting SWR/SIE changes freshness semantics and adds scope to WC-3; land the like-for-like migration first, then opt in deliberately. |
| 5 | API Worker cache | **Stays disabled.** No `cache` block on `apps/api`; responses keep `Cache-Control: private, no-store` (`apps/api/src/http.ts`). | API responses are visitor/DB-state-specific; caching them is unsafe and out of scope. A future cache-worthy GET can opt in per-entrypoint. |
| 6 | Queue vs service-binding for cross-Worker purge | **Queue.** The ADR explicitly rejects a direct SSR service-binding purge call. | Decoupling, retry/DLQ durability, and back-pressure for bulk purges; avoids re-introducing a synchronous web↔api coupling (the very cycle ADR 0010 removed). |

## Spike findings (WC-1)

Grounded in the Cloudflare Workers Cache docs (overview / configuration / cache-keys / purge / limitations / debugging) + a read-only check of the in-repo toolchain. The **live-preview `Cf-Cache-Status` HIT/MISS confirmation is deferred** to a real deploy (agent workspaces run local miniflare only) — tracked as a follow-up before WC-3 lands on staging.

- **Enablement floor met:** `wrangler 4.107.1` / `miniflare 4.20260702.0` clear both the `cache.enabled` (≥4.69.0) and per-entrypoint/`cross_version_cache` (≥4.107.0) floors. WC-2 is only a compat-date bump.
- **Gateway pattern is officially supported and exact:** the docs' "Custom cache keys" example is our WC-4 design 1:1 — gateway (default, cache off) sets `cf.cacheKey` on `ctx.exports.<Cached>.fetch()`; the custom key **replaces path+query**; the callee is the cached entrypoint. `ctx.props` and target entrypoint remain part of the key (multi-tenant isolation preserved).
- **Purge is entrypoint-scoped** (confirmed): tags are scoped to the calling entrypoint; no zone-level purge (dashboard/API/Terraform) touches Workers Cache. ⇒ the zone HTTP purge is inert (validates the Queue requirement), and purges must originate from the cached `Renderer` entrypoint.
- **Cacheability rules** relevant to us: only `GET`/`HEAD`; `Set-Cookie` responses and `Authorization` requests **BYPASS** unless `Cache-Control: public`; `no-store`/`private` ⇒ `BYPASS`; `520–526` and Worker-returned `206` are never cached; default no-`Cache-Control` TTLs are 200→2h / 404→3m / 301→20m (we set explicit `Cache-Control`, so defaults don't bite).
- **`cross_version_cache` nuance** (drives Q1): default = version-in-key ⇒ each deploy cold-starts and takes effect immediately; `true` = shared across versions ⇒ warm across deploys **but** a content-shape change needs `purgeEverything`/version-tag to apply before TTL.
- **Local-dev:** see Q3 — no confirmed local HIT/MISS emulation; deployed-preview verification required.

## Rejected alternatives

- **Keep the hand-rolled `caches.default` pipeline.** Rejected: the Worker runs on every request (no CPU/latency win, no request-collapsing/tiered cache), and we keep maintaining bespoke match/put + key-normalization + an out-of-band HTTP purge.
- **Direct SSR service-binding purge call** (API → SSR RPC to trigger `ctx.cache.purge()`). Rejected (Q6): re-introduces the synchronous web↔api coupling ADR 0010 removed, with no retry/DLQ/back-pressure. The Queue gives durability and decoupling for the same job.
- **Accept query-string fragmentation** (no gateway; Option B). Rejected (Q2): regresses AECI-100/143/223 — `utm_*`/facet-order would fragment the cache for query-independent and listing pages.
- **`cross_version_cache: true` from day one.** Rejected for the initial rollout (Q1): needs a post-deploy `purgeEverything` step to avoid stale markup after template deploys; adopt once that step and hit-rate data exist.

## Consequences

- ➕ **HITs skip the Worker** — lower SSR CPU + cost and lower latency; **request-collapsing + tiered cache** are on by default (both absent from `caches.default` today).
- ➕ **Less bespoke code:** the manual match/put and `cacheKeyUrl`-as-cache-key logic collapse into a thin gateway that only sets `cf.cacheKey`; the platform owns storage/eviction.
- ➕ **Purge needs no token** from inside the Worker (`ctx.cache.purge()`), and the Queue gives **retry/DLQ durability + back-pressure** for bulk purges.
- ➕ **Optional resilience** later via `stale-if-error` / `stale-while-revalidate` (deferred, Q4).
- ➖ **New infra:** a Cloudflare Queue (producers on API/datatool, consumer on SSR) and a **two-entrypoint** SSR Worker (gateway + `Renderer`). More moving parts than a single fetch handler.
- ➖ **Reverses ADR 0010's "no web↔api coupling"** — reintroduces a cross-Worker dependency, but **asynchronously** via the Queue (not a binding cycle).
- ➖ **Purge discipline is now entrypoint-bound:** every purge must originate from the `Renderer` entrypoint or it silently no-ops. This is a new, easy-to-get-wrong invariant to test (WC-9).
- ➖ **Cache-warmth vs deploy-freshness tradeoff** is now an explicit knob (`cross_version_cache`); defaulting to per-version means each deploy re-warms the cache.
- ➖ **Billing shift:** cache HITs consume no CPU, but static-asset requests and worker-to-worker (loopback) invocations become billable once caching is enabled.
- ➖ **Local-dev gap:** front-of-Worker HIT/MISS isn't reliably reproducible under miniflare; parts of the model can only be verified on a deployed preview (WC-9).
- ↔ **Unchanged (don't-break):** API Worker cache stays disabled (`no-store`); cookie-strip stays on the miss/uncacheable path; the ordered **refresh-stats-then-purge** home flow is preserved (now emitting onto the Queue); `CF_ZONE_ID` is **kept** (still consumed by the AECI-262 WAF analytics poll — WC-10 must not delete it wholesale, even when `CF_PURGE_API_TOKEN` is pruned).
