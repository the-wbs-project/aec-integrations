# AEC Integrations — Edge Cache Strategy

**Status:** Active — source of truth for AECi edge caching
**Supersedes (for caching specifics):** `STAGE_1_SPEC.md` §9.2 and §9.3
**Established by:** Phase 2 (`STAGE_1_PHASE_2_SPEC.md` §8); extended in Phase 4 / 5 / 6 as new entity types and write paths come online
**Companion docs:** `STAGE_1_SPEC.md`, `STAGE_1_PHASE_2_SPEC.md`, `API_CONTRACTS.md`, `CICD_PLAN.md`

> **⚠️ Migration in progress — AECI-314 (Workers Cache Migration), design in [ADR 0020](adr/0020-workers-cache-and-queue-purge.md).** §1–§8 below describe the **original** hand-rolled design: the SSR Worker's `caches.default` match/put (`cacheKeyUrl` normalization) plus the HTTP `callCloudflarePurge` purge-by-tag transport. That is being replaced by **native Cloudflare Workers Cache** (`cache.enabled`; a HIT skips the Worker) with cross-Worker purge via a Cloudflare **Queue** and key-normalization via a **gateway entrypoint**.
>
> **WC-3 (AECI-317) + WC-4 (AECI-318) have landed:** native `cache.enabled` is on the SSR Worker's **preview + staging** envs. The hand-rolled `caches.default` match/put is **removed**; key normalization (utm-strip / per-route allowlist / canonical order / multi-select CSV sort) is **restored** — WC-4 rebuilt it as `cacheKeyFor()` behind a two-entrypoint **gateway** (`default`, cache off) → cached **`Renderer`** pair (§4a, ADR 0020 §2). WC-3 also added `stale-while-revalidate` / `stale-if-error` to the detail + index/browse routes (§4). The HTTP `callCloudflarePurge` transport (§5) is **still in force** until WC-5/6/10. `demo`/`production` stay uncached until WC-5/6/8 land (ADR 0020 §1). The **full rewrite of this doc is tracked in WC-11 (AECI-325)**; §9 sketches the target shape.

---

## 1. Plan availability note

Cache-Tag purge is available on **all Cloudflare plans as of April 2025**. The Pro plan rate limits (token bucket) are adequate for Phase 2's expected purge volume. This reverses the previous "Enterprise-only" assumption baked into earlier drafts of `STAGE_1_SPEC.md` §9 — `Cache-Tag` is now the AECi strategy from Phase 2 onward.

---

## 2. Tag vocabulary

`Cache-Tag` values are comma-separated strings, ≤ 16 KB per response, no spaces.

| Tag | Attached to |
|---|---|
| `product:{slug}` | The product detail page for that slug |
| `vendor:{slug}` | The vendor detail page for that slug |
| `pair:{min}__{max}` | The Stage 1.5 consolidated product-**pair** page (`/products/:context/integrations/:other`). `{min}`/`{max}` are the two product slugs in **alphabetical** order (`min` = context), so the tag is **orientation-independent** — both `/products/A/integrations/B` and its mirror carry the same `pair:` tag. The page also embeds `product:{slug}` for **both** products, so a promote touching either product — or a claim on the integration — purges it. Emitted by both the pair page SSR (AECI-294) and the promote deriver (`promote-cache-tags.ts` → `pairCacheTag`, AECI-297), which must stay in lockstep. |
| `integration:{id}` | Stage 1.5 (AECI-294) retired the `/integrations/:id` detail page; this tag now rides the **301 redirect** to the pair page (so a promote on that integration can purge the cached redirect). |
| `category:{slug}` | Category browse page |
| `audience:{slug}` | Audience browse page |
| `phase:{slug}` | Project phase browse page |
| `taxonomy` | Any page whose cached HTML renders the full taxonomy term set — home (`/`) and the flat taxonomy index pages (`/categories`, `/audiences`, `/phases`). The primary-nav flyouts read the term set client-side from `/api/taxonomy`, so they do **not** bake it into page HTML and don't carry this tag. |
| `index:products` / `index:categories` / `index:audiences` / `index:phases` | The respective index pages. (AECI-165 removed the `/vendors` and `/integrations` index pages — they 301-redirect to `/products` — so `index:vendors` / `index:integrations` are no longer emitted.) |
| `index:home` | The home page (`/`). Its credibility strip + stats cards render the `home.*` `stats_cache` counts, which are refreshed on every successful promote (AECI-305) — so a promote purges `index:home` to repaint them. Distinct from `taxonomy` (which the home page also carries but only fires on a term-set change) and from `route:index` (incident-only, §3.3). |
| `sitemap` | `sitemap.xml` |
| `route:detail` / `route:index` / `route:browse` | Coarse-grained tags for bulk invalidation in incidents |
| `route:404` | Single sentinel tag on every 404 response — both cacheable-route 404s and non-cacheable-path 404s (see §4). Used for bulk-purge via `POST /admin/purge` after a config fix (e.g. slug regenerated, route table corrected). 404s have no entity identity so this is the only invalidation handle. Emitted by `withCacheHeaders` in `server-runtime.ts`, not by `buildCacheTags`. |

Every cacheable response carries **at minimum**:

- One entity-specific tag (e.g. `product:procore`)
- One route-class tag (e.g. `route:detail`)
- Tags for every entity *embedded* in the response (a product page references its vendor → also tags `vendor:{vendor-slug}` so editing the vendor invalidates affected product pages)

---

## 3. Tag composition rules

