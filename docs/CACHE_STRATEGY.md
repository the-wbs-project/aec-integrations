# AEC Integrations — Edge Cache Strategy

**Status:** Active — source of truth for AECi edge caching
**Supersedes (for caching specifics):** `STAGE_1_SPEC.md` §9.2 and §9.3
**Established by:** Phase 2 (`STAGE_1_PHASE_2_SPEC.md` §8); extended in Phase 4 / 5 / 6 as new entity types and write paths come online
**Companion docs:** `STAGE_1_SPEC.md`, `STAGE_1_PHASE_2_SPEC.md`, `API_CONTRACTS.md`, `CICD_PLAN.md`

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
| `integration:{id}` | The integration detail page |
| `category:{slug}` | Category browse page |
| `audience:{slug}` | Audience browse page |
| `phase:{slug}` | Project phase browse page |
| `taxonomy` | Any page that displays the full taxonomy (nav, footer, `/categories`) |
| `index:products` / `index:vendors` / `index:integrations` / `index:categories` | The respective index pages |
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
2. **Embedded entities also tag.** Any entity rendered in the response — even transitively — contributes a tag. A product detail page embeds its vendor → also `vendor:{vendor-slug}`. An integration page embeds both linked products → also `product:{source-slug}` and `product:{target-slug}`. A browse page lists every product matching the facet → tag each: `product:{slug-1}, product:{slug-2}, …`. A page that renders the taxonomy nav also carries `taxonomy`. This is what makes purge-by-tag exhaustive — editing a vendor invalidates every product page that displays it, with no URL bookkeeping.
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

`entity.type` is the tag prefix (`product`, `vendor`, `integration`, `category`, `audience`, `phase`, or `index` for index pages); `slug` or `id` is the suffix (slug for slug-keyed entities, id for `integration:<id>`). `taxonomy: true` appends the global `taxonomy` tag — set on routes that render the taxonomy nav (home today; more in Phase 4+). Static pages with no §2 vocabulary entry (`/about`, `/legal/*`) pass `entity` as `undefined`, yielding just the route-class tag.

The companion helper `cacheTagInputsForPath(localeStrippedPath)` (same module) returns the helper's input shape for every cacheable URL the SSR Worker handles, mirroring `ROUTE_CACHE_PATTERNS` in `server-runtime.ts`. Adding a new cacheable URL means extending both that table and `cacheTagInputsForPath` in the same change — and, if the URL takes content-affecting query params, its `cacheKeyParams` allowlist (see §4a). Callers never construct `Cache-Tag` strings by hand.

---

## 4. TTLs per route class

`Cache-Control: max-age={browser} s-maxage={edge}`

| Route class | `max-age` (browser) | `s-maxage` (edge) |
|---|---|---|
| Detail pages | 0 | 900 (15 min) |
| Browse pages (category / audience / phase) | 0 | 300 (5 min) |
| Index pages | 0 | 300 (5 min) |
| Taxonomy fetch (`/taxonomy`) | 0 | 3600 (1 hr) |
| `sitemap.xml` | 0 | 3600 |
| `robots.txt` | 86400 | 86400 |
| 404 | 0 | 60 |

`max-age: 0` on browser is deliberate — the browser revalidates on every navigation, the edge absorbs the actual load. Combined with tag-based purge, the worst-case staleness for an end user is one edge round-trip after a write, not 15 minutes.

