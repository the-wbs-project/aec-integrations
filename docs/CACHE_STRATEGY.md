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
| `discipline:{slug}` | Discipline browse page |
| `phase:{slug}` | Project phase browse page |
| `taxonomy` | Any page that displays the full taxonomy (nav, footer, `/categories`) |
| `index:products` / `index:vendors` / `index:integrations` / `index:categories` | The respective index pages |
| `sitemap` | `sitemap.xml` |
| `route:detail` / `route:index` / `route:browse` | Coarse-grained tags for bulk invalidation in incidents |

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

`entity.type` is the tag prefix (`product`, `vendor`, `integration`, `category`, `discipline`, `phase`, or `index` for index pages); `slug` or `id` is the suffix (slug for slug-keyed entities, id for `integration:<id>`). `taxonomy: true` appends the global `taxonomy` tag — set on routes that render the taxonomy nav (home today; more in Phase 4+). Static pages with no §2 vocabulary entry (`/about`, `/legal/*`) pass `entity` as `undefined`, yielding just the route-class tag.

The companion helper `cacheTagInputsForPath(localeStrippedPath)` (same module) returns the helper's input shape for every cacheable URL the SSR Worker handles, mirroring `ROUTE_CACHE_PATTERNS` in `server-runtime.ts`. Adding a new cacheable URL means extending both that table and `cacheTagInputsForPath` in the same change. Callers never construct `Cache-Tag` strings by hand.

---

## 4. TTLs per route class

`Cache-Control: max-age={browser} s-maxage={edge}`

| Route class | `max-age` (browser) | `s-maxage` (edge) |
|---|---|---|
| Detail pages | 0 | 900 (15 min) |
| Browse pages (category / discipline / phase) | 0 | 300 (5 min) |
| Index pages | 0 | 300 (5 min) |
| Taxonomy fetch (`/taxonomy`) | 0 | 3600 (1 hr) |
| `sitemap.xml` | 0 | 3600 |
| `robots.txt` | 86400 | 86400 |
| 404 | 0 | 60 |

`max-age: 0` on browser is deliberate — the browser revalidates on every navigation, the edge absorbs the actual load. Combined with tag-based purge, the worst-case staleness for an end user is one edge round-trip after a write, not 15 minutes.

Per [AECI-43](https://linear.app/aec-integrations/issue/AECI-43), API responses themselves remain `Cache-Control: private, no-store`. Only SSR HTML is edge-cached.

Non-cacheable routes (`/api/*`, `/auth/*`, `/account*`, `/search`) are excluded from the cacheable branch in the SSR Worker entry — they emit `Cache-Control: private, no-store` and never reach the tag/TTL machinery. See `STAGE_1_SPEC.md` §9.1 and [AECI-35](https://linear.app/aec-integrations/issue/AECI-35) for the route classifier.

---

## 5. Invalidation mechanism

A `POST /admin/purge` endpoint on the SSR Worker:

- Authenticates via a long-lived admin token (Wrangler secret named `ADMIN_PURGE_TOKEN`)
- Body: `{ tags: string[] }`
- Calls Cloudflare's purge-by-tag API for the zone
- Batches and respects Pro plan rate limits (token bucket per account)
- Logs to Datadog

Auth: Wrangler secret in Phase 2. **Migrate to Cloudflare Access in Phase 6** when admin tooling expands and there are multiple admin endpoints behind the same auth boundary.

Callers in Phase 2:

- Manual incident response (curl)
- Future admin tooling (Phase 6) — direct call from admin Workers, not n8n

Phase 2 ships the endpoint plus a working manual purge. Automated callers (e.g. Supabase webhook on row update) are Phase 4+.

Implementation lives in [AECI-56](https://linear.app/aec-integrations/issue/AECI-56) (Phase 2.10) — endpoint shape, rate-limit handling, and Datadog wiring belong there, not in this doc.

**Cloudflare API token scoping:** the token used by the purge endpoint must be scoped to `Zone.Cache Purge` on `aecintegrations.com` only — the narrowest possible scope. Reviewers should reject any change that broadens this token scope under deadline pressure; rotate by issuing a new token with the same minimal scope.

---

## 6. Cookie / cache hygiene

The Phase 2 Spec defers most of this to AECI-35 / AECI-41 ("inherits, no new work"). The full operative rules — still load-bearing for every Phase 2+ surface — are restated here so callers don't have to chase them through `STAGE_1_SPEC.md`:

### 6.1 Visitor-state-neutral HTML

Edge cache is keyed by URL. If SSR reads a request cookie (e.g. `theme=dark`) and bakes it into the rendered HTML, the first visitor primes the cache for everyone — a dark-mode visitor's render is served to a light-mode visitor, and vice versa.

**Rule:** for any cacheable route, the Worker strips visitor-state cookies (`theme`, future analytics cookies, etc.) before forwarding the request to the Angular SSR handler. The client reconciles state post-hydration from `localStorage` + `matchMedia` and repaints. Server-rendered HTML is neutral by design.

This is *not* solvable with `Vary: Cookie` — see §7 below for which `Vary` values are permitted and which still fragment the cache. The cookie-stripping middleware lives at `apps/web/src/server.ts` (shipped in [AECI-35](https://linear.app/aec-integrations/issue/AECI-35); theme service test coverage added in [AECI-41](https://linear.app/aec-integrations/issue/AECI-41)). Cross-reference: `STAGE_1_SPEC.md` §9.1a.

### 6.2 Pinned-404 trap

If a Worker returns HTTP 200 with a "not found" body and a normal TTL for a missing entity, the edge caches that body for the full TTL. When the entity is subsequently created, visitors continue to see the stale "not found" page until TTL expiry or manual purge.

**Rule:** 404 / not-found responses must return **HTTP 404** with a short TTL (≤ 60s — see §4). Status code 404 lets downstream tooling (sitemaps, monitoring) distinguish real misses, and the short TTL means newly-created entities become visible quickly without a purge call.

Cross-reference: `STAGE_1_SPEC.md` §9.1b. `apps/stack-test/` documents the trap as a deliberate Phase 1 gap in `apps/stack-test/README.md:192-194`; production `apps/web/` implements the correct behavior from the start.

---

## 7. SEO header set

In addition to `Cache-Control` and `Cache-Tag`, every cacheable response carries:

- `Vary: Accept-Language` — URL-prefix locale dispatch handles the actual variance (Phase 1 only emits `en-US`, but the routing layer is locale-aware), so this header just advertises the dimension to well-behaved proxies. Cloudflare's edge cache key isn't affected on Pro.
- `Link: </sitemap.xml>; rel=sitemap`
- `Content-Security-Policy` — unchanged from Phase 1; no Phase 2 changes.

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
