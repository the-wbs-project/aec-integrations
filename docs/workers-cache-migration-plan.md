# Workers Cache Migration — Linear Issues to Create

**Status:** Planning (captured here because the Linear MCP is temporarily unavailable — 2026-07-07)
**Branch:** `chris-walton-wbs/workers-cache-migration`
**Author:** planning pass from the "Plan Workers Cache" session (transcript in `.context/attachments/amTu0N/`)
**Origin:** Cloudflare shipped **[Workers Cache](https://developers.cloudflare.com/workers/cache/)** — a native cache that sits *in front of* a Worker (a cache HIT never runs the Worker), configured with `cache.enabled` in `wrangler.jsonc` and purged from inside the Worker with `ctx.cache.purge()`. It can replace most of the hand-rolled edge-cache machinery we built in Phase 2 (manual `caches.default` match/put + an HTTP purge-by-tag transport).

> **How to use this file:** each `### Issue N` block below is a ready-to-paste Linear issue (Title + Context + Scope + Acceptance Criteria + Dependencies + Docs + Risk). Create them under a parent/epic issue on the **AECI** team, base branch `stage-2` unless noted (this is Stage 2 platform work, not a prod hotfix — see `CLAUDE.md` "Git workflow"). Issue numbers are TBD (assign on creation); cross-references below use the handle `WC-N` as a placeholder.

---

## 1. Why this is worth doing

Today (Phase 2 design, `docs/CACHE_STRATEGY.md`) the SSR Worker **runs on every request** and, inside the Worker, does an explicit `caches.default.match()` / `.put()` against a URL it normalizes by hand (`cacheKeyUrl`), then a separate **HTTP** `POST /zones/{zone}/purge_cache` call invalidates by tag. Native Workers Cache collapses most of that:

| Concern | Today (manual) | With Workers Cache |
|---|---|---|
| Cache lookup | Worker runs, calls `caches.default.match()` | Platform checks cache **before** the Worker runs — HIT ⇒ zero Worker CPU |
| Cache write | `ctx.waitUntil(cache.put(key, res.clone()))` | Platform stores from the response's `Cache-Control` |
| Key normalization | `cacheKeyUrl()` strips `utm_*`, applies per-route allowlist, sorts params | Full **order-sensitive** query string by default (⚠️ see WC-4) |
| Tag purge | HTTP `callCloudflarePurge()` + scoped CF token + zone id | `ctx.cache.purge({ tags })` — Instant Purge, no token, but **same-Worker only** (⚠️ see WC-5) |
| Request collapsing / tiered cache | none | on by default |
| Stale-while-revalidate / stale-if-error | none | available via `Cache-Control` |

**Benefits:** lower SSR CPU + cost (HITs skip the Worker), lower latency (tiered cache + request collapsing), less bespoke code, resilience via `stale-if-error`.

**The two hard parts** (they drive the issue list, not the enablement itself):

1. **Cross-Worker purge (WC-5).** `ctx.cache.purge()` only purges the **calling entrypoint's own** cache, and "no zone configuration for caching applies to Workers Caching" — so the zone-level HTTP purge (`callCloudflarePurge`) will **not** evict Workers Cache. But our writer (`POST /api/promote`) lives in the **API Worker** and must invalidate **SSR HTML** cached in front of the **SSR Worker**. Resolution: the API Worker (and datatool) enqueue purge messages onto a **Cloudflare Queue**; a **consumer on the SSR Worker** calls its own `ctx.cache.purge()`. This is the "Should the API call a queue to purge?" question from the transcript — **approved**. It **reverses ADR 0010** (which had removed the web↔api coupling), so it needs a new ADR.

2. **Cache-key normalization (WC-4).** `cf.cacheKey` can only be set on the **calling side** of a service-binding/`ctx.exports` call, not on a direct eyeball request. To keep AECI-100/143/223 (strip `utm_*`, per-route param allowlist, canonical param order, multi-select facet CSV sorting) we either (a) add a thin **gateway entrypoint** that normalizes the URL and forwards to a named `Renderer` entrypoint with `cf.cacheKey`, or (b) accept query-string fragmentation and enforce producer-side param ordering. Decision needed.

---

## 2. Key facts pinned from the Cloudflare docs (source for the ACs)

- **Enable:** `"cache": { "enabled": true }` in `wrangler.jsonc`. Requires **Wrangler ≥ 4.69.0**; **per-entrypoint** `cache` config requires **≥ 4.107.0**. Can be set per-env (`env.<name>.cache`). `cross_version_cache: true` shares cache across Worker versions (default: each version is isolated ⇒ **every deploy cold-starts the cache**).
- **What's cached:** `GET`/`HEAD` only; applies to eyeball requests, **service-binding calls, and loopback fetches**. `Set-Cookie` responses and `Authorization` requests **BYPASS** (unless `Cache-Control: public`). `520–526` and `206` never cached.
- **Cache key =** entrypoint + path + **full, order-sensitive query string** + Worker version + `ctx.props`. **Not** cookies, **not** method (GET/HEAD share), **not** host. `?a=1&b=2` ≠ `?b=2&a=1`; trailing slash matters.
- **Control:** standard `Cache-Control` (`max-age`, `s-maxage`, `stale-while-revalidate`, `stale-if-error`, `no-store`/`private`). Header precedence: `cloudflare-cdn-cache-control` > `cdn-cache-control` > `Cache-Control`. No-`Cache-Control` defaults: 200→2h, 404→3m, 301→20m.
- **Purge:** `ctx.cache.purge({ tags | pathPrefixes | purgeEverything })` (or `import { cache } from "cloudflare:workers"`). Modes union; `purgeEverything` is exclusive. Returns `{ success, errors }`. **Entrypoint-scoped — cannot reach another Worker's or entrypoint's cache.** Tags attached via `Cache-Tag` response header: **≤ 1000 tags/response, ≤ 1024 chars/tag, printable ASCII, case-insensitive**. No "purge by host" (host isn't in the key).
- **Debug:** `Cf-Cache-Status` header (`HIT`/`MISS`/`EXPIRED`/`BYPASS`/`DYNAMIC`/`REVALIDATED`/`UPDATING`/`STALE`) + per-invocation cache-hit info in the Workers observability dashboard.
- **Billing:** cache HITs consume no CPU, but static-asset requests and worker-to-worker invocations become billable when caching is enabled.

**Current versions in-repo (already meet the floors):** `wrangler ^4.107.0`, `@cloudflare/workers-types ^4.20260702.1`, `miniflare ^4.20260702.0`. Compat dates: web `2026-05-14`, api `2026-04-07`, datatool `2026-04-07`.

**Current code touch-points (for the ACs):**
- Manual pipeline: `apps/web/src/server-runtime.ts` → `handleSsr` (`getEdgeCache`, `cacheKeyUrl`, `cache.match`, `cache.put`), plus `ROUTE_CACHE_PATTERNS` / `cacheControlForRoute` / `buildCacheControl`.
- Tag emission: `apps/web/src/server/cache-tags.ts` (`buildCacheTags`, `cacheTagInputsForPath`).
- HTTP purge transport: `packages/shared/src/cache-purge.ts` (`callCloudflarePurge`, `CF_PURGE_MAX_TAGS = 30`).
- Promote purge: `apps/api/src/routes/promote.ts` (`purgeAfterPromote`, `refreshHomeStatsAfterPromote`, fired via `ctx.waitUntil`) + tags from `apps/api/src/routes/promote-cache-tags.ts` (`cacheTagsForPromote`).
- Manual/incident purge: `apps/web/src/server/routes/admin-purge.ts` (`createAdminPurgeHandler`; auth `ADMIN_PURGE_TOKEN`; CF creds `CF_PURGE_API_TOKEN` + `CF_ZONE_ID`).
- datatool bulk purge: `apps/datatool/src/cache-purge.ts` (`purgeEnvCache`, `BROAD_CACHE_TAGS`).
- Egress `X-Robots-Tag` stamp: `createApp` middleware in `server-runtime.ts` (runs *after* the cache write today).
- Observability: `aeci.ssr.render`, `aeci.page.render.duration_ms`, `aeci.cache.purge` → `docs/OBSERVABILITY.md`.
- `CF_ZONE_ID` is **also** consumed by the AECI-262 WAF analytics poll — do **not** delete it wholesale.

---

## 3. Issues to create

### Issue WC-1 — ADR + spike: adopt Workers Cache; cross-Worker purge via Queue

**Type:** ADR / spike (no prod behavior change)
**Spec section:** new ADR `docs/adr/0020-workers-cache-and-queue-purge.md`

**Context.** Records the decision to move from manual `caches.default` + HTTP purge-by-tag to native Workers Cache, and — because `ctx.cache.purge()` is entrypoint-scoped — to invalidate cross-Worker via a Cloudflare Queue consumed by the SSR Worker. **Amends ADR 0004** (Pro plan + Cache-Tag purge) and **reverses ADR 0010** (promote purges Cloudflare directly / no web↔api coupling).

**Scope.**
- Write ADR 0020 (Accepted): context, the entrypoint-scope + zone-purge-doesn't-apply constraints, the queue design, `cross_version_cache` choice, per-env rollout, rejected alternatives (keep manual; service-binding call back to SSR instead of queue; accept staleness).
- Add "Superseded/Amended by ADR 0020" banners to ADR 0004 and ADR 0010.
- Time-boxed spike on a **preview** Worker: set `cache.enabled`, emit `Cache-Tag`, confirm `Cf-Cache-Status: HIT/MISS` and that `ctx.cache.purge({tags})` evicts. Capture findings (esp. **local-dev / miniflare behavior** and whether the zone HTTP purge is truly inert against Workers Cache) in the ADR.
- Draft the rewritten `docs/CACHE_STRATEGY.md` outline (full rewrite lands in WC-11).

**Acceptance criteria.**
- ADR 0020 merged, indexed in `docs/adr/README.md`, cross-linked from 0004 and 0010.
- Spike findings documented: enable, HIT/MISS, tag purge, local-dev behavior.
- `cross_version_cache` decision recorded with rationale.

**Dependencies:** none (do first). **Docs:** ADR 0020, ADR 0004, ADR 0010, `docs/adr/README.md`. **Risk:** low.

---

### Issue WC-2 — Upgrade Cloudflare Workers toolchain + bump compatibility dates

**Type:** chore
**Context.** The user's explicit ask: "upgrade the workers library to the latest version." We already exceed the cache floors (`wrangler ^4.107.0`, per-entrypoint needs 4.107.0), so this is mostly a patch bump + a `compatibility_date` bump to a date that GAs Workers Cache and picks up current runtime semantics.

**Scope.**
- Bump `wrangler`, `@cloudflare/workers-types`, and `miniflare` to latest 4.x across `apps/web`, `apps/api`, `apps/datatool` (+ root lockfile).
- Bump `compatibility_date` on all three Workers to a single agreed recent date (spike-confirmed; docs example uses `2026-07-07`).
- Re-run `wrangler types` (`cf-typegen`) per Worker; commit regenerated types.
- `pnpm typecheck && pnpm build && pnpm test` green; smoke `wrangler dev` per Worker.

**Acceptance criteria.** Deps + compat dates bumped; types regenerated; monorepo typecheck/build/test/lint green; no runtime regressions in `wrangler dev`.

**Dependencies:** WC-1 (agree the compat date). **Docs:** none beyond changelog. **Risk:** low–medium (compat-date bump can shift runtime defaults — diff the compat-flags report).

---

### Issue WC-3 — Enable Workers Cache on the SSR Worker; remove the manual `caches.default` pipeline

**Type:** feature (core)
**Spec section:** `docs/CACHE_STRATEGY.md` §4–§6 (rewrite in WC-11)

**Context.** Flip on native caching for the SSR Worker and delete the hand-rolled match/put. Enablement and removal **must land together** — running both means the platform caches in front *and* the Worker caches inside (double cache, divergent keys). Roll out per-env via the `cache` env-map: **preview → staging → demo → production**.

**Scope.**
- `apps/web/wrangler.jsonc`: add `"cache": { "enabled": true }` (per-env; consider `enabled:false` on preview/staging first, then flip). Decide `cross_version_cache` per WC-1.
- `handleSsr` (`server-runtime.ts`): remove `getEdgeCache`, `cache.match`, `cache.put`, and the `cacheKeyUrl`-based `Request` key. Keep: route classification, `Cache-Control` via `buildCacheControl`, **`Cache-Tag` emission** (`buildCacheTags`), `NOT_FOUND_TTL`, cookie-strip on the miss path (still required — cache key excludes cookies, so a cookie-baked render would poison; `VISITOR_STATE_COOKIES` is empty today but the mechanism stays).
- Keep the non-cacheable branch authoritative: `/api/*`, `/auth/*`, `/account*`, `/search`, admin/review gates stay `private, no-store` ⇒ `Cf-Cache-Status: BYPASS/DYNAMIC`. Verify auth branches never cache (they carry `sb-…` cookies, not `Authorization`, so rely on `no-store`, not the auto-bypass).
- Confirm the standalone redirects (apex→www 301, `/disciplines`, `/vendors`, `/integrations`, pair redirect) still cache correctly under platform TTLs and keep their `Cache-Tag` for queue purge (WC-5).
- Consider `stale-if-error` / `stale-while-revalidate` on detail/index routes for resilience (optional; record decision).
- **Do NOT enable `cache` on the API Worker** — its responses are `private, no-store`, so caching there only adds billable worker-to-worker invocations. (The API Worker only becomes a queue *producer* in WC-5.)

**Acceptance criteria.**
- `cache.enabled` set per-env; manual `caches.default` code deleted; `pnpm test` updated + green (see WC-9).
- On a deployed preview: cacheable routes show `Cf-Cache-Status: MISS` then `HIT`; non-cacheable routes show `BYPASS`/`DYNAMIC`; 404 carries the short TTL.
- No visitor-state leakage (cookie-strip verified on miss path).

**Dependencies:** WC-1, WC-2. **Blocks prod enable on:** WC-4 (key normalization) and WC-5 (purge) landing first. **Docs:** `CACHE_STRATEGY.md`, `CLAUDE.md` cache bullet. **Risk:** high (core behavior change) — mitigate with per-env rollout.

---

### Issue WC-4 — Preserve cache-key normalization (utm strip, per-route allowlist, canonical order)

**Type:** feature / decision
**Spec section:** `docs/CACHE_STRATEGY.md` §4a (AECI-100 / AECI-143 / AECI-223)

**Context.** Workers Cache keys on the **full, order-sensitive** query string; `cf.cacheKey` is settable only on the calling side of a `ctx.exports`/service-binding call, not on a direct eyeball request. Without action we lose: `utm_*`/`fbclid`/`gclid`/`ref` stripping (marketing links fragment the cache — wasteful), per-route param allowlisting, canonical param ordering, and the multi-select-facet CSV-sort invariant (`category_id=a,b` vs `b,a`).

**Scope — pick one (recommend A):**
- **A. Gateway entrypoint.** Thin `default` entrypoint normalizes the URL (reuse `cacheKeyUrl` logic: strip non-allowlisted params, sort) and forwards to a named `Renderer` entrypoint via `ctx.exports.Renderer.fetch(req, { cf: { cacheKey: normalizedPathAndQuery } })`. Configure `cache` in front of `Renderer` (per-entrypoint config, Wrangler ≥ 4.107.0). Preserves AECI-100/143/223 exactly.
- **B. Accept fragmentation.** Drop `cacheKeyUrl`; document that `utm_*`-tagged links create distinct entries (correct, just less efficient), and guarantee **producer-side** canonical ordering (the facet sidebar already sorts values; confirm every content-affecting param is emitted in canonical order). Cheapest, but loses utm de-fragmentation and is fragile against bots/hand-typed param orders.

**Acceptance criteria.**
- Decision recorded (in WC-1's ADR or this issue). If A: `?utm_source=x` and the clean URL resolve to one cache entry; `?sort=name&page=2` == `?page=2&sort=name`; multi-select facet order-independence holds. If B: the trade-off is documented in `CACHE_STRATEGY.md` §4a and producer ordering is verified by tests.
- `cache-key-url.spec.ts` reworked to the chosen model.

**Dependencies:** WC-2 (per-entrypoint config needs ≥ 4.107.0), WC-3. **Docs:** `CACHE_STRATEGY.md` §4a. **Risk:** medium — under-normalization is a correctness bug for multi-select facets, not just perf.

---

### Issue WC-5 — Cross-Worker purge via Cloudflare Queue (promote → SSR cache)

**Type:** feature (infra)
**Spec section:** ADR 0020; `docs/CACHE_STRATEGY.md` §5

**Context.** `POST /api/promote` (API Worker) mutates data that's rendered into SSR HTML cached in front of the **SSR Worker**. Because purge is entrypoint-scoped and the zone HTTP purge doesn't touch Workers Cache, the API Worker can no longer invalidate the SSR cache directly (this is what ADR 0010 relied on). New design: **API Worker → Queue → SSR Worker consumer → `ctx.cache.purge()`**.

**Scope.**
- Provision per-env queues `aeci-cache-purge-{staging,demo,production}` (idempotent `wrangler queues create` in `deploy.yml` / `promote-to-demo.yml` / `promote-to-prod.yml`, matching the ADR 0013 pattern). No queue on preview/local (graceful no-op).
- **API Worker (producer):** add a `CACHE_PURGE_QUEUE` producer binding (per-env). Replace `purgeAfterPromote`'s `callCloudflarePurge` with a `queue.send({ tags })` (batched by the 1000-tag response limit, not the old 30). Keep `cacheTagsForPromote` (tag vocabulary unchanged). Keep the **ordered** home flow: `refreshHomeStatsAfterPromote` still recomputes `stats_cache` **first**, then enqueues the `index:home` purge (so the purge can't race ahead of the recompute).
- **SSR Worker (consumer):** add a `queue` handler that reads `{ tags }` and calls `ctx.cache.purge({ tags })`; emit `aeci.cache.purge{source:promote,outcome}` from here (moves off the API Worker). Register the consumer per-env in `apps/web/wrangler.jsonc`.
- Message contract in `@aeci/shared` (typed payload: `{ tags: string[] }`, room for `pathPrefixes` / `purgeEverything`).
- Handle failure/retries (queue `max_retries`; `ctx.cache.purge()` returns `{success,errors}` — retry on `!success`).

**Acceptance criteria.**
- A promote on staging enqueues a purge; the SSR consumer evicts the tags (verified via `Cf-Cache-Status: MISS` on the affected URL after promote).
- Home flow still ordered (stats refreshed before `index:home` purge).
- `aeci.cache.purge` metric fires from the SSR consumer; failures are retried/logged.
- Graceful no-op where the queue is absent (preview/local).

**Dependencies:** WC-2, WC-3. **Prereq:** Workers Paid plan + CI token has Queues edit (already true for ADR 0013 queues). **Docs:** `CACHE_STRATEGY.md` §5, `environments.md`, `CICD_PLAN.md`, ADR 0010/0020, both `wrangler.jsonc` header comments. **Risk:** high — this is the crux; test the queue path end-to-end on staging before prod.

---

### Issue WC-6 — Migrate `POST /admin/purge` to native `ctx.cache.purge()`

**Type:** feature
**Spec section:** `docs/CACHE_STRATEGY.md` §5(a)

**Context.** `/admin/purge` lives **on the SSR Worker**, so it *can* purge the SSR cache natively — no queue needed. Swap the HTTP transport for `ctx.cache.purge()`.

**Scope.**
- `createAdminPurgeHandler`: replace `callCloudflarePurge(...)` with `ctx.cache.purge({ tags })`; keep `ADMIN_PURGE_TOKEN` caller auth. Optionally support `pathPrefixes` / `purgeEverything` in the body (new modes the platform now offers).
- Drop the SSR Worker's dependence on `CF_PURGE_API_TOKEN` + `CF_ZONE_ID` for purge (retire in WC-10). Adjust the 30-tag cap (`PurgeRequestSchema` `.max(CF_PURGE_MAX_TAGS)`) to the platform's higher limit.
- Update response shape to reflect `{success, errors}`.
- Keep CI's post-promote reference-data purge (`promote-to-prod.yml` purging `taxonomy` + `route:browse`) working — it calls `/admin/purge`, so it inherits the new backend automatically; verify.

**Acceptance criteria.** `/admin/purge` evicts via `ctx.cache.purge()` (verified on a deployed env); auth unchanged; specs updated (`admin-purge.spec.ts`); CI purge step still succeeds.

**Dependencies:** WC-3. **Docs:** `CACHE_STRATEGY.md` §5, `admin-purge.ts` doc-comment. **Risk:** medium.

---

### Issue WC-7 — datatool bulk purge via the purge queue

**Type:** feature
**Context.** `apps/datatool` (a *third* Worker) purges the whole zone by broad `route:*` tags after a copy/seed/reindex via `callCloudflarePurge`. It also can't reach the SSR cache directly, so it must enqueue onto the target env's purge queue (WC-5).

**Scope.**
- `apps/datatool/src/cache-purge.ts`: replace `purgeEnvCache`'s `callCloudflarePurge` with a `queue.send()` to the target env's `aeci-cache-purge-{env}` (or a `{ purgeEverything: true }` message — broad blast is the datatool's intent). Add the producer binding per target env in `apps/datatool/wrangler.jsonc`.
- Preserve the existing "purge is best-effort / graceful skip when unconfigured" behavior; preview (`*.workers.dev`) stays a no-op.
- Note the current cross-tier caveat (shared zone) is moot under per-Worker caches — each env's SSR Worker has its own cache, so a purge no longer bleeds across tiers. Update the doc-comment.

**Acceptance criteria.** A datatool copy/seed to staging enqueues a purge that the staging SSR consumer applies; other tiers unaffected; graceful skip preserved.

**Dependencies:** WC-5. **Docs:** `cache-purge.ts` doc-comment, `project_datatool_admin_worker` context. **Risk:** medium.

---

### Issue WC-8 — Observability + `X-Robots-Tag` under a front-of-Worker cache

**Type:** feature
**Spec section:** `docs/OBSERVABILITY.md`, `docs/CACHE_STRATEGY.md` §7.1

**Context.** On a HIT the Worker doesn't run, which breaks three egress-time behaviors that currently re-run on every HIT.

**Scope.**
- **`X-Robots-Tag`:** today it's stamped *after* the cache write and re-stamped each HIT. With the cache in front, the Worker doesn't run on HIT, so **bake the noindex directive into the response before it's cached** (env-specific bake is safe — each env is its own Worker + cache with its own `ALLOW_INDEXING`). Remove the after-cache re-stamp. Verify the CSP/SEO header set (`applySeoHeaders`) is likewise baked pre-cache.
- **Page views:** `firePageView` on HIT no longer fires (Worker skipped). The browser `PageViewTracker` (AECI-151) is already canonical and the SSR-side signal already undercounts, so document the change; do not try to count HITs from the Worker.
- **Metrics:** `aeci.ssr.render` and `aeci.page.render.duration_ms` `cache_status:hit` branches won't emit. Move HIT visibility to `Cf-Cache-Status` + the Workers observability dashboard; update the Datadog dashboards/monitors that split on `cache_status:hit` so they don't read as "traffic dropped." Keep MISS/non-cacheable metrics.
- Add a lightweight HIT-rate panel sourced from Workers analytics (or accept the dashboard as the HIT surface).

**Acceptance criteria.** Deployed non-indexable env still returns `X-Robots-Tag: noindex` on **both** MISS and HIT; indexable prod does not; SEO/CSP headers present on cached payloads; OBSERVABILITY.md + affected monitors updated; no false "SSR render dropped" alerts.

**Dependencies:** WC-3. **Docs:** `OBSERVABILITY.md`, `RUNBOOKS.md`, `CACHE_STRATEGY.md` §7/§7.1. **Risk:** medium — the noindex bake is a launch-safety item; get it right.

---

### Issue WC-9 — Tests + local-dev verification for the new cache model

**Type:** test
**Spec section:** `docs/TESTING_STRATEGY.md`, `docs/UNIT_TESTING_GUIDE.md`

**Context.** The manual-cache unit tests (asserting `caches.default.match/put`) become obsolete; new coverage targets headers, the normalization gateway, the queue purge, and the noindex bake. Local-dev cache behavior (miniflare) must be pinned down (docs don't state it).

**Scope.**
- Rewrite/retire `apps/web/src/cache-key-url.spec.ts`, and the `handleSsr` cache assertions in `server.spec.ts` / `server-runtime` tests, to the header + gateway model.
- Add tests: `Cache-Control`/`Cache-Tag` correctness per route; gateway normalization (WC-4); SSR queue purge consumer (WC-5); `/admin/purge` native path (WC-6); noindex baked pre-cache (WC-8).
- Confirm `wrangler dev`/miniflare cache behavior (active vs no-op) and document it so local expectations are correct.
- Add an e2e assertion on `Cf-Cache-Status` (MISS→HIT) against the deployed preview/staging (mind the parked preview-URL e2e jobs).
- Update `TESTING_STRATEGY.md` with the new cache-testing approach.

**Acceptance criteria.** Suite green; obsolete manual-cache tests removed; new coverage for headers/gateway/queue-purge/noindex; local-dev behavior documented; e2e `Cf-Cache-Status` check added.

**Dependencies:** WC-3..WC-8. **Docs:** `TESTING_STRATEGY.md`. **Risk:** medium.

---

### Issue WC-10 — Retire the HTTP purge transport + prune now-unused secrets

**Type:** chore / cleanup
**Context.** Once promote (WC-5), `/admin/purge` (WC-6), and datatool (WC-7) all purge natively/via-queue, the HTTP purge-by-tag path is dead.

**Scope.**
- Remove `callCloudflarePurge` + `CF_PURGE_MAX_TAGS` from `packages/shared` (and `@aeci/shared` re-exports) once no caller remains; delete `cache-purge.spec.ts`.
- Remove `CF_PURGE_API_TOKEN` usage + the CI push steps that set it (`deploy.yml`, `promote-to-demo.yml`, `promote-to-prod.yml`) on **both** Workers; delete the GH secrets.
- **Keep `CF_ZONE_ID`** — it's still consumed by the AECI-262 WAF analytics poll. Only remove its purge-related consumption.
- Verify no dangling references (`grep` for `callCloudflarePurge`, `CF_PURGE_API_TOKEN`, `purge_cache`).

**Acceptance criteria.** Transport + token removed; `CF_ZONE_ID`/WAF poll intact; typecheck/build/test/lint green; CICD/env docs updated.

**Dependencies:** WC-5, WC-6, WC-7. **Docs:** `CICD_PLAN.md`, `environments.md`, `CACHE_STRATEGY.md` §5. **Risk:** medium — sequence last; don't strip the token before every caller has migrated.

---

### Issue WC-11 — Documentation sweep

**Type:** docs
**Context.** Per the "update all documents" working preference, a final pass reconciles every cache-related doc with the shipped design (most updates fold into WC-1..WC-10; this catches the remainder).

**Scope.**
- **Rewrite `docs/CACHE_STRATEGY.md`**: §1 plan note (ADR 0004 → Workers Cache), §4 TTLs unchanged but delivered via `Cache-Control`, §4a normalization (WC-4 outcome), §5 invalidation (native purge + queue), §6 cookie hygiene under the new key model, §7.1 noindex bake.
- **`CLAUDE.md`**: update the "Cloudflare plan is Pro / Cache-Tag" and "Cached SSR routes must render visitor-state-neutral HTML" bullets to describe Workers Cache + queue purge.
- Reconcile `STAGE_1_SPEC.md` §9 cross-refs, `docs/adr/README.md`, `environments.md`, `CICD_PLAN.md`, and `server-runtime.ts` / `cache-tags.ts` / `wrangler.jsonc` header comments.
- Refresh the memory note about the cache architecture if one exists.

**Acceptance criteria.** No doc still describes the manual `caches.default` + HTTP purge as current; a `grep` for `callCloudflarePurge` / `caches.default` / "purge-by-tag API" in `docs/` returns only historical/superseded references.

**Dependencies:** WC-1..WC-10. **Docs:** all cache docs. **Risk:** low.

---

## 4. Recommended sequencing

```
WC-1 (ADR + spike) ─┬─> WC-2 (toolchain bump)
                    │
WC-2 ───────────────┴─> WC-3 (enable + remove manual, preview/staging first)
                            ├─> WC-4 (key normalization gateway)
                            ├─> WC-5 (queue purge: promote → SSR)  ── required before prod enable
                            ├─> WC-6 (/admin/purge native)
                            └─> WC-8 (observability + noindex bake)
WC-5 ─> WC-7 (datatool via queue)
WC-3..WC-8 ─> WC-9 (tests + local-dev)
WC-5,6,7 ─> WC-10 (retire HTTP transport + secrets)
WC-1..WC-10 ─> WC-11 (docs sweep)
```

**Prod-enable gate:** do **not** set `cache.enabled` on the `production` web env until WC-4, WC-5, WC-6, and WC-8 are merged and validated on staging — otherwise prod loses utm de-fragmentation, promote-driven invalidation, and (critically) the `noindex` guarantee on HITs.

---

## 5. Open questions (resolve in WC-1)

1. **`cross_version_cache`** — `true` (survive deploys, but must purge on content-shape changes) vs `false` (every deploy cold-starts the cache, auto-correct but cold). Recommend `true` + rely on tag purge; confirm in spike.
2. **Cache-key normalization** — gateway entrypoint (WC-4 option A, preserves invariants) vs accept fragmentation (option B). Recommend A.
3. **Local-dev** — does `wrangler dev`/miniflare exercise Workers Cache or no-op it? Determines how much we can test locally vs only on deployed previews.
4. **`stale-if-error` / `stale-while-revalidate`** — adopt for detail/index routes now (resilience) or defer?
5. **API Worker cache** — confirm leaving it disabled (recommended) vs enabling per-entrypoint for any future GET API that's cache-worthy.
6. **Queue vs service-binding for cross-Worker purge** — the transcript approved the queue; confirm the ADR rejects a direct SSR service-binding call (re-introducing the ADR-0010 cycle, but synchronous) with reasons (decoupling, retries, back-pressure).

---

## 6. Bullet summary

- **Goal:** replace the hand-rolled edge cache (manual `caches.default` match/put in `server-runtime.ts` + HTTP `callCloudflarePurge`) with native **Cloudflare Workers Cache** (`cache.enabled` in wrangler; `ctx.cache.purge()`), and bump the Workers toolchain/compat dates. HITs skip the Worker ⇒ less CPU/cost + lower latency, plus free request-collapsing and tiered cache.
- **Two hard parts drive the plan:** (1) **cross-Worker purge** — `ctx.cache.purge()` is entrypoint-scoped and the zone HTTP purge doesn't touch Workers Cache, so `POST /api/promote` (API Worker) must invalidate SSR HTML **via a Cloudflare Queue** consumed by the SSR Worker (the "call a queue to purge?" the user approved; **reverses ADR 0010**, new **ADR 0020**); (2) **cache-key normalization** — the new cache keys on the full order-sensitive query string, so preserving utm-strip / per-route allowlist / facet-order (AECI-100/143/223) needs a **gateway entrypoint** (or an accepted-fragmentation trade-off).
- **11 issues (WC-1…WC-11):** ADR+spike · toolchain bump · enable+remove-manual (SSR only, per-env rollout) · key-normalization gateway · **queue purge (promote→SSR)** · `/admin/purge` native · datatool purge via queue · observability + **`X-Robots-Tag` noindex baked pre-cache** · tests+local-dev · retire HTTP transport & prune `CF_PURGE_API_TOKEN` (keep `CF_ZONE_ID` for the WAF poll) · docs sweep.
- **Sequencing:** ADR/spike → bump → enable on preview/staging → land normalization + queue purge + noindex + `/admin/purge` → datatool → tests → cleanup → docs. **Prod-enable is gated** on WC-4/5/6/8 (else prod loses invalidation, utm de-frag, and the noindex-on-HIT guarantee).
- **Don't-break list:** API Worker cache stays **disabled** (responses are `no-store`); keep cookie-strip on the miss path; keep the ordered *refresh-stats-then-purge* home flow; keep `CF_ZONE_ID` (WAF poll); base branch `stage-2` (Stage 2 platform work).
- **Sources:** Cloudflare Workers Cache docs (overview/config/keys/purge/limitations/debugging) + current code in `server-runtime.ts`, `cache-tags.ts`, `packages/shared/cache-purge.ts`, `promote.ts`, `promote-cache-tags.ts`, `admin-purge.ts`, `datatool/cache-purge.ts`, and both `wrangler.jsonc` files.
```
