# AEC Integrations — Edge Cache Strategy

**Status:** Active — source of truth for AECi edge caching
**Model:** Native Cloudflare Workers Cache (a cache HIT skips the SSR Worker). Design & rationale in [ADR 0020](adr/0020-workers-cache-and-queue-purge.md) (amends [ADR 0004](adr/0004-pro-plan-and-cache-tag-purge.md); reverses the mechanism in [ADR 0010](adr/0010-promote-purges-cloudflare-directly.md)).
**Supersedes (for caching specifics):** `STAGE_1_SPEC.md` §9.1 / §9.2 / §9.3
**Established by:** Phase 2 (`STAGE_1_PHASE_2_SPEC.md` §8); migrated to native Workers Cache by the AECI-314 epic (WC-1…WC-11 / AECI-315…325)
**Companion docs:** `STAGE_1_SPEC.md`, `STAGE_1_PHASE_2_SPEC.md`, `API_CONTRACTS.md`, `CICD_PLAN.md`, `OBSERVABILITY.md`

> **How AECi edge caching works.** The SSR Worker sits behind **native Cloudflare Workers Cache** (`cache.enabled` in `apps/web/wrangler.jsonc`): the platform stores each cacheable response from its `Cache-Control` and serves future HITs **without running the Worker** — there is no hand-rolled `caches.default` match/put. Key normalization (utm-strip / per-route allowlist / canonical order / multi-select CSV sort) runs in a two-entrypoint **gateway** — the `default` export (cache off) computes `cacheKeyFor(url)` and forwards to the cached **`Renderer`** entrypoint via `cf.cacheKey` (§4a). Invalidation is native `ctx.cache.purge()`: in-process for `POST /admin/purge`, and cross-Worker (promote / moderation / datatool) over the **`aeci-cache-purge-{env}` Cloudflare Queue** whose SSR consumer delegates into `Renderer` (§5). The crawler `noindex` gate is baked into the cached payload on the MISS render (§7.1). The old HTTP `callCloudflarePurge` purge-by-tag transport and `CF_PURGE_API_TOKEN` were **retired in WC-10 (AECI-324)**.
>
> **Deployment status.** Native caching is **live on the `preview` + `staging` SSR envs**. `demo` + `production` ship the *same* two-entrypoint code but currently run **uncached** — no `exports` block in `apps/web/wrangler.jsonc`, so the `Renderer` cache is off and the gateway simply forwards every request. The prod-enable gate (WC-4/5/6/8, all merged) is met; flipping `demo`/`production` on is a **deliberate, separate step** (not part of WC-1…WC-11). Until then those tiers behave as they did before the migration — the SSR Worker runs on every request — and every purge path is a graceful no-op there (`outcome:no_cache` / `skipped:cache_disabled`).

---

## 1. Plan availability & Workers Cache limits

`Cache-Tag` and purge-by-tag are available on **all Cloudflare plans as of April 2025** — `Cache-Tag` is the AECi strategy from Phase 2 onward (this reversed the "Enterprise-only" assumption baked into earlier drafts of `STAGE_1_SPEC.md` §9). AECi runs on the **Pro** plan.

Native Workers Cache is **zoneless**: no zone-level cache configuration touches it. Cache Rules, the "ignore query string" toggle, and dashboard / API / Terraform `purge_cache` calls all operate on the separate zone CDN cache and are **inert** against Workers Cache — which is exactly why cross-Worker invalidation goes through the queue rather than a zone purge (§5). The limits that bind are Workers Cache's own: **≤ 1000 `Cache-Tag` values per response**, **≤ 1024 chars per tag** (printable ASCII, case-insensitive), and **≤ 1000 tags per `ctx.cache.purge()` call** — comfortably above AECi's per-write purge volume, and far above the retired HTTP purge transport's **≤ 30 tags/call** ceiling (ADR 0004, superseded on transport by ADR 0020).

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
| `trade:{slug}` | Trade browse page (`/trades/:slug`, AECI-538). Emitted for **every** trade, published or not — the publication gate (`STAGE_1_SPEC.md` §5.5a) controls indexability, not cacheability, and an unpublished page still renders and still needs purging when its product set changes. **Purge caveat:** because the `/trades` index and the primary-nav flyout list *published* terms only (the facet sidebar is exempt — its counts are scoped, see `TRADES_VOCABULARY.md` §6), a promote that pushes a term across (or back under) the `TRADE_PUBLISH_MIN_PRODUCTS` floor changes those surfaces too — so a promote touching any trade must purge `index:trades`, `taxonomy`, and `sitemap` alongside `trade:{slug}` (AECI-542/546). "Touching" includes a **removal**: re-promoting a product without a trade it previously carried can push that term back under the floor, and the promote response echoes only the trades that were *set* — so `promote.ts` reads the product's prior trades before the batch and passes them to `cacheTagsForPromote` as `removedTradeSlugs`. (The three sibling facets have no equivalent read: without a publication gate, a removal only staleness-affects that one browse page, which the 5-minute TTL covers.) |
| `taxonomy` | Any page whose cached HTML renders the full taxonomy term set — home (`/`) and the flat taxonomy index pages (`/categories`, `/audiences`, `/phases`, `/trades`). The primary-nav flyouts read the term set client-side from `/api/taxonomy`, so they do **not** bake it into page HTML and don't carry this tag. |
| `index:products` / `index:categories` / `index:audiences` / `index:phases` / `index:trades` | The respective index pages. (AECI-165 removed the `/vendors` and `/integrations` index pages — they 301-redirect to `/products` — so `index:vendors` / `index:integrations` are no longer emitted.) |
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
4. **A connector's product page tags its powered edges — and a promote purges it** (Stage 1.5 Addendum B, `STAGE_1_5_SPEC.md` §12.4). A `product_role: 'connector'` detail page renders the integrations it **powers** (`integrations.powered_by_product_id`), where it is the mechanism rather than an endpoint. Two halves, both required: **(a)** the resolver pushes `integration:{id}` plus **both** endpoint `product:{slug}` tags per powered edge — this product is neither endpoint, so both are genuinely embedded; **(b)** the promote ingest emits **`product:{poweredBySlug}`** from each integration result that names a powered-by product (`promote-cache-tags.ts`, fed by `PromoteIntegrationResult.poweredBySlug`). Rule (b) exists because no other rule reaches the connector: it is not the promoted product, not an endpoint, and not the pair. Without it a promote touching an Agave-powered edge leaves `/products/agave-erp-sync` stale until TTL. **Bounded gap:** re-pointing an edge to a different connector purges only the **new** one — the response carries the post-update slug — the same shape as the existing endpoint-move gap.

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

