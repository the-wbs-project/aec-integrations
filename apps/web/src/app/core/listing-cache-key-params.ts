/**
 * The WC-4 cache-key allowlist for the five listing routes, as a dependency-free
 * module so both the SSR Worker (`server-runtime.ts`) and app code can import it.
 * See `docs/CACHE_STRATEGY.md` §4a.
 */

/**
 * AECI-143 / AECI-544 — the listing/browse routes (`/products` + the four
 * taxonomy browse pages) all read the same content-affecting query params:
 * pagination (`page`/`perPage`), `sort`, and the faceted-filter ids
 * (`category_id` / `audience_id` / `trade_id` / `phase_id`) the
 * `aec-facet-sidebar` writes to the URL. One shared allowlist keeps the five
 * routes in sync and forward-safe. Per
 * CACHE_STRATEGY.md §4a this MUST be a superset of every URL param each
 * component reads; over-including is explicitly harmless (e.g. a browse page
 * carries its own `{kind}_id` on the path, not the query, but listing it here
 * costs nothing), so the union is applied uniformly.
 *
 * AECI-190 / AECI-657 — `/products` and (since AECI-657) the four taxonomy
 * browse pages SSR-render a different layout for `?view=table` (the dense table)
 * vs. the card-grid default, so `view` is content-affecting on all five routes
 * and MUST be in the key or the two renders collapse onto one entry and serve
 * wrong HTML.
 *
 * AECI-979 — moved here from `server-runtime.ts` so app code can read it. The
 * taxonomy browse resolver's retired-slug 301 keeps exactly these params in its
 * `Location`: the edge key varies on them and nothing else, so a `Location` that
 * carried any other param (`utm_*`) would be served to every visitor of that key.
 * `server-runtime.ts` still owns the route table that applies it.
 */
export const LISTING_CACHE_KEY_PARAMS: readonly string[] = [
  'page',
  'perPage',
  'sort',
  'view',
  'category_id',
  'audience_id',
  'phase_id',
  // AECI-544 — the fourth facet. Under-including a content-affecting param is a
  // correctness bug (§4a), so this must stay in step with `DIMENSIONS` in
  // `facet-sidebar.ts` and the `passthroughParams` on both listing pages.
  'trade_id',
];
