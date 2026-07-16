# Workers Cache Migration — Linear Issues

**Status:** Issues created in Linear on 2026-07-07 (epic **AECI-314** + WC-1…WC-11 = **AECI-315…AECI-325**), under the **Stage 2 Planning** project on the **AECI** team, base branch `stage-2`.
**Branch:** `chris-walton-wbs/workers-cache-migration`
**Author:** planning pass from the "Plan Workers Cache" session (transcript in `.context/attachments/amTu0N/`)
**Origin:** Cloudflare shipped **[Workers Cache](https://developers.cloudflare.com/workers/cache/)** — a native cache that sits *in front of* a Worker (a cache HIT never runs the Worker), configured with `cache.enabled` in `wrangler.jsonc` and purged from inside the Worker with `ctx.cache.purge()`. It can replace most of the hand-rolled edge-cache machinery we built in Phase 2 (manual `caches.default` match/put + an HTTP purge-by-tag transport).

> **How to use this file:** the per-issue Context / Scope / Acceptance Criteria / Dependencies / Docs / Risk now live in **Linear** — see the WC-N → AECI-N map below; each issue body is the source of truth there. This file keeps only the shared **reference material** (rationale, pinned Cloudflare facts + code touch-points, sequencing, open questions) that isn't captured per-issue. All issues sit under epic **AECI-314** in the **Stage 2 Planning** project, base branch `stage-2` (Stage 2 platform work, not a prod hotfix — see `CLAUDE.md` "Git workflow"). **This doc is transitional:** the design rationale now lives in **[ADR 0020](adr/0020-workers-cache-and-queue-purge.md)** (landed 2026-07-12 — WC-1 / AECI-315), which resolves the open questions in §4 below. This file is kept only for the shared **reference material** (pinned Cloudflare facts, code touch-points, sequencing) that WC-2…WC-11 implementers still lean on; the **WC-11 (AECI-325) docs sweep retires it**.

## Issue map (WC-N → Linear)

| Handle | Linear | Title |
|---|---|---|
| **epic** | [AECI-314](https://linear.app/aec-integrations/issue/AECI-314) | Workers Cache Migration (epic) |
| WC-1 | [AECI-315](https://linear.app/aec-integrations/issue/AECI-315) | ADR + spike: adopt Workers Cache; cross-Worker purge via Queue |
| WC-2 | [AECI-316](https://linear.app/aec-integrations/issue/AECI-316) | Upgrade Cloudflare Workers toolchain + bump compatibility dates |
| WC-3 | [AECI-317](https://linear.app/aec-integrations/issue/AECI-317) | Enable Workers Cache on the SSR Worker; remove the manual `caches.default` pipeline |
| WC-4 | [AECI-318](https://linear.app/aec-integrations/issue/AECI-318) | Preserve cache-key normalization (utm strip, per-route allowlist, canonical order) |
| WC-5 | [AECI-319](https://linear.app/aec-integrations/issue/AECI-319) | Cross-Worker purge via Cloudflare Queue (promote → SSR cache) |
| WC-6 | [AECI-320](https://linear.app/aec-integrations/issue/AECI-320) | Migrate `POST /admin/purge` to native `ctx.cache.purge()` |
| WC-7 | [AECI-321](https://linear.app/aec-integrations/issue/AECI-321) | datatool bulk purge via the purge queue |
| WC-8 | [AECI-322](https://linear.app/aec-integrations/issue/AECI-322) | Observability + `X-Robots-Tag` under a front-of-Worker cache |
| WC-9 | [AECI-323](https://linear.app/aec-integrations/issue/AECI-323) | Tests + local-dev verification for the new cache model |
| WC-10 | [AECI-324](https://linear.app/aec-integrations/issue/AECI-324) | Retire the HTTP purge transport + prune now-unused secrets |
| WC-11 | [AECI-325](https://linear.app/aec-integrations/issue/AECI-325) | Documentation sweep |

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

**Current versions in-repo** (post-WC-2 / AECI-316, 2026-07-16): `wrangler ^4.111.0`, `@cloudflare/workers-types ^5.20260716.1`, `miniflare ^4.20260710.0` — all still clear the floors. Compat dates: **all three Workers on `2026-07-10`** (web, api, datatool — matched to the `workerd@1.20260710.1` the toolchain bundles). WC-2 also took `@cloudflare/workers-types` to the new **5.x** major (the 4.x line stopped at `4.20260702.1`; `wrangler 4.111` peer-wants `^5.x`), clearing the peer warning with typecheck green. `wrangler types` still nudges dropping the package entirely for generated runtime types — a further follow-up (`apps/api` / `apps/datatool` would move their `tsconfig` to the generated `worker-configuration.d.ts`, as `apps/web` already does).

**Current code touch-points (for the ACs):**
- Manual pipeline: `apps/web/src/server-runtime.ts` → `handleSsr` (`getEdgeCache`, `cacheKeyUrl`, `cache.match`, `cache.put`), plus `ROUTE_CACHE_PATTERNS` / `cacheControlForRoute` / `buildCacheControl`.
- Tag emission: `apps/web/src/server/cache-tags.ts` (`buildCacheTags`, `cacheTagInputsForPath`).
- HTTP purge transport: `packages/shared/src/cache-purge.ts` (`callCloudflarePurge`, `CF_PURGE_MAX_TAGS = 30`).
- Promote purge: `apps/api/src/routes/promote.ts` (`purgeAfterPromote`, `refreshHomeStatsAfterPromote`, fired via `ctx.waitUntil`) + tags from `apps/api/src/routes/promote-cache-tags.ts` (`cacheTagsForPromote`).
- Manual/incident purge: `apps/web/src/server/routes/admin-purge.ts` (`createAdminPurgeHandler`; auth `ADMIN_PURGE_TOKEN`; CF creds `CF_PURGE_API_TOKEN` + `CF_ZONE_ID`).
- datatool bulk purge: `apps/datatool/src/cache-purge.ts` (`purgeEnvCache`, `BROAD_CACHE_TAGS`).
- Egress `X-Robots-Tag` stamp: `createApp` middleware in `server-runtime.ts`. _(Pre-WC-3 this ran after the hand-rolled `caches.default` put and re-ran on each HIT; WC-3 removed that manual pipeline, so it now stamps pre-store on the cached default entrypoint, and **WC-8 (AECI-322) verified the noindex decision is baked into the cached payload** — served on every HIT without the Worker running. See `docs/CACHE_STRATEGY.md` §7.1.)_
- Observability: `aeci.ssr.render`, `aeci.page.render.duration_ms`, `aeci.cache.purge` → `docs/OBSERVABILITY.md`.
- `CF_ZONE_ID` is **also** consumed by the AECI-262 WAF analytics poll — do **not** delete it wholesale.

> **Per-issue detail (Context / Scope / Acceptance Criteria / Dependencies / Docs / Risk) lives in Linear** — see the WC-N → AECI-N map at the top of this file. Those issue bodies are the source of truth and were seeded from the reference material above.

---

## 3. Recommended sequencing

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

## 4. Open questions (resolve in WC-1)

1. **`cross_version_cache`** — `true` (survive deploys, but must purge on content-shape changes) vs `false` (every deploy cold-starts the cache, auto-correct but cold). Recommend `true` + rely on tag purge; confirm in spike.
2. **Cache-key normalization** — gateway entrypoint (WC-4 option A, preserves invariants) vs accept fragmentation (option B). Recommend A.
3. **Local-dev** — does `wrangler dev`/miniflare exercise Workers Cache or no-op it? Determines how much we can test locally vs only on deployed previews.
4. **`stale-if-error` / `stale-while-revalidate`** — adopt for detail/index routes now (resilience) or defer?
5. **API Worker cache** — confirm leaving it disabled (recommended) vs enabling per-entrypoint for any future GET API that's cache-worthy.
6. **Queue vs service-binding for cross-Worker purge** — the transcript approved the queue; confirm the ADR rejects a direct SSR service-binding call (re-introducing the ADR-0010 cycle, but synchronous) with reasons (decoupling, retries, back-pressure).

---

## 5. Bullet summary

- **Goal:** replace the hand-rolled edge cache (manual `caches.default` match/put in `server-runtime.ts` + HTTP `callCloudflarePurge`) with native **Cloudflare Workers Cache** (`cache.enabled` in wrangler; `ctx.cache.purge()`), and bump the Workers toolchain/compat dates. HITs skip the Worker ⇒ less CPU/cost + lower latency, plus free request-collapsing and tiered cache.
- **Two hard parts drive the plan:** (1) **cross-Worker purge** — `ctx.cache.purge()` is entrypoint-scoped and the zone HTTP purge doesn't touch Workers Cache, so `POST /api/promote` (API Worker) must invalidate SSR HTML **via a Cloudflare Queue** consumed by the SSR Worker (the "call a queue to purge?" the user approved; **reverses ADR 0010**, new **ADR 0020**); (2) **cache-key normalization** — the new cache keys on the full order-sensitive query string, so preserving utm-strip / per-route allowlist / facet-order (AECI-100/143/223) needs a **gateway entrypoint** (or an accepted-fragmentation trade-off).
- **11 issues (WC-1…WC-11):** ADR+spike · toolchain bump · enable+remove-manual (SSR only, per-env rollout) · key-normalization gateway · **queue purge (promote→SSR)** · `/admin/purge` native · datatool purge via queue · observability + **`X-Robots-Tag` noindex baked pre-cache** · tests+local-dev · retire HTTP transport & prune `CF_PURGE_API_TOKEN` (keep `CF_ZONE_ID` for the WAF poll) · docs sweep.
- **Sequencing:** ADR/spike → bump → enable on preview/staging → land normalization + queue purge + noindex + `/admin/purge` → datatool → tests → cleanup → docs. **Prod-enable is gated** on WC-4/5/6/8 (else prod loses invalidation, utm de-frag, and the noindex-on-HIT guarantee).
- **Don't-break list:** API Worker cache stays **disabled** (responses are `no-store`); keep cookie-strip on the miss path; keep the ordered *refresh-stats-then-purge* home flow; keep `CF_ZONE_ID` (WAF poll); base branch `stage-2` (Stage 2 platform work).
- **Sources:** Cloudflare Workers Cache docs (overview/config/keys/purge/limitations/debugging) + current code in `server-runtime.ts`, `cache-tags.ts`, `packages/shared/cache-purge.ts`, `promote.ts`, `promote-cache-tags.ts`, `admin-purge.ts`, `datatool/cache-purge.ts`, and both `wrangler.jsonc` files.
```