`entity.type` is the tag prefix (`product`, `vendor`, `pair`, `integration`, `category`, `audience`, `phase`, `trade`, or `index` for index pages); `slug` or `id` is the suffix (slug for slug-keyed entities — the pair page passes the composite `{min}__{max}` as its `slug` — id for `integration:<id>`). `taxonomy: true` appends the global `taxonomy` tag — set on routes whose HTML renders the full taxonomy term set (home `/` and the flat `/categories`, `/audiences`, `/phases`, `/trades` index pages). Static pages with no §2 vocabulary entry (`/about`, `/updates`, `/roadmap`, `/legal/*`) pass `entity` as `undefined`, yielding just the route-class tag.

The companion helper `cacheTagInputsForPath(localeStrippedPath)` (same module) returns the helper's input shape for every cacheable URL the SSR Worker handles, mirroring `ROUTE_CACHE_PATTERNS` in `server-runtime.ts`. Adding a new cacheable URL means extending both that table and `cacheTagInputsForPath` in the same change — and its per-route content-param allowlist (`cacheKeyParams`, restored in WC-4; see §4a). Callers never construct `Cache-Tag` strings by hand.

---

## 4. TTLs per route class

`Cache-Control: max-age={browser} s-maxage={edge}`

| Route class | `max-age` (browser) | `s-maxage` (edge) |
|---|---|---|
| Detail pages | 0 | 900 (15 min) |
| Browse pages (category / audience / phase / trade) | 0 | 300 (5 min) |
| Index pages | 0 | 300 (5 min) |
| `/api/taxonomy` fetch (nav flyouts) | 0 | not edge-cached — `private, no-store` (see below); KV read-through, 5 min, in the API Worker |
| `sitemap.xml` | 0 | 3600 |
| `robots.txt` | 86400 | 86400 |
| 404 | 0 | 60 |

`max-age: 0` on browser is deliberate — the browser revalidates on every navigation, the edge absorbs the actual load. Combined with tag-based purge, the worst-case staleness for an end user is one edge round-trip after a write, not 15 minutes.

**Resilience directives (WC-3 / AECI-317).** The data-backed **detail + index/browse** route TTLs also carry `stale-while-revalidate=60` and `stale-if-error=86400`, so the native Workers Cache serves a just-expired copy for up to 60s while it revalidates in the background (smoothing the TTL-boundary latency spike) and a day-old copy if the origin 5xxs during revalidation. Static pages (`/about`, `/legal`), redirects, `sitemap.xml`, `robots.txt`, and 404s deliberately omit them. Values live in the `RESILIENCE` const in `server-runtime.ts` and are tunable. Under native Workers Cache the platform stores each response **from its `Cache-Control`** — there is no explicit `cache.put()`.