Per [AECI-43](https://linear.app/aec-integrations/issue/AECI-43), API responses themselves remain `Cache-Control: private, no-store`. Only SSR HTML is edge-cached.

Non-cacheable routes (`/api/*`, `/auth/*`, `/account*`, `/search`) are excluded from the cacheable branch in the SSR Worker entry — they emit `Cache-Control: private, no-store` and never reach the tag/TTL machinery. See `STAGE_1_SPEC.md` §9.1 and [AECI-35](https://linear.app/aec-integrations/issue/AECI-35) for the route classifier.

**Exception — 404 responses on non-cacheable paths (AECI-62):** if the Angular SSR renderer returns HTTP 404 on a non-cacheable path (e.g. an unknown URL caught by the `**` wildcard route), the Worker applies `NOT_FOUND_TTL` (`max-age=0, s-maxage=60`) and `Cache-Tag: route:404` instead of `private, no-store`. The 404 content is session-neutral (no user-specific data), so edge caching is safe and prevents a flood of unknown URLs from melting the SSR Worker. The `route:404` tag provides the same bulk-purge handle as on cacheable routes. All other non-cacheable responses (2xx, 3xx, 5xx) continue to emit `private, no-store`.

---

## 4a. Cache key normalization (AECI-100)

The edge cache is keyed by URL. The SSR Worker's `caches.default` lookup/write key is built by `cacheKeyUrl(url)` in `server-runtime.ts`, **not** from the raw request URL — otherwise marketing/tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, …) on shared links would fragment the cache for pages that render identically, turning every variant into a MISS → SSR render → store.

The normalized key is:

```
{origin}{pathname}  +  only the route's content-affecting query params, canonically ordered
```

- **Origin + pathname are preserved verbatim**, including any locale prefix — locale variance is already segmented at the URL-prefix layer (§7), so the key must keep it.
- **All other query params are dropped.** Detail, home, browse, and static routes are query-independent → the entire query string is stripped.
- **Index routes keep only their declared content params**, sorted (so `?sort=name&page=2` and `?page=2&sort=name` are one entry).

The per-route allowlist lives on each `ROUTE_CACHE_PATTERNS` entry as `cacheKeyParams` (co-located with the TTL and the `match` predicate so the three stay in sync):

| Route | `cacheKeyParams` (kept in the key) |
|---|---|
| `/products`, `/vendors` (index) | `page`, `perPage`, `sort` |
| `/integrations` (index) | `page`, `perPage`, `sort`, `sourceProductId`, `targetProductId` |
| Detail (`/products/:slug`, `/vendors/:slug`, `/integrations/:id`) | none — strip all |
| Browse (`/categories\|audiences\|phases/:slug`), taxonomy index (`/categories`) | none — strip all |
| Home (`/`), `/about`, `/legal/*` | none — strip all |

**Maintenance rule (load-bearing).** The allowlist must be a **superset** of every query param the page component reads from the URL. Under-including is a correctness bug, not just a perf one: it collapses two distinct renders onto one key and serves the wrong HTML. So when a Phase 3+ change adds a content-affecting query param to an index/browse page (a new facet, `search`, a filter), add it to that route's `cacheKeyParams` in the same change. Over-including is merely wasteful (a harmless extra entry), so when in doubt, include. `perPage` is listed today for forward-safety even though the index components currently hardcode the default and don't read it from the URL.

**Scope.** This normalizes the Worker-managed `caches.default` key only. Cloudflare's zone-level CDN cache (Cache Rules / "ignore query string") is a separate layer configured outside this code; the Worker key is the normalization point for the AECi SSR cache.

---

## 5. Invalidation mechanism

The one outbound call that actually invalidates the edge cache is a stateless `POST https://api.cloudflare.com/.../zones/{zone}/purge_cache` with a `{ tags }` body (≤ `CF_PURGE_MAX_TAGS` = 30 tags/call, Pro plan). That transport lives **once** in `@aeci/shared` (`callCloudflarePurge`, `packages/shared/src/cache-purge.ts`) and has **two call sites**:

**(a) `POST /admin/purge` on the SSR Worker** — the manual / incident-response + CI surface:

- Authenticates the *caller* via a long-lived admin token (Wrangler secret named `ADMIN_PURGE_TOKEN`)
- Body: `{ tags: string[] }`
- Delegates to the shared transport (CF purge-by-tag for the zone)
- Respects Pro plan rate limits (token bucket per account); CF 429s surface in `failed[]`
- Logs to Datadog and emits `aeci.cache.purge{source,outcome}`

Auth: Wrangler secret in Phase 2. **Migrate to Cloudflare Access in Phase 6** when admin tooling expands and there are multiple admin endpoints behind the same auth boundary.

Callers of `/admin/purge`:

- Manual incident response (curl)
- CI (`promote-to-prod.yml` purges `taxonomy` + `route:browse` after the reference-data seed)
- Future admin tooling (Phase 6) — direct call from admin Workers, not n8n

**(b) `POST /api/promote` on the API Worker** — purges **directly** (no `/admin/purge` hop) after a promote commits, using the same shared transport and its **own** `CF_PURGE_API_TOKEN` + `CF_ZONE_ID`. This replaced the original api→web `WEB` service binding; see **ADR 0010** (`docs/adr/0010-promote-purges-cloudflare-directly.md`). The purge is best-effort, post-commit (`ctx.waitUntil`), and a graceful no-op when the API Worker's CF credentials are unset (local dev, PR previews).

Automated callers beyond promote (e.g. a Supabase webhook on row update) are Phase 4+. A Cloudflare Queue fronting the shared transport is the documented evolution once several cross-Worker producers or bulk-purge volume justify it (ADR 0010, Option C).

Implementation of the endpoint shape, rate-limit handling, and Datadog wiring landed in [AECI-56](https://linear.app/aec-integrations/issue/AECI-56) (Phase 2.10); the promote→purge wiring in [AECI-105](https://linear.app/aec-integrations/issue/AECI-105).

**Cloudflare API token scoping:** every `CF_PURGE_API_TOKEN` (the SSR Worker's **and** the API Worker's) must be scoped to `Zone.Cache Purge` on `aecintegrations.com` only — the narrowest possible scope. Reviewers should reject any change that broadens this token scope under deadline pressure; rotate by issuing a new token with the same minimal scope (rotate both Workers together).

---

## 6. Cookie / cache hygiene

The Phase 2 Spec defers most of this to AECI-35 / AECI-41 ("inherits, no new work"). The full operative rules — still load-bearing for every Phase 2+ surface — are restated here so callers don't have to chase them through `STAGE_1_SPEC.md`:

### 6.1 Visitor-state-neutral HTML

Edge cache is keyed by URL. If SSR reads a request cookie (e.g. `theme=dark`) and bakes it into the rendered HTML, the first visitor primes the cache for everyone — a dark-mode visitor's render is served to a light-mode visitor, and vice versa.

**Rule:** for any cacheable route, the Worker strips visitor-state cookies (`theme`, future analytics cookies, etc.) before forwarding the request to the Angular SSR handler. The client reconciles state post-hydration from `localStorage` + `matchMedia` and repaints. Server-rendered HTML is neutral by design.

This is *not* solvable with `Vary: Cookie` — see §7 below for which `Vary` values are permitted and which still fragment the cache. The cookie-stripping middleware lives at `apps/web/src/server.ts` (shipped in [AECI-35](https://linear.app/aec-integrations/issue/AECI-35); theme service test coverage added in [AECI-41](https://linear.app/aec-integrations/issue/AECI-41)). Cross-reference: `STAGE_1_SPEC.md` §9.1a.

**Incremental hydration stays cache-neutral.** The two detail-page `@defer (on viewport; hydrate on viewport)` grids (`product-detail.ts` integrations, `vendor-detail.ts` products; AECI-130) SSR-render their main template instead of the `@placeholder`. The rendered rows come only from resolver data (no request cookie is read), so the SSR HTML remains visitor-state-neutral and the edge cache is not fragmented.

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
  - `connect-src 'self' https://browser-intake-datadoghq.com https://*.algolia.net https://*.algolianet.com https://cloudflareinsights.com` — the `/api/*` proxy, the Datadog RUM intake host, the Algolia search origins, and the Cloudflare Web Analytics report host. The v7 browser SDK beacons to `browser-intake-datadoghq.com`, a distinct registrable domain (a `*.datadoghq.com` wildcard does **not** match it). This assumes the default `DD_SITE=datadoghq.com` (US1); other sites use a different `browser-intake-*` host (e.g. `browser-intake-datadoghq.eu`). The Algolia origins were added in **AECI-136** (Phase 3.4) for InstantSearch: the browser client resolves its query host as `{appId}-dsn.algolia.net` with `{appId}-{1,2,3}.algolianet.com` retry fallbacks, so the two wildcards cover every search XHR. `https://cloudflareinsights.com` is where the Cloudflare Web Analytics beacon POSTs its RUM payload (`/cdn-cgi/rum`); it pairs with the `static.cloudflareinsights.com` entry on `script-src`.
  - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'` — hardening

**Note on the `Vary` policy.** This updates the previous `STAGE_1_SPEC.md` §9.3 stance ("no `Vary` headers on cached SSR responses"). The reasoning behind the original ban — `Vary: Cookie` and `Vary: User-Agent` fragment the edge cache without a corresponding invalidation handle — still holds for *those* values. `Vary: Accept-Language` is safe because locale variance is already segmented at the URL-prefix layer, so there's no additional cache fragmentation beyond what the URL key already provides. Any *other* `Vary` value (`Cookie`, `User-Agent`, etc.) remains forbidden.

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