Codified so callers don't re-derive the rules per surface:

1. **Entity tag + route-class tag are mandatory.** Every cacheable response sets at least one entity-specific tag (e.g. `product:procore`) and exactly one route-class tag (`route:detail` | `route:index` | `route:browse`). A response that doesn't fit either category isn't cacheable — see §4.
2. **Embedded entities also tag.** Any entity rendered in the response — even transitively — contributes a tag. A product detail page embeds its vendor → also `vendor:{vendor-slug}`. The product-PAIR page embeds both products → also `product:{context-slug}` and `product:{other-slug}` (plus each mechanism's `built_by` vendor / `powered_by` product, pushed by the resolver), and carries its own `pair:{min}__{max}` tag — so both a product edit and a claims-only promote (AECI-297) repaint it. A browse page lists every product matching the facet → tag each: `product:{slug-1}, product:{slug-2}, …`. A page that renders the taxonomy nav also carries `taxonomy`. This is what makes purge-by-tag exhaustive — editing a vendor invalidates every product page that displays it, with no URL bookkeeping.
3. **Coarse tags for incident response.** `route:detail` / `route:index` / `route:browse` exist for bulk invalidation when something goes wrong at the route-class layer (e.g. a layout change that needs to repaint every detail page). Don't use them for routine writes.

### Cache-Tag header construction helper

Building the header is a single helper, implemented in Phase 2.10 ([AECI-56](https://linear.app/aec-integrations/issue/AECI-56)). Lives at `apps/web/src/server/cache-tags.ts`:

```typescript
buildCacheTags(opts: {
  route: 'detail' | 'index' | 'browse';
  entity?: { type: string; slug?: string; id?: string };
  embedded?: ReadonlyArray<{ type: string; slug?: string; id?: string }>;
  taxonomy?: boolean;
}): string;
```

`entity.type` is the tag prefix (`product`, `vendor`, `pair`, `integration`, `category`, `audience`, `phase`, or `index` for index pages); `slug` or `id` is the suffix (slug for slug-keyed entities — the pair page passes the composite `{min}__{max}` as its `slug` — id for `integration:<id>`). `taxonomy: true` appends the global `taxonomy` tag — set on routes whose HTML renders the full taxonomy term set (home `/` and the flat `/categories`, `/audiences`, `/phases` index pages). Static pages with no §2 vocabulary entry (`/about`, `/legal/*`) pass `entity` as `undefined`, yielding just the route-class tag.

The companion helper `cacheTagInputsForPath(localeStrippedPath)` (same module) returns the helper's input shape for every cacheable URL the SSR Worker handles, mirroring `ROUTE_CACHE_PATTERNS` in `server-runtime.ts`. Adding a new cacheable URL means extending both that table and `cacheTagInputsForPath` in the same change — and its per-route content-param allowlist (`cacheKeyParams`, restored in WC-4; see §4a). Callers never construct `Cache-Tag` strings by hand.

---

## 4. TTLs per route class

`Cache-Control: max-age={browser} s-maxage={edge}`

| Route class | `max-age` (browser) | `s-maxage` (edge) |
|---|---|---|
| Detail pages | 0 | 900 (15 min) |
| Browse pages (category / audience / phase) | 0 | 300 (5 min) |
| Index pages | 0 | 300 (5 min) |
| `/api/taxonomy` fetch (nav flyouts) | 0 | not edge-cached — `private, no-store` (see below); KV read-through, 5 min, in the API Worker |
| `sitemap.xml` | 0 | 3600 |
| `robots.txt` | 86400 | 86400 |
| 404 | 0 | 60 |

`max-age: 0` on browser is deliberate — the browser revalidates on every navigation, the edge absorbs the actual load. Combined with tag-based purge, the worst-case staleness for an end user is one edge round-trip after a write, not 15 minutes.

**Resilience directives (WC-3 / AECI-317).** The data-backed **detail + index/browse** route TTLs also carry `stale-while-revalidate=60` and `stale-if-error=86400`, so the native Workers Cache serves a just-expired copy for up to 60s while it revalidates in the background (smoothing the TTL-boundary latency spike) and a day-old copy if the origin 5xxs during revalidation. Static pages (`/about`, `/legal`), redirects, `sitemap.xml`, `robots.txt`, and 404s deliberately omit them. Values live in the `RESILIENCE` const in `server-runtime.ts` and are tunable. Under native Workers Cache the platform stores each response **from its `Cache-Control`** — there is no explicit `cache.put()`.

Per [AECI-43](https://linear.app/aec-integrations/issue/AECI-43), API responses themselves remain `Cache-Control: private, no-store`. Only SSR HTML is edge-cached.

Non-cacheable routes (`/api/*`, `/auth/*`, `/account*`, `/search`) are excluded from the cacheable branch in the SSR Worker entry — they emit `Cache-Control: private, no-store` and never reach the tag/TTL machinery. See `STAGE_1_SPEC.md` §9.1 and [AECI-35](https://linear.app/aec-integrations/issue/AECI-35) for the route classifier.

**Exception — 404 responses on non-cacheable paths (AECI-62):** if the Angular SSR renderer returns HTTP 404 on a non-cacheable path (e.g. an unknown URL caught by the `**` wildcard route), the Worker applies `NOT_FOUND_TTL` (`max-age=0, s-maxage=60`) and `Cache-Tag: route:404` instead of `private, no-store`. The 404 content is session-neutral (no user-specific data), so edge caching is safe and prevents a flood of unknown URLs from melting the SSR Worker. The `route:404` tag provides the same bulk-purge handle as on cacheable routes. All other non-cacheable responses (2xx, 3xx, 5xx) continue to emit `private, no-store`.

---

## 4a. Cache key normalization (AECI-100 / WC-4)

> **✅ Restored in WC-4 (AECI-318).** WC-3 removed `cacheKeyUrl()` + the per-route `cacheKeyParams` allowlist with the manual `caches.default` pipeline; native Workers Cache keys on the **full, order-sensitive query string**. WC-4 rebuilt the normalization as **`cacheKeyFor()`** behind the two-entrypoint **gateway pattern** (ADR 0020 §2), so `utm_*`/`fbclid` de-fragment, `?a=1&b=2` == `?b=2&a=1`, and the AECI-223 multi-select CSV collapses regardless of order. **Mechanism:** the SSR Worker's `default` export is a gateway (`exports.default.cache.enabled: false`, so it runs on every request); it computes `cacheKeyFor(url)` and forwards the *original* request to the cached `Renderer` entrypoint via `ctx.exports.Renderer.fetch(request, { cf: { cacheKey } })`. A custom `cf.cacheKey` **replaces the path+query** in the native key, so `cacheKeyFor` returns a **path-relative** string (not a full-origin URL like the old `cacheKeyUrl` — origin isn't part of a custom key, and each env / Worker version is already an isolated cache namespace). The request itself is untouched (utm_* survive for the render + client analytics); only the *lookup key* is normalized. `demo`/`production` stay uncached until WC-5/6/8 land.

The native Workers Cache is keyed by URL. The gateway's `cacheKeyFor(url)` (`server-runtime.ts`) is the normalization point — the string it returns is fed to `cf.cacheKey` on the loopback to `Renderer`, **not** derived from the raw request URL — otherwise marketing/tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, …) on shared links would fragment the cache for pages that render identically, turning every variant into a MISS → SSR render → store.

The normalized key is:

```
{pathname}  +  only the route's content-affecting query params, canonically ordered
```

- **The pathname is preserved verbatim**, including any locale prefix — locale variance is already segmented at the URL-prefix layer (§7), so the key must keep it. Origin is **not** included: a custom `cf.cacheKey` replaces path+query only, and each env / Worker version is already an isolated cache namespace.
- **All other query params are dropped.** Detail, home, browse, and static routes are query-independent → the entire query string is stripped.
- **Index routes keep only their declared content params**, sorted (so `?sort=name&page=2` and `?page=2&sort=name` are one entry).

The per-route allowlist lives on each `ROUTE_CACHE_PATTERNS` entry as `cacheKeyParams` (co-located with the TTL and the `match` predicate so the three stay in sync):

| Route | `cacheKeyParams` (kept in the key) |
|---|---|
| `/products` (index) | `page`, `perPage`, `sort`, `category_id`, `audience_id`, `phase_id` |
| Browse (`/categories\|audiences\|phases/:slug`) | `page`, `perPage`, `sort`, `category_id`, `audience_id`, `phase_id` |
| Detail (`/products/:slug`, `/vendors/:slug`) | none — strip all |
| Product-PAIR page (`/products/:context/integrations/:other`) | `view` — the Basic/Detailed disclosure toggle SSR-renders different content (Basic drops the claim lanes), so `?view=basic` and the `detailed` default MUST get distinct keys. Same rationale as `/products ?view=table` (AECI-190). The companion `aeci_pair_view` cookie (remembers the reader's choice) is **NOT** a cache-key input and is **NOT** in `VISITOR_STATE_COOKIES` — it is read only post-hydration in the browser, never by SSR (see §6.1). |
| Taxonomy index (`/categories`, `/audiences`, `/phases`) | inherits the listing allowlist (combined `match`); these pages read none of it — harmless over-include |
| Home (`/`), `/about`, `/legal/*` | none — strip all |

The listing/browse rows share one `LISTING_CACHE_KEY_PARAMS` const in `server-runtime.ts` (AECI-143): `/products` and the three `:slug` browse pages all read `page` / `sort` and the taxonomy facet ids the `aec-facet-sidebar` writes to the URL (`category_id` / `audience_id` / `phase_id`). On a browse page the page's own dimension rides the path (`/categories/:slug`), so only the *other* two facet ids ever appear in its query — but listing all three keeps the const uniform (over-including is harmless).

**Maintenance rule (load-bearing).** The allowlist must be a **superset** of every query param the page component reads from the URL. Under-including is a correctness bug, not just a perf one: it collapses two distinct renders onto one key and serves the wrong HTML. So when a Phase 3+ change adds a content-affecting query param to an index/browse page (a new facet, `search`, a filter), add it to that route's `cacheKeyParams` in the same change — AECI-143 did exactly this when it added the facet sidebar. Over-including is merely wasteful (a harmless extra entry), so when in doubt, include. `perPage` is listed today for forward-safety even though the index components currently hardcode the default and don't read it from the URL.

**Value-level normalization for multi-select facets (AECI-223 / WC-4).** The taxonomy facets are **multi-select** — each dimension accepts a comma-separated id list in a single `{kind}_id` param (`category_id=a,b`), matched as `OR within the dimension, AND across dimensions`. Two selections in different click orders (`a,b` vs `b,a`) are the same filter but would otherwise be **distinct cache keys** (and break SSR↔client HTTP-transfer-cache parity). Two layers enforce the invariant: (1) the **producer** `aec-facet-sidebar` emits the ids **sorted** before writing the param (`facet-sidebar.ts` `onRefine`), keeping the browser URL + transfer-cache key stable; and (2) **WC-4 hardened `cacheKeyFor`** to also split/sort/rejoin the multi-value facet params (the `MULTI_VALUE_CACHE_KEY_PARAMS` set), so even a raw/hand-typed/bot `?category_id=b,a` collapses onto the same edge entry — the cache-key layer no longer depends solely on the producer. (The old `cacheKeyUrl` sorted param *names* only, never value bytes; the value sort is the WC-4 addition.) The allowlist is unchanged (the param names already covered single-select). Any future writer of a list-valued cache-key param should add it to `MULTI_VALUE_CACHE_KEY_PARAMS`.

**Query-dependent redirects must be edge-excluded (WC-4).** The gateway applies the normalized `cf.cacheKey` to **every** GET, and `cacheKeyFor` strips the whole query for any path not in `ROUTE_CACHE_PATTERNS`. A standalone 301 whose `Location` embeds the request query — the `/disciplines/* → /audiences/*` redirect (`audienceRedirect`) and the apex→`www` canonical flip both preserve `${url.search}` — therefore **cannot** be stored in the shared edge cache: two distinct-query links would normalize to the same key and the first-warmed `Location` would be served to all of them. These redirects use `Cache-Control: private, max-age=3600` (browser-cacheable, since the browser keys on the full URL, but never edge-stored) instead of the `public`/`s-maxage` TTL the SSR routes use, and carry **no `Cache-Tag`** (there is nothing edge-stored to purge). Rule for any new standalone redirect: if its `Location` depends on the query string, make it `private` (edge-excluded); if it redirects to a canonical path and drops the query (like `/vendors → /products`), it may stay `public`/edge-cacheable.

**Scope.** This normalizes the native Workers Cache key (via `cf.cacheKey` on the gateway→`Renderer` loopback) only. Cloudflare's zone-level CDN cache (Cache Rules / "ignore query string") is a separate layer configured outside this code; the gateway's `cacheKeyFor` is the normalization point for the AECi SSR cache.

---

## 5. Invalidation mechanism

Invalidation has **migrated off the zone-level HTTP purge to native Workers Cache** (ADR 0020 / epic AECI-314). With native Workers Cache enabled on the SSR Worker (WC-3), the zone HTTP `purge_cache` is **inert against the SSR cache** — `ctx.cache.purge()` is entrypoint-scoped, and no zone configuration touches Workers Cache. Both purge surfaces now evict via `ctx.cache.purge()`, split by where the caller runs: `/admin/purge` **(a)** runs on the SSR Worker and purges **in-process** (WC-6 / AECI-320); `POST /api/promote` + review moderation **(b)** run on the API Worker — which can't reach the SSR cache directly — so they **enqueue** a typed `CachePurgeMessage` onto the **`aeci-cache-purge-{env}` Cloudflare Queue** (WC-5 / AECI-319), whose SSR `queue()` consumer issues the purge.

The historical HTTP transport `callCloudflarePurge` — a stateless `POST https://api.cloudflare.com/.../zones/{zone}/purge_cache` with a `{ tags }` body (≤ `CF_PURGE_MAX_TAGS` = 30 tags/call, Pro plan) — still lives **once** in `@aeci/shared` (`packages/shared/src/cache-purge.ts`), but now backs only datatool (until WC-7) and the `retract-product` CLI; the shared module also holds the queue message contract (`CachePurgeMessage`, `CACHE_PURGE_QUEUE_MAX_TAGS` = 1000). `CF_PURGE_API_TOKEN` is retired in WC-10; `CF_ZONE_ID` is kept (the AECI-262 WAF poll uses it). Call sites:

**(a) `POST /admin/purge` on the SSR Worker** — the manual / incident-response + CI surface. **Migrated to native Workers Cache in WC-6 ([AECI-320](https://linear.app/aec-integrations/issue/AECI-320)):** because this endpoint runs on the same SSR Worker that owns the cache, it invalidates **in-process** via `ctx.cache.purge(...)` — no outbound Cloudflare REST call, no `@aeci/shared` `callCloudflarePurge`, no queue hop.

- Authenticates the *caller* via a long-lived admin token (Wrangler secret named `ADMIN_PURGE_TOKEN`) — **unchanged** by the migration.
- Body: one or both of `{ tags: string[] }` / `{ pathPrefixes: string[] }`, or `{ purgeEverything: true }` on its own — the three native purge modes (`purgeEverything` is exclusive; `tags`+`pathPrefixes` union). The legacy `{ tags: [...] }` body stays valid.
- Delegates to `ctx.cache.purge(...)`; the result `{ success, errors }` is surfaced in the response body. The tag cap is the native ceiling (≤ 1000 `Cache-Tag` values/response), **not** the old HTTP `CF_PURGE_MAX_TAGS` = 30.
- Purge shares Cloudflare's zone-purge rate limiter; a rejection resolves to `{ success: false, errors }` → HTTP 502.
- **No longer reads `CF_PURGE_API_TOKEN` / `CF_ZONE_ID`** (native purge needs neither). Their secret pruning is deferred to WC-10 ([AECI-324](https://linear.app/aec-integrations/issue/AECI-324)).
- **Entrypoint scoping (load-bearing):** `ctx.cache.purge()` only evicts the *calling entrypoint's* cache. Today the SSR Worker is a single default entrypoint, so this handler and the cached SSR responses share one cache — correctly scoped. When WC-4 ([AECI-318](https://linear.app/aec-integrations/issue/AECI-318)) moves SSR caching into a named `Renderer` entrypoint, `/admin/purge` MUST issue its purge from `Renderer` (or via the WC-5 queue) or it silently no-ops — see §9.
- **Cache-disabled tiers:** `ExecutionContext.cache` is absent when Workers Cache is not enabled on the entrypoint (local/miniflare + the demo/production tiers gated until WC-4/5/6/8). There the handler returns a graceful no-op (`200 { success: true, skipped: 'cache_disabled' }`) so CI's post-promote purge and manual callers stay green until native cache is enabled on the tier.
- Logs to Datadog and emits `aeci.cache.purge{source,outcome,mode}` (outcomes: `ok` / `failed` / `skipped`).

Auth: Wrangler secret in Phase 2. **Migrate to Cloudflare Access in Phase 6** when admin tooling expands and there are multiple admin endpoints behind the same auth boundary.

Callers of `/admin/purge`:

- Manual incident response (curl)
- CI (`promote-to-prod.yml` purges `taxonomy` + `route:browse` after the reference-data seed) — inherits the native backend automatically (it only checks the HTTP status)
- Future admin tooling (Phase 6) — direct call from admin Workers, not n8n

**(b) `POST /api/promote` + review moderation on the API Worker** — since WC-5, these **enqueue** onto `aeci-cache-purge-{env}` (producer binding `CACHE_PURGE_QUEUE`) after the write commits; the SSR consumer issues the `ctx.cache.purge()`. Best-effort, post-commit (`ctx.waitUntil`), a graceful no-op when the queue binding is unset (local dev, PR previews), and never fails the committed write (a `queue.send` rejection is logged and swallowed). The promote's entity/index/pair/taxonomy tags are derived by `cacheTagsForPromote` (`promote-cache-tags.ts`); moderation enqueues `product:{slug}`. One message per ≤1000-tag batch (`CACHE_PURGE_QUEUE_MAX_TAGS`, vs. the HTTP transport's 30). This supersedes the ADR-0010 direct HTTP purge (which is inert against Workers Cache); the message is async, so there is still no api→web service binding.

The home page's `index:home` tag is the one deliberate exception: it is **not** in `cacheTagsForPromote`, because the home banner reads `home.*` `stats_cache` counts that the promote must **recompute first** (via `runHomeStats`). So the home refresh+enqueue is its own ordered post-commit task (`refreshHomeStatsAfterPromote` in `promote.ts`, AECI-305): recompute `stats_cache`, **then** enqueue the `index:home` purge. Enqueueing `index:home` in the concurrent set would let the purge race ahead of the recompute and re-cache stale HTML for another edge TTL. The `stats_cache` recompute runs in every environment; only the `index:home` enqueue is queue-binding-gated.

**The SSR consumer** (`apps/web/src/server/cache-purge-queue.ts`) reads each `CachePurgeMessage`, forwards its `tags`/`pathPrefixes`/`purgeEverything` to `ctx.cache.purge()`, and emits `aeci.cache.purge{source,outcome}` — `outcome:ok` on `{ success: true }`, `outcome:purge_failed` on `{ success: false }` or a thrown error (the message is `retry()`-ed, up to the consumer's `max_retries`), `outcome:no_cache` on an env whose cache is not yet enabled (demo/production before WC-6/8, where the consumer no-ops and acks), `outcome:noop` for an empty message. The metric **moved here off the producers** in WC-5. WC-4 note: `ctx.cache.purge()` is entrypoint-scoped; when WC-4 splits the SSR Worker into a gateway + named `Renderer` entrypoint, this purge must be relocated into `Renderer` or it silently no-ops (ADR 0020 §2).

Automated callers beyond promote/moderation (e.g. a Supabase webhook on row update) are Phase 4+. The Cloudflare Queue fronting cross-Worker purge — the "Option C" ADR 0010 deferred — **landed in WC-5**.

Implementation of the endpoint shape, rate-limit handling, and Datadog wiring landed in [AECI-56](https://linear.app/aec-integrations/issue/AECI-56) (Phase 2.10); the promote→purge wiring in [AECI-105](https://linear.app/aec-integrations/issue/AECI-105); the cross-Worker queue purge in [AECI-319](https://linear.app/aec-integrations/issue/AECI-319) (WC-5).

**Cloudflare API token scoping:** after WC-5 + WC-6 the two hot purge surfaces present **no** CF token — promote/moderation go through the queue and `/admin/purge` uses native `ctx.cache.purge()`. Any `CF_PURGE_API_TOKEN` that remains backs only the HTTP `callCloudflarePurge` still used by **datatool** (until WC-7) and the `retract-product` CLI; where present it must be scoped to `Zone.Cache Purge` on `aecintegrations.com` only — the narrowest possible scope. Reviewers should reject any change that broadens this token scope under deadline pressure; rotate by issuing a new token with the same minimal scope. The now-unused API Worker + SSR Worker `CF_PURGE_API_TOKEN` secrets are pruned in WC-10 ([AECI-324](https://linear.app/aec-integrations/issue/AECI-324)).

---

## 6. Cookie / cache hygiene

The Phase 2 Spec defers most of this to AECI-35 / AECI-41 ("inherits, no new work"). The full operative rules — still load-bearing for every Phase 2+ surface — are restated here so callers don't have to chase them through `STAGE_1_SPEC.md`:

### 6.1 Visitor-state-neutral HTML

Edge cache is keyed by URL. If SSR reads a request cookie (e.g. `theme=dark`) and bakes it into the rendered HTML, the first visitor primes the cache for everyone — a dark-mode visitor's render is served to a light-mode visitor, and vice versa.

**Rule:** for any cacheable route, the Worker strips visitor-state cookies (`theme`, future analytics cookies, etc.) before forwarding the request to the Angular SSR handler. The client reconciles state post-hydration from `localStorage` + `matchMedia` and repaints. Server-rendered HTML is neutral by design.

This is *not* solvable with `Vary: Cookie` — see §7 below for which `Vary` values are permitted and which still fragment the cache. The cookie-stripping middleware lives at `apps/web/src/server.ts` (shipped in [AECI-35](https://linear.app/aec-integrations/issue/AECI-35); theme service test coverage added in [AECI-41](https://linear.app/aec-integrations/issue/AECI-41)). Cross-reference: `STAGE_1_SPEC.md` §9.1a.

**Incremental hydration stays cache-neutral.** The two detail-page `@defer (on viewport; hydrate on viewport)` grids (`product-detail.ts` integrations, `vendor-detail.ts` products; AECI-130) SSR-render their main template instead of the `@placeholder`. The rendered rows come only from resolver data (no request cookie is read), so the SSR HTML remains visitor-state-neutral and the edge cache is not fragmented.

**Client-only preference cookies are exempt — and MUST stay that way.** A per-visitor preference that the browser reconciles *after* hydration is cache-safe precisely because SSR never reads it, so it must **not** be added to `VISITOR_STATE_COOKIES` (that list is for cookies SSR *does* read, which are then stripped on the cacheable branch). Current example: the product-PAIR page's `aeci_pair_view` cookie remembers the reader's Basic/Detailed choice; it is written only on a toggle click and read only in `afterNextRender` (browser-only), so the SSR render always emits the `detailed` default and the URL-keyed edge entry stays shared. The deep-linkable `?view=` param (a cache-key fork, §4a) remains the source of truth; the cookie only supplies the default when the URL carries no `?view=`. The analytics-consent state (`localStorage`, `consent-banner.ts`) is the same pattern in a different store. The rule: if you introduce a per-visitor preference, reconcile it post-hydration from the client store — do **not** make SSR read it.

### 6.2 Pinned-404 trap

If a Worker returns HTTP 200 with a "not found" body and a normal TTL for a missing entity, the edge caches that body for the full TTL. When the entity is subsequently created, visitors continue to see the stale "not found" page until TTL expiry or manual purge.

**Rule:** 404 / not-found responses must return **HTTP 404** with a short TTL (≤ 60s — see §4). Status code 404 lets downstream tooling (sitemaps, monitoring) distinguish real misses, and the short TTL means newly-created entities become visible quickly without a purge call.

Cross-reference: `STAGE_1_SPEC.md` §9.1b. The frozen stack-test probe documented the trap as a deliberate gap at `spikes/stack-test/README.md:215-217`; production `apps/web/` implements the correct behavior via `NOT_FOUND_TTL` (`apps/web/src/server-runtime.ts:169`).

---

## 7. SEO header set

In addition to `Cache-Control` and `Cache-Tag`, every cacheable response carries:

- `Vary: Accept-Language` — URL-prefix locale dispatch handles the actual variance (Phase 1 only emits `en-US`, but the routing layer is locale-aware), so this header just advertises the dimension to well-behaved proxies. Cloudflare's edge cache key isn't affected on Pro.
- `Link: </sitemap.xml>; rel=sitemap`
- `Content-Security-Policy` — **defined and first emitted in AECI-89.** (Earlier drafts of this section and `STAGE_1_PHASE_2_SPEC.md` §8.6 called the CSP "unchanged / existing from Phase 1," but no Phase 1 CSP was ever implemented — AECI-89 closes that gap.) The policy is a static, cache-safe string assembled in `apps/web/src/server/seo-headers.ts` and applied via `withCacheHeaders`. Nonces/hashes are deliberately **not** used: the HTML is edge-cached and served byte-identically to every visitor, so a cached nonce would be reused by all (defeating it), and Angular's `withEventReplay()` injects a version-generated inline script a hash allowlist would have to chase across upgrades. The directives:
  - `default-src 'self'`
  - `script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com` — the `index.html` theme bootstrap, the injected Datadog RUM bootstrap, and Angular's event-replay inline script. The host entry allowlists the Cloudflare Web Analytics beacon (`beacon.min.js`) that Cloudflare auto-injects at the edge for the zone
  - `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` — Angular SSR inlines component `<style>` blocks; Google Fonts stylesheet
  - `font-src 'self' https://fonts.gstatic.com`
  - `img-src 'self' data: https:` — vendor/Airtable `logo_url`s come from arbitrary https origins
  - `connect-src 'self' https://browser-intake-datadoghq.com https://browser-intake-us5-datadoghq.com https://*.algolia.net https://*.algolianet.com https://cloudflareinsights.com` — the `/api/*` proxy, the Datadog RUM intake host(s), the Algolia search origins, and the Cloudflare Web Analytics report host. The v7 browser SDK beacons to a per-`DD_SITE` `browser-intake-*` host, each a distinct registrable domain (a `*.datadoghq.com` wildcard does **not** match it). Two are allowlisted: `browser-intake-datadoghq.com` for the US1 default `DD_SITE=datadoghq.com` (the `.dev.vars.example` local default), and `browser-intake-us5-datadoghq.com` for the deployed preview/staging/production envs, which run `DD_SITE=us5.datadoghq.com` (see `apps/web/wrangler.jsonc` env vars and `OBSERVABILITY.md` §"Credentials"; the SDK maps `us5.datadoghq.com` → `browser-intake-us5-datadoghq.com`). **AECI-162** caught the missing US5 host — RUM beacons were CSP-blocked in every deployed env. Other sites use yet another `browser-intake-*` host (e.g. `browser-intake-datadoghq.eu`), so add its intake host here if `DD_SITE` changes again. The Algolia origins were added in **AECI-136** (Phase 3.4) for InstantSearch: the browser client resolves its query host as `{appId}-dsn.algolia.net` with `{appId}-{1,2,3}.algolianet.com` retry fallbacks, so the two wildcards cover every search XHR. `https://cloudflareinsights.com` is where the Cloudflare Web Analytics beacon POSTs its RUM payload (`/cdn-cgi/rum`); it pairs with the `static.cloudflareinsights.com` entry on `script-src`.
  - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` — hardening

**Note on the `Vary` policy.** This updates the previous `STAGE_1_SPEC.md` §9.3 stance ("no `Vary` headers on cached SSR responses"). The reasoning behind the original ban — `Vary: Cookie` and `Vary: User-Agent` fragment the edge cache without a corresponding invalidation handle — still holds for *those* values. `Vary: Accept-Language` is safe because locale variance is already segmented at the URL-prefix layer, so there's no additional cache fragmentation beyond what the URL key already provides. Any *other* `Vary` value (`Cookie`, `User-Agent`, etc.) remains forbidden.

### 7.1 Crawler-indexing gate (`X-Robots-Tag`)

Indexing is **fail-closed and environment-gated**, independent of the SEO headers above. The SSR Worker stamps `X-Robots-Tag: noindex, nofollow` on **every** response (all routes except the raw `/api/*` proxy) **unless** the `ALLOW_INDEXING` Worker var is exactly `"true"`. Pre-launch, no env sets it, so `demo.aecintegrations.com` (the `production` env — public, **not** behind Cloudflare Access; see `access.md` §"Locked decisions"), `staging.aecintegrations.com`, and `*.workers.dev` PR previews all return `noindex` and a sitemap-less `robots.txt` that still permits crawling (`Allow: /`, no `Sitemap:` line).

- **Why a header, not just `robots.txt` or `<meta robots>`.** `X-Robots-Tag` is the authoritative directive: it covers redirects, 404s, and non-HTML responses that can't carry a `<meta>` tag, and it governs URLs discovered via external links. For a compliant crawler to honor it the page must be crawlable, so `robots.txt` deliberately does **not** `Disallow: /` — blocking the crawl would stop the crawler from ever seeing the `noindex` and (per Google's docs) leave externally-linked URLs eligible to appear as URL-only results. robots.txt's only job in the blocked state is to withhold the sitemap.
- **Cache-safe — baked pre-cache (WC-8 / AECI-322).** The header is stamped by an egress middleware registered on the SSR Worker's default entrypoint — the same unit the native Workers Cache wraps — so it lands *before* the platform stores the response. Under native Workers Cache a HIT skips the Worker entirely, so the `noindex` decision is **baked once, on the MISS render that populates the cache, and served verbatim on every subsequent HIT** (no per-HIT re-stamp runs, and none is needed). The bake is env-neutral because each env is its own Worker + cache with its own `ALLOW_INDEXING`, so a non-indexable env's cache only ever stores `noindex` payloads. `applySeoHeaders` (the `Vary`/`Link`/CSP set, §7) is likewise applied pre-store — via `withCacheHeaders` on the MISS render — so the whole SEO/robots header set is baked together onto the stored payload. The response is rebuilt (not header-mutated) because a response's headers may be immutable. _(Pre-WC-3 the stamp ran after a hand-rolled `caches.default` put and re-ran on each HIT; WC-3 removed that manual pipeline, and WC-8 verified the pre-store bake — see the "cacheable 200 bakes noindex + CSP + Vary" regression test in `apps/web/src/server.spec.ts`, and the deployed MISS-vs-HIT `X-Robots-Tag` check in `apps/web/e2e/smoke.spec.ts`.)_
- **Do not key off `ENV`.** `production` is the pre-launch demo. The gate is a dedicated var so the indexable env is an explicit, deliberate choice. At public launch, set `ALLOW_INDEXING=true` on that one env (`apps/web/wrangler.jsonc` `vars`); the helper is `indexingAllowed()` in `apps/web/src/server/robots-policy.ts`.

---

## 8. Cross-references

- `STAGE_1_SPEC.md` — overall Stage 1 contract; §9.1 / §9.1a / §9.1b remain authoritative for the SSR Worker entry shape, visitor-state rule, and pinned-404 trap.
- `STAGE_1_PHASE_2_SPEC.md` §8 — originating section. Now superseded by this doc for caching specifics; the Phase 2 Spec keeps §8 as the historical record of why Phase 2 adopted the tag-based model.
- `API_CONTRACTS.md` — response envelope shapes (the response objects this doc adds headers to).
- `CICD_PLAN.md` — deployment workflow and Wrangler secret management for `ADMIN_PURGE_TOKEN`.
- [AECI-35](https://linear.app/aec-integrations/issue/AECI-35) — SSR Worker cookie-stripping middleware (visitor-state-neutral rendering).
- [AECI-41](https://linear.app/aec-integrations/issue/AECI-41) — theme service tests and SSR-side theme handling.
- [AECI-43](https://linear.app/aec-integrations/issue/AECI-43) — API responses are `private, no-store`; only SSR HTML is edge-cached.
- [AECI-56](https://linear.app/aec-integrations/issue/AECI-56) — Cache-Tag write helper + `POST /admin/purge` endpoint implementation.

---

## 9. Target model (post-migration, AECI-314) — outline

> **Not yet in force.** This is a forward-looking sketch of the shape the WC-11 (AECI-325) rewrite will fill in once native Workers Cache ships. The authoritative decision is [ADR 0020](adr/0020-workers-cache-and-queue-purge.md); the per-issue detail is WC-2…WC-11. §1–§8 above stay authoritative until the migration lands.

When native Workers Cache is enabled, the section-by-section shape becomes:

- **§1 Plan availability** → unchanged in substance (Cache-Tag purge on all plans), but Workers Cache is **zoneless**: no zone-level cache config, Cache Rules, or dashboard/API/Terraform purge affect it. The relevant limits become Workers Cache's (`≤1000 Cache-Tag values/response`, `≤1024 chars/tag`), replacing the HTTP purge's `≤30 tags/call`.
- **§2 Tag vocabulary** → **unchanged.** The same `product:{slug}` / `vendor:{slug}` / `pair:{…}` / `taxonomy` / `index:{…}` / `route:{…}` tags are emitted; only the emit **surface** moves (the cached `Renderer` entrypoint sets `Cache-Tag`).
- **§3 Tag composition** → **unchanged** (`buildCacheTags` / `cacheTagInputsForPath` in `apps/web/src/server/cache-tags.ts` keep emitting; they now feed the response the `Renderer` returns).
- **§4 TTLs per route class** → **unchanged** `Cache-Control` values (`s-maxage`/`max-age`); the platform stores from `Cache-Control` instead of an explicit `cache.put()`. Additive knob **adopted in WC-3** (ADR 0020 Q4): `stale-while-revalidate=60` / `stale-if-error=86400` on the detail + index/browse routes.
- **§4a Cache-key normalization** → **removed in WC-3, restored in WC-4 (done).** A `cache.enabled:false` **gateway** (default entrypoint) computes `cacheKeyFor(url)` (strip `utm_*`/non-allowlisted params, per-route allowlist, `searchParams.sort()`, plus a value sort on multi-select facet CSVs), then forwards `ctx.exports.Renderer.fetch(request, { cf: { cacheKey } })`; the custom `cf.cacheKey` replaces path+query in the native key (so the key is path-relative, origin dropped). See §4a.
- **§5 Invalidation** → **Native, split by locality.** `ctx.cache.purge({ tags })` replaces the HTTP `callCloudflarePurge`. **Cross-Worker** producers on the API Worker (`POST /api/promote`, review moderation) enqueue onto `aeci-cache-purge-{env}` and the SSR `queue()` consumer issues the purge — **WC-5 (AECI-319) landed** this. **`/admin/purge` is the exception:** it already runs on the SSR Worker, so **WC-6 (AECI-320) migrated it to call `ctx.cache.purge()` in-process** — no queue hop. Datatool (WC-7) still follows. The ordered **refresh-stats-then-purge** home flow is preserved (recompute `home.*` stats, then enqueue the `index:home` purge). Both purge paths must run from the cached **`Renderer`** entrypoint (`ctx.cache.purge()` is entrypoint-scoped). **WC-4 (AECI-318) landed the gateway/`Renderer` split, so:** the default-export queue consumer delegates its purge into `Renderer.purgeCache()` over the `ctx.exports` loopback, and `/admin/purge` is already `Renderer`-scoped because the whole Hono `app` runs inside `Renderer.fetch` (ADR 0020 §2). `CF_PURGE_API_TOKEN` is retired (WC-10); **`CF_ZONE_ID` is kept** (AECI-262 WAF poll).
- **§6 Cookie / cache hygiene** → **unchanged in intent.** `Set-Cookie` responses BYPASS the native cache automatically; the cookie-strip stays on the miss/uncacheable path; the pinned-404 trap is re-expressed against the native model (404s carry a short TTL and the `route:404` tag).
- **§7 SEO header set** → the crawler-indexing gate (§7.1 `X-Robots-Tag`) was the **highest-risk item** under a front-of-Worker cache: a HIT skips the Worker, so the egress `noindex` stamp can't run per-HIT. **Landed in WC-8 (AECI-322):** the stamp runs on the default entrypoint the cache wraps, so `noindex` is baked into the cached payload on the MISS render and served on every HIT — a cache HIT can never leak an indexable non-prod page (§7.1). `Vary: Accept-Language` + `Link`/CSP discipline carry over (also baked pre-store via `withCacheHeaders`).
- **§8 Cross-references** → add ADR 0020 and the WC-* issues; retire references to the HTTP purge transport once WC-10 lands.
- **New: Observability & local-dev** → **landed in WC-8 (AECI-322):** `Cf-Cache-Status` (`HIT`/`MISS`/`EXPIRED`/`BYPASS`/…) is the primary HIT/MISS signal and edge HIT-rate lives on the **Cloudflare Workers observability dashboard**. The SSR render metrics only emit `cache_status:MISS`/`miss`/`non_cacheable` (a HIT skips the Worker), so the Datadog `cache hit rate < 70%` monitor + dashboard widget were **retired** (they would flatline at 0 / alert forever). Front-of-Worker HIT/MISS is **verified on a deployed preview**, not local miniflare (WC-9, ADR 0020 Q3). See `docs/OBSERVABILITY.md`.