Per [AECI-43](https://linear.app/aec-integrations/issue/AECI-43), API responses themselves remain `Cache-Control: private, no-store`. Only SSR HTML is edge-cached.

Non-cacheable routes (`/api/*`, `/auth/*`, `/account*`, `/admin*`, `/search`) are excluded from the cacheable branch in the SSR Worker entry — they emit `Cache-Control: private, no-store` and never reach the tag/TTL machinery. See `STAGE_1_SPEC.md` §9.1 and [AECI-35](https://linear.app/aec-integrations/issue/AECI-35) for the route classifier.

**`/admin/*` is deliberately uncacheable, and that must stay true.** The operator console renders one admin's view of the site, and the edge cache is keyed by URL — so a single cacheable `/admin` response would serve that view to the next visitor who happened to hit the path. `ADMIN_PANEL_SPEC.md` §9.2 makes "absent from `ROUTE_CACHE_PATTERNS`" a standing requirement rather than a current fact, and `apps/web/src/server.spec.ts` asserts `isCacheableRoute` returns `false` for `/admin`, its children, and their locale-prefixed forms. The panel's own API responses carry the same posture from the other side: `json()` in the API Worker defaults every response to `private, no-store`, and the `/api/admin/*` reads set no `Cache-Tag`. Do not add an `/admin` entry to `ROUTE_CACHE_PATTERNS` or to `cacheTagInputsForPath`.

**Exception — 404 responses on non-cacheable paths (AECI-62):** if the Angular SSR renderer returns HTTP 404 on a non-cacheable path (e.g. an unknown URL caught by the `**` wildcard route), the Worker applies `NOT_FOUND_TTL` (`max-age=0, s-maxage=60`) and `Cache-Tag: route:404` instead of `private, no-store`. The 404 content is session-neutral (no user-specific data), so edge caching is safe and prevents a flood of unknown URLs from melting the SSR Worker. The `route:404` tag provides the same bulk-purge handle as on cacheable routes. All other non-cacheable responses (2xx, 3xx, 5xx) continue to emit `private, no-store`.

---

## 4a. Cache key normalization (AECI-100 / WC-4)

Native Workers Cache keys on the **full, order-sensitive query string** by default, so without normalization `utm_*`/`fbclid` on shared links and different facet-click orders would each fragment the cache for pages that render identically. AECi normalizes the key with **`cacheKeyFor()`** behind the two-entrypoint **gateway pattern** (ADR 0020 §2), so `utm_*`/`fbclid` de-fragment, `?a=1&b=2` == `?b=2&a=1`, and the AECI-223 multi-select CSV collapses regardless of order. **Mechanism:** the SSR Worker's `default` export is a gateway (`exports.default.cache.enabled: false`, so it runs on every request); it computes `cacheKeyFor(url)` and forwards the *original* request to the cached `Renderer` entrypoint via `ctx.exports.Renderer.fetch(request, { cf: { cacheKey } })`. A custom `cf.cacheKey` **replaces the path+query** in the native key, so `cacheKeyFor` returns a **path-relative** string (origin isn't part of a custom key, and each env / Worker version is already an isolated cache namespace). The request itself is untouched (utm_* survive for the render + client analytics); only the *lookup key* is normalized. _(History: the pre-migration design normalized a full URL with `cacheKeyUrl()` for a hand-rolled `caches.default` match/put; WC-3 removed that pipeline and WC-4 (AECI-318) rebuilt the normalization as `cacheKeyFor()` behind the gateway.)_

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
| `/products` (index) | `page`, `perPage`, `sort`, `view`, `category_id`, `audience_id`, `phase_id`, `trade_id` |
| Browse (`/categories\|audiences\|phases\|trades/:slug`) | `page`, `perPage`, `sort`, `view`, `category_id`, `audience_id`, `phase_id`, `trade_id` |
| Detail (`/products/:slug`, `/vendors/:slug`) | none — strip all |
| Product-PAIR page (`/products/:context/integrations/:other`) | `view`, `context_version`, `other_version`. **`view`** — the Basic/Detailed disclosure toggle SSR-renders different content (Basic drops the claim lanes), so `?view=basic` and the `detailed` default MUST get distinct keys. Same rationale as `/products ?view=table` (AECI-190). The companion `aeci_pair_view` cookie (remembers the reader's choice) is **NOT** a cache-key input and is **NOT** in `VISITOR_STATE_COOKIES` — it is read only post-hydration in the browser, never by SSR (see §6.1). **The two version selectors** (AECI-303 / `STAGE_2_ATTESTATIONS_SPEC.md` §9.2) carry a version **label** each and change which claims render plus every added/removed/unchanged marker — and the pair resolver marks a non-default selection `noindex`, a decision baked into the stored payload (§7.2). Under-including them would serve one visitor's version selection *and its robots tag* to everyone. There is no cookie counterpart: a remembered version is meaningless on a different pair, and "latest × latest is the default" must track newly-published releases. |
| Taxonomy index (`/categories`, `/audiences`, `/phases`, `/trades`) | inherits the listing allowlist (combined `match`); these pages read none of it — harmless over-include |
| Home (`/`), `/about`, `/updates`, `/roadmap`, `/legal/*` | none — strip all |

The listing/browse rows share one `LISTING_CACHE_KEY_PARAMS` const in `server-runtime.ts` (AECI-143): `/products` and the four `:slug` browse pages all read `page` / `sort` / `view` and the taxonomy facet ids the `aec-facet-sidebar` writes to the URL (`category_id` / `audience_id` / `phase_id` / `trade_id`). **`view`** is the cards/table toggle: the two views SSR different markup, so they must key separately. The const has carried it since AECI-190 — this table omitted it until AECI-657, which is also when the browse pages gained the toggle and started reading it. On a browse page the page's own dimension rides the path (`/categories/:slug`), so only the *other* three facet ids ever appear in its query — but listing all four keeps the const uniform (over-including is harmless).

**Maintenance rule (load-bearing).** The allowlist must be a **superset** of every query param the page component reads from the URL. Under-including is a correctness bug, not just a perf one: it collapses two distinct renders onto one key and serves the wrong HTML. So when a Phase 3+ change adds a content-affecting query param to an index/browse page (a new facet, `search`, a filter), add it to that route's `cacheKeyParams` in the same change — AECI-143 did exactly this when it added the facet sidebar. Over-including is merely wasteful (a harmless extra entry), so when in doubt, include. `perPage` is listed today for forward-safety even though the index components currently hardcode the default and don't read it from the URL.

**Value-level normalization for multi-select facets (AECI-223 / WC-4).** The taxonomy facets are **multi-select** — each dimension accepts a comma-separated id list in a single `{kind}_id` param (`category_id=a,b`), matched as `OR within the dimension, AND across dimensions`. Two selections in different click orders (`a,b` vs `b,a`) are the same filter but would otherwise be **distinct cache keys** (and break SSR↔client HTTP-transfer-cache parity). Two layers enforce the invariant: (1) the **producer** `aec-facet-sidebar` emits the ids **sorted** before writing the param (`facet-sidebar.ts` `onRefine`), keeping the browser URL + transfer-cache key stable; and (2) **WC-4 hardened `cacheKeyFor`** to also split/sort/rejoin the multi-value facet params (the `MULTI_VALUE_CACHE_KEY_PARAMS` set), so even a raw/hand-typed/bot `?category_id=b,a` collapses onto the same edge entry — the cache-key layer no longer depends solely on the producer. (The old `cacheKeyUrl` sorted param *names* only, never value bytes; the value sort is the WC-4 addition.) The allowlist is unchanged (the param names already covered single-select). Any future writer of a list-valued cache-key param should add it to `MULTI_VALUE_CACHE_KEY_PARAMS`. **AECI-544's `trade_id` was exactly that miss** — it shipped as a fourth multi-select dimension in `DIMENSIONS` but was left out of this set until AECI-657, so a hand-typed `?trade_id=b,a` got a duplicate entry (content correct, since the sidebar sorts; entry redundant). The spec now asserts order-independence for all four dimensions by name, so the next facet cannot repeat it silently.

**And the inverse rule, because the set is not a free "consistency" win.** A param whose value is a single opaque string must stay OUT of `MULTI_VALUE_CACHE_KEY_PARAMS` — `sortCsv` splits on commas and rejoins, so it would silently rewrite a legitimate comma-bearing value. AECI-303's `context_version` / `other_version` are the live example: version labels are vendor-authored free text, so `R2024,SP1` is a valid label that the CSV sort would turn into a string matching no row. `apps/web/src/cache-key-url.spec.ts` pins this with a comma-bearing-label case; the test exists specifically to fail a future "add these for consistency" change.

**Query-dependent redirects must be edge-excluded (WC-4).** The gateway applies the normalized `cf.cacheKey` to **every** GET, and `cacheKeyFor` strips the whole query for any path not in `ROUTE_CACHE_PATTERNS`. A standalone 301 whose `Location` embeds the request query — the `/disciplines/* → /audiences/*` redirect (`audienceRedirect`) and the apex→`www` canonical flip both preserve `${url.search}` — therefore **cannot** be stored in the shared edge cache: two distinct-query links would normalize to the same key and the first-warmed `Location` would be served to all of them. These redirects use `Cache-Control: private, max-age=3600` (browser-cacheable, since the browser keys on the full URL, but never edge-stored) instead of the `public`/`s-maxage` TTL the SSR routes use, and carry **no `Cache-Tag`** (there is nothing edge-stored to purge). Rule for any new standalone redirect: if its `Location` depends on the query string, make it `private` (edge-excluded); if it redirects to a canonical path and drops the query (like `/vendors → /products`), it may stay `public`/edge-cacheable.

**Scope.** This normalizes the native Workers Cache key (via `cf.cacheKey` on the gateway→`Renderer` loopback) only. Cloudflare's zone-level CDN cache (Cache Rules / "ignore query string") is a separate layer configured outside this code; the gateway's `cacheKeyFor` is the normalization point for the AECi SSR cache.

---

## 5. Invalidation mechanism

Invalidation is **native Workers Cache `ctx.cache.purge()`** (ADR 0020 / epic AECI-314). The zone-level HTTP `purge_cache` is **inert against the SSR cache** — `ctx.cache.purge()` is entrypoint-scoped, and no zone configuration touches Workers Cache. Every purge surface evicts via `ctx.cache.purge()`, split by where the caller runs: `/admin/purge` **(a)** runs on the SSR Worker and purges **in-process** (WC-6 / AECI-320); `POST /api/promote` + review moderation **(b)** run on the API Worker — which can't reach the SSR cache directly — so they **enqueue** a typed `CachePurgeMessage` onto the **`aeci-cache-purge-{env}` Cloudflare Queue** (WC-5 / AECI-319), whose SSR `queue()` consumer delegates the purge into the cached `Renderer` entrypoint; datatool **(c)** enqueues likewise after a copy/seed/reindex.

The historical HTTP transport `callCloudflarePurge` — a stateless `POST https://api.cloudflare.com/.../zones/{zone}/purge_cache` with a `{ tags }` body (≤ 30 tags/call on the Pro plan) — was **removed in WC-10 (AECI-324)** once every caller had migrated to native/queue purge. `@aeci/shared` (`packages/shared/src/cache-purge.ts`) now holds only the queue message contract (`CachePurgeMessage`, `CACHE_PURGE_QUEUE_MAX_TAGS` = 1000). `CF_PURGE_API_TOKEN` was retired with it; `CF_ZONE_ID` is kept (the AECI-262 WAF poll uses it). Call sites:

**(a) `POST /admin/purge` on the SSR Worker** — the manual / incident-response + CI surface. **Migrated to native Workers Cache in WC-6 ([AECI-320](https://linear.app/aec-integrations/issue/AECI-320)):** because this endpoint runs on the same SSR Worker that owns the cache, it invalidates **in-process** via `ctx.cache.purge(...)` — no outbound Cloudflare REST call, no `@aeci/shared` `callCloudflarePurge`, no queue hop.

- Authenticates the *caller* via a long-lived admin token (Wrangler secret named `ADMIN_PURGE_TOKEN`) — **unchanged** by the migration.
- Body: one or both of `{ tags: string[] }` / `{ pathPrefixes: string[] }`, or `{ purgeEverything: true }` on its own — the three native purge modes (`purgeEverything` is exclusive; `tags`+`pathPrefixes` union). The legacy `{ tags: [...] }` body stays valid.
- Delegates to `ctx.cache.purge(...)`; the result `{ success, errors }` is surfaced in the response body. The tag cap is the native ceiling (≤ 1000 `Cache-Tag` values/response), **not** the old HTTP transport's 30-tags/call limit.
- Purge shares Cloudflare's zone-purge rate limiter; a rejection resolves to `{ success: false, errors }` → HTTP 502.
- **No longer reads `CF_PURGE_API_TOKEN` / `CF_ZONE_ID`** (native purge needs neither). Both purge secrets were pruned in WC-10 ([AECI-324](https://linear.app/aec-integrations/issue/AECI-324)).
- **Entrypoint scoping (load-bearing):** `ctx.cache.purge()` only evicts the *calling entrypoint's* cache. The cached SSR responses live in the **`Renderer`** entrypoint, and `/admin/purge` runs inside `Renderer` too — the gateway forwards every request to `Renderer.fetch`, which runs the whole Hono app — so this handler and the cached responses share one cache and the in-process purge is correctly scoped **without** a loopback. (The cross-Worker queue consumer is the exception: it runs on the cache-less `default` export and must delegate into `Renderer.purgeCache()` — see (b) below.)
- **Cache-disabled tiers:** `ExecutionContext.cache` is absent when Workers Cache is not enabled on the entrypoint (local/miniflare + the currently-uncached demo/production tiers). There the handler returns a graceful no-op (`200 { success: true, skipped: 'cache_disabled' }`) so CI's post-promote purge and manual callers stay green whether or not native cache is enabled on the tier.
- Logs to Datadog and emits `aeci.cache.purge{source,outcome,mode}` (outcomes: `ok` / `failed` / `skipped`).

Auth: Wrangler secret in Phase 2. **Migrate to Cloudflare Access in Phase 6** when admin tooling expands and there are multiple admin endpoints behind the same auth boundary.

Callers of `/admin/purge`:

- Manual incident response (curl)
- CI (`promote-to-prod.yml` purges `taxonomy` + `route:browse` after the reference-data seed) — inherits the native backend automatically (it only checks the HTTP status)
- Future admin tooling (Phase 6) — direct call from admin Workers, not n8n

**(b) `POST /api/promote` + review moderation on the API Worker** — since WC-5, these **enqueue** onto `aeci-cache-purge-{env}` (producer binding `CACHE_PURGE_QUEUE`) after the write commits — for promote, from `dispatchPromoteHooks` *after* the Workflow commit step resolves rather than from the request (AECI-563 / ADR 0021), so a step replay cannot double-enqueue; the SSR consumer issues the `ctx.cache.purge()`. Best-effort, post-commit (`ctx.waitUntil`), a graceful no-op when the queue binding is unset (local dev, PR previews), and never fails the committed write (a `queue.send` rejection is logged and swallowed). The promote's entity/index/pair/taxonomy tags are derived by `cacheTagsForPromote` (`promote-cache-tags.ts`); review moderation enqueues `product:{slug}`; the **vendor-claim grant** (`PATCH /api/admin/claims/:id`, AECI-519) enqueues the vendor **and its products** — `{ tags: ['vendor:{slug}', 'product:{slug}'…, 'index:products'], source: 'moderation' }` — because it flips `vendors.verified` (unlike plain request-moderation, which purges nothing). One message per ≤1000-tag batch (`CACHE_PURGE_QUEUE_MAX_TAGS`, vs. the HTTP transport's 30). This supersedes the ADR-0010 direct HTTP purge (which is inert against Workers Cache); the message is async, so there is still no api→web service binding.

**(b1) entitlement set / clear (Stage 2 paid tiers, AECI-532)** — `PATCH
/api/admin/vendors/:id/entitlement` enqueues **the same tag set as the claim grant
above**, from the same builder: `vendorPurgeTags` was promoted out of
`admin-claims.ts` into the shared `apps/api/src/lib/vendor-cache-tags.ts` precisely
because this epic added a second writer of it, and duplicated tag construction is how
a badge goes stale on one path and not the other. **No new tag** — the verified badge
renders on the vendor hero, the product-detail vendor card and both pair rails, all of
which are already covered by `vendor:{slug}` + every owned `product:{slug}` +
`index:products`.

Two deliberate details. **`clear` purges as hard as `set`**: this is the only writer
that takes `vendors.verified` back *down* (`STAGE_2_PAID_TIERS_SPEC.md` §5), and a
missed purge there leaves a Verified badge on every cached product page of a vendor
who is no longer paying. And the purge is **not gated on whether the mirror actually
flipped** — on a drifted vendor a redundant purge costs one cache miss, while a missed
one is a wrong badge with a full TTL behind it. **`renew` is the exception and skips
the purge entirely**, because its builder provably emits no `vendors` statement at all,
so nothing rendered can have changed. Search freshness rides the same nightly watermark
as every other vendor write (see the verified-badge-flip paragraph below): the flip
stamps `vendors.updated_at` in **both** directions, so an un-verify reaches Algolia
within 24h rather than never.

**(b2) the `/api/vendor/*` write surface on the API Worker (Stage 2, AECI-520 /
607 / 301)** — the vendor portal's self-service edits use the same producer path
with a distinct `source: 'vendor'`, so the `aeci.cache.purge{source}` metric
separates vendor-initiated invalidation from AECi-initiated `moderation`. One
helper enqueues for all of them (`purgeTags` / `afterVendorWrite` in
`apps/api/src/routes/vendor-shared.ts`); only the tag set differs per write.

- **Profile edit** → `vendor:{slug}`. One tag suffices by the §3 embedded-entity
  rule: a product detail page tags the vendor it displays, so every page showing
  that vendor repaints.
- **Product edit** → `product:{slug}` **plus** `category:{slug}` /
  `audience:{slug}` / `phase:{slug}` for the **union of the product's facet
  membership before and after the edit**. The union is load-bearing and is the
  easy thing to get wrong: `product:{slug}` only covers browse pages that
  **already list** the product, so a page the product has just been *added to*
  never carried that tag and would stay stale for a full browse TTL — the vendor
  reloads the category they just joined and their product isn't there. Purging
  the page it left *and* the page it joined fixes both directions. This mirrors
  the promote deriver, which tags created **and** reused terms for the same
  reason (`promote-cache-tags.ts`). The `taxonomy` tag is deliberately **not**
  emitted: that one is for a change to the term *set*, and a vendor can only
  assign existing terms, never mint one.
- **Product-version write** (`POST`/`PATCH`/`DELETE
  /api/vendor/products/:id/versions`, AECI-607) → **`product:{slug}` alone**, and
  that is the complete set for two reasons worth stating so nobody "fixes" it
  later. The pair page embeds `product:{slug}` for **both** of its endpoints
  (§3 rule 2), so this one tag also drops every pair page the product appears on
  — which is where AECI-303's version selectors **now** render, and the only
  reader-facing consumer versions will ever have. That still holds after AECI-303:
  the selectors are URL params on the pair route, and a tag purge is key-independent,
  so one `product:{slug}` invalidates *every* cached version selection of every pair
  the product appears on. The new `…/integrations/:otherSlug/timeline` read needs no
  tag of its own — it is `private, no-store` and never edge-stored, which is exactly
  why the gateable history lives there rather than in the pair page's shared entry
  (§7.2). And `index:products` is deliberately omitted:
  unlike a product edit, versions never appear on the `/products` catalog, so
  purging it would evict a 300s-TTL page for content that cannot have changed.
- **Attestation write** (`POST /api/vendor/claims`, `PUT`/`DELETE
  /api/vendor/claims/:claimId/attestation`, AECI-301) → **`pair:{min}__{max}`
  plus `product:{sourceSlug}` and `product:{targetSlug}`**, three tags, all
  required. The pair tag is emitted through `pairCacheTag()`
  (`apps/api/src/routes/promote-pair.ts`) — the **identical** primitive the pair
  page itself uses, and the same one `cacheTagsForPromote` calls, so the writer
  and the reader can never drift on the `{min}__{max}` ordering. The pair page is
  the primary surface a claim edit changes, but the two `product:{slug}` tags are
  not redundant: the product-detail integrations table renders a claims-aware
  `context_direction`, and since AECI-605 a claim every voting vendor **denies**
  stops contributing its direction to that arrow — so a denial with no product
  purge would leave the table pointing the wrong way for a full TTL.
  `index:products` is omitted for the same reason as versions: claims never render
  on the catalog.

Same best-effort contract — no-op without the binding, `queue.send` rejection
logged and swallowed, never fails the committed edit. Note the asymmetry with
search: the purge makes SSR immediate, while Algolia only catches up on the
nightly watermark sync (≤24h — `STAGE_2_SPEC.md` §8.3(5)); a vendor **profile or
product** write always stamps `products.updated_at` so that sync actually sees it,
including a taxonomy-only edit that touches no other column. A **version** write
deliberately does not stamp it: versions do not feed the Algolia record, so
bumping `updated_at` would drag the product through the nightly window for
nothing. An **attestation** write does not stamp it either, and for a stronger
reason — claims are not in the search index at all (`STAGE_1_5_SPEC.md` §9 defers
per-pair records), so there is nothing for a sync to pick up. Dashboard copy must
therefore not promise that attesting changes search. The same asymmetry governs the
**verified-badge flip** (AECI-529): the §5(b) claim→grant stamps `vendors.updated_at`
alongside `verified = true`, so the `vendors` index re-indexes the flip on the next
nightly window while the grant's `vendor:{slug}` + `product:{slug}` purge repaints the
SSR pages immediately. The badge therefore appears on the vendor's SSR detail/product
pages at once but on the `/search` Vendors-tab card only after the next sync
(`SEARCH_RANKING.md` §6). Since AECI-609 that stamp is governed by a sharper rule:
**`vendors.updated_at` moves if and only if `vendors.verified` moves**, in either
direction, stamped explicitly inside the same guarded `WHERE verified = <old>` rather
than left to `$onUpdate`. Both halves earn their keep — a second-seat grant or a term
renewal must *not* bump it (needless nightly re-push of an unchanged record), and an
**un-verify must**, or a lapsed vendor keeps a Verified badge in search indefinitely.
That second direction is the one AECI-529 never reasoned about, because until AECI-532
nothing could clear the bit.

The home page's `index:home` tag is the one deliberate exception: it is **not** in `cacheTagsForPromote`, because the home banner reads `home.*` `stats_cache` counts that the promote must **recompute first** (via `runHomeStats`). So the home refresh+enqueue is its own ordered post-commit task (`refreshHomeStatsAfterPromote` in `promote.ts`, AECI-305): recompute `stats_cache`, **then** enqueue the `index:home` purge. Enqueueing `index:home` in the concurrent set would let the purge race ahead of the recompute and re-cache stale HTML for another edge TTL. The `stats_cache` recompute runs in every environment; only the `index:home` enqueue is queue-binding-gated.

**The SSR consumer** (`apps/web/src/server/cache-purge-queue.ts`) reads each `CachePurgeMessage` and — because it runs on the SSR Worker's **`default`** export, which has no cache of its own — **delegates** its `tags`/`pathPrefixes`/`purgeEverything` into **`Renderer.purgeCache()`** over the `ctx.exports` loopback (that method calls `ctx.cache.purge()` inside the cached `Renderer` entrypoint, the only place the eviction is correctly scoped — ADR 0020 §2). It emits `aeci.cache.purge{source,outcome}` — `outcome:ok` on `{ success: true }`, `outcome:purge_failed` on `{ success: false }` or a thrown error (the message is `retry()`-ed, up to the consumer's `max_retries`), `outcome:no_cache` when the env's cache is off (the currently-uncached demo/production tiers, where `Renderer.purgeCache()` returns `null`, so the consumer no-ops and acks), `outcome:noop` for an empty message. The metric **moved here off the producers** in WC-5.

**(c) datatool bulk purge on the datatool Worker** — after a copy/seed/reindex, `apps/datatool` (a third Worker; `apps/datatool/src/cache-purge.ts`) enqueues a single `{ purgeEverything: true, source: 'datatool' }` `CachePurgeMessage` onto the **target tier's** `aeci-cache-purge-{env}` queue (per-tier producer bindings `CACHE_PURGE_QUEUE_{STAGING,DEMO,PRODUCTION}` — it binds all three at once since it has no wrangler `env.*` blocks, and `targets.ts` selects one per request). The target tier's own SSR consumer evicts its whole cache. `purgeEverything` — not a tag list — because a full clone/seed invalidates everything and it avoids a tag-coverage gap. Best-effort / graceful no-op when the tier has no queue (preview / local), and never fails the D1 write. **WC-7 ([AECI-321](https://linear.app/aec-integrations/issue/AECI-321)) landed** this, replacing the datatool's old `BROAD_CACHE_TAGS` HTTP `callCloudflarePurge`; under per-Worker caches a purge no longer bleeds across tiers.

Automated callers beyond promote/moderation (e.g. a Supabase webhook on row update) are Phase 4+. The Cloudflare Queue fronting cross-Worker purge — the "Option C" ADR 0010 deferred — **landed in WC-5**.

Implementation of the endpoint shape, rate-limit handling, and Datadog wiring landed in [AECI-56](https://linear.app/aec-integrations/issue/AECI-56) (Phase 2.10); the promote→purge wiring in [AECI-105](https://linear.app/aec-integrations/issue/AECI-105); the cross-Worker queue purge in [AECI-319](https://linear.app/aec-integrations/issue/AECI-319) (WC-5).

**Cloudflare API token scoping:** every purge surface now presents **no** CF token — promote/moderation go through the queue, `/admin/purge` uses native `ctx.cache.purge()`, and the `retract-product` CLI prints the `POST /admin/purge` command for an operator to run. The zone `Zone.Cache Purge` token `CF_PURGE_API_TOKEN` was retired on both Workers in WC-10 ([AECI-324](https://linear.app/aec-integrations/issue/AECI-324)); `CF_ZONE_ID` is retained solely for the AECI-262 WAF firewall-event poll.

### 5a. Provisioning (how the three secrets get onto the Workers)

Purge needs three values, and *all three* are pushed by CI on every deploy/promote (`deploy.yml` → staging, `promote-to-demo.yml` → demo, `promote-to-prod.yml` → production). Set the GitHub Actions secret; the next deploy wires the Worker.

| Secret | Where it lands | What it does | Absent ⇒ |
| --- | --- | --- | --- |
| `ADMIN_PURGE_TOKEN` | web Worker | bearer the **caller** of `POST /admin/purge` presents | endpoint returns **401** for every request |
| `CF_PURGE_API_TOKEN` | web **and** API Worker | the token the handler/ingest uses to call Cloudflare | web: `/admin/purge` authenticates then returns **502**; API: promote purge is a silent no-op |
| `CF_ZONE_ID` | web **and** API Worker | the zone purge targets (also the zone the AECI-262 WAF poll queries) | same as above, plus the WAF poll reports `skipped_no_creds` |

All three are **recommended, not required** (`RECOMMENDED_SECRETS`, warn-and-skip): a missing purge credential degrades invalidation to TTL self-heal (≤5 min browse, ≤1 hr nav) — it never blocks a release.

**Ordering matters in CI.** `promote-to-prod.yml`'s taxonomy purge step runs *after* the SSR deploy and *after* the cache-purge secret push, because `POST /admin/purge` authenticates against the Worker's `ADMIN_PURGE_TOKEN`. It used to run right after the D1 migration — before any secret push — which 401'd deterministically. Keep it last.

> **History (2026-08-12).** These were documented as manual `wrangler secret put` steps and had never actually been placed on **any** deployed tier, so `POST /admin/purge` 401'd on staging, demo, and production, and the API Worker's post-promote purge silently no-op'd everywhere. `wrangler secret list` is the check: run it per env from `apps/web` and `apps/api` and expect the names above.

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
- **Cache-safe — baked pre-cache (WC-8 / AECI-322).** The header is stamped by egress middleware inside the cached SSR `Renderer` entrypoint, so it lands *before* the platform stores the response. Under native Workers Cache a HIT skips the Worker entirely, so the `noindex` decision is **baked once, on the MISS render that populates the cache, and served verbatim on every subsequent HIT** (no per-HIT re-stamp runs, and none is needed). The bake is env-neutral because each env is its own Worker + cache with its own `ALLOW_INDEXING`, so a non-indexable env's cache only ever stores `noindex` payloads. `applySeoHeaders` (the `Vary`/`Link`/CSP set, §7) is likewise applied pre-store — via `withCacheHeaders` on the MISS render — so the whole SEO/robots header set is baked together onto the stored payload. The response is rebuilt (not header-mutated) because a response's headers may be immutable. _(Pre-WC-3 the stamp ran after a hand-rolled `caches.default` put and re-ran on each HIT; WC-3 removed that manual pipeline, and WC-8/WC-9 verify the pre-store bake — see the "cacheable 200 bakes noindex + CSP + Vary" regression test in `apps/web/src/server.spec.ts`, and the deployed MISS-to-HIT check in `apps/web/e2e/edge-cache.spec.ts`.)_
- **Do not key off `ENV`.** `production` is the pre-launch demo. The gate is a dedicated var so the indexable env is an explicit, deliberate choice. At public launch, set `ALLOW_INDEXING=true` on that one env (`apps/web/wrangler.jsonc` `vars`); the helper is `indexingAllowed()` in `apps/web/src/server/robots-policy.ts`.

### 7.2 Per-page indexability (`<meta name="robots">`)

§7.1 is an **environment** switch: all-or-nothing, and it cannot say "this one page". Per-page indexability is a separate, **app-side** layer — Angular's `Meta` service via `MetaService.setEntityMeta({ noindex })` / `setStaticPageMeta({ noindex })` in `apps/web/src/app/core/meta.service.ts`. It is recorded here because the two are routinely confused: `apps/web/src/server/seo-headers.ts` sets **no** robots directive at all (only `Vary`, `Link`, and the CSP above), so a per-page `noindex` never comes from the SEO-header path.

The layers compose rather than conflict. Pre-launch, §7.1's blanket header dominates and the per-page tags are inert; at launch `ALLOW_INDEXING=true` lifts the blanket and the per-page tags become the operative policy. Cache-safety is not a concern for this layer: the tag is a property of the page's data, identical for every visitor, so it lives inside the cached HTML by design.

**One qualification, added by AECI-303.** "A property of the page's data" now includes *URL-derived* data — the pair page's version selection decides its own `noindex`. That is still identical for every visitor **of that URL**, and it is cache-safe only because the deciding params are in the route's `cacheKeyParams` (§4a). A per-page `noindex` that depended on anything *not* in the cache key — a cookie, a session, an entitlement — would poison the shared entry. That is the constraint AECI-304 inherits when it makes `canViewVersionDiff` visitor-dependent.

Pages that emit `noindex` today, and how:

| Page | Condition | Set by |
|---|---|---|
| Any 404 | always | `MetaService.setNotFoundMeta` |
| `/search` | always — filtered results aren't canonical content | `MetaService.setSearchMeta` |
| `/unsubscribe` | always — tokenized, transactional (AECI-537) | `setStaticPageMeta({ noindex: true })` |
| `/roadmap` | always (for now) — coming-soon placeholder, thin content; paired with sitemap exclusion | `setStaticPageMeta({ noindex: true })` |
| Product-pair page | no integrations between the two products, **or** a non-default version selection (AECI-303 / §9.2 — every (vA × vB) combination would otherwise be an indexable near-duplicate) | `setEntityMeta({ noindex })` — `products-pair.resolver.ts` |
| `/trades/:slug` | `product_count < TRADE_PUBLISH_MIN_PRODUCTS` (AECI-546) | `setEntityMeta({ noindex })` — `taxonomy-browse.resolver.ts` → `applyBrowseMeta` |
| `/auth/login`, `/account`, `/admin/*`, `/products/:slug/review`, the claim/correction request forms | always — authenticated or transactional | the component itself, calling Angular's `Meta.updateTag` directly rather than going through `MetaService` |

Two things worth noting about that last row: those pages are all non-cacheable, so the direct `Meta.updateTag` call carries no cache risk — but it also means `grep 'noindex'` over `MetaService` alone under-reports the set. `/contact`, `/about`, `/updates`, and `/legal/*` are static **and indexable**; they use `setStaticPageMeta` without the flag. `/roadmap` is the one static page that is cacheable **and** noindexed — a coming-soon placeholder is thin content, so it opts in to the flag and stays out of `sitemap.xml`; indexability and cacheability are independent axes.

The trade case is the only **count-gated** one, and it is deliberately paired with sitemap exclusion — the two must agree, or the sitemap advertises a page that tells the crawler to go away. The `/trades` index page and the three sibling taxonomy facets are never gated. Full policy: `TRADES_VOCABULARY.md` §6.

The directive emitted is a bare `noindex`, not `noindex, nofollow` (§7.1's env-wide value): a `noindex`ed page's outbound links should still be followed. This differs from §7.1 on purpose — a pre-launch site wants nothing crawled onward, whereas a thin-but-real page's links to products are worth following.

---

## 8. Cross-references

- [ADR 0020](adr/0020-workers-cache-and-queue-purge.md) — the decision record for the native Workers Cache + gateway + Cloudflare-Queue-purge model this doc describes (amends [ADR 0004](adr/0004-pro-plan-and-cache-tag-purge.md); reverses the mechanism in [ADR 0010](adr/0010-promote-purges-cloudflare-directly.md)). The migration shipped across the AECI-314 epic, **WC-1…WC-11 / AECI-315…325**.
- `STAGE_1_SPEC.md` — overall Stage 1 contract; **§9.1a / §9.1b** remain authoritative for the visitor-state-neutral rule and the pinned-404 trap. §9.1's original hand-rolled cache code block is **superseded** by §4a/§5 here (see the banner on §9.1); §9.2/§9.3 were already superseded.
- `STAGE_1_PHASE_2_SPEC.md` §8 — originating section. Now superseded by this doc for caching specifics; the Phase 2 Spec keeps §8 as the historical record of why Phase 2 adopted the tag-based model (its §8.4 carries a superseded banner pointing here for the current invalidation transport).
- `API_CONTRACTS.md` — response envelope shapes (the response objects this doc adds headers to).
- `CICD_PLAN.md` — deployment workflow and Wrangler secret management for `ADMIN_PURGE_TOKEN`.
- `OBSERVABILITY.md` — the `aeci.cache.purge` metric, the `Cf-Cache-Status` HIT/MISS signal, and the retired hit-rate monitor (see §9 below).
- [AECI-35](https://linear.app/aec-integrations/issue/AECI-35) — SSR Worker cookie-stripping middleware (visitor-state-neutral rendering).
- [AECI-41](https://linear.app/aec-integrations/issue/AECI-41) — theme service tests and SSR-side theme handling.
- [AECI-43](https://linear.app/aec-integrations/issue/AECI-43) — API responses are `private, no-store`; only SSR HTML is edge-cached.
- [AECI-56](https://linear.app/aec-integrations/issue/AECI-56) — Cache-Tag write helper + `POST /admin/purge` endpoint implementation.
- The retired HTTP `callCloudflarePurge` purge-by-tag transport + `CF_PURGE_API_TOKEN` were removed in **WC-10 (AECI-324)**; `@aeci/shared` now ships only the queue contract (`CachePurgeMessage`).

---

## 9. Observability & local-dev

**HIT/MISS signal.** Under native Workers Cache a HIT **skips the SSR Worker**, so there is no per-HIT Worker log to count. The primary HIT/MISS signal is the **`Cf-Cache-Status`** response header (`HIT` / `MISS` / `EXPIRED` / `BYPASS` / `DYNAMIC` / `REVALIDATED` / `UPDATING` / `STALE`), and edge HIT-rate lives on the **Cloudflare Workers observability dashboard**. The SSR render metrics only ever emit `cache_status:MISS` / `miss` / `non_cacheable` (a HIT never reaches them), so the Datadog **`cache hit rate < 70%` monitor + dashboard widget were retired in WC-8 (AECI-322)** — a Datadog-side hit-rate is structurally unmeasurable when HITs never run the Worker. See `docs/OBSERVABILITY.md` and `docs/RUNBOOKS.md` ("Low cache hit rate").

**Purge observability.** Every purge — in-process (`/admin/purge`), queue-consumer (promote / moderation / datatool), or a no-op on an uncached tier — emits `aeci.cache.purge{source,outcome,mode}` (§5). That metric is the Datadog-visible signal that invalidation is firing and which outcome it took (`ok` / `purge_failed` / `no_cache` / `noop` / `skipped`).

**Local dev.** Wrangler/Miniflare **does not emulate the native front cache**: it accepts the `cache.enabled` config, but repeated localhost requests still execute the Worker and carry **no** `Cf-Cache-Status` / `Age`. So the exact `MISS → HIT` contract can't be observed locally — it runs against each **deployed PR preview** via the request-only Playwright spec `apps/web/e2e/edge-cache.spec.ts` (WC-9 / AECI-323; ADR 0020 Q3). Confirmed local no-op versions: Wrangler 4.111.0 / Miniflare 4.20260710.0. Unit tests must **not** mock `caches.default` — the native front cache is not that API (see `docs/UNIT_TESTING_GUIDE.md`); the `server.spec.ts` "cacheable 200 bakes noindex + CSP + Vary" regression test asserts the pre-store header bake instead.

**Deploy behavior.** Each Worker version is its own cache namespace by default, so **every deploy cold-starts the cache** (`cross_version_cache` is off) — expect a HIT-rate dip after a release while the cache re-warms; tag purge and TTLs behave identically across versions. Demo/production run uncached today (see the deployment-status note at the top of this doc), so this applies to `preview` + `staging` for now.
