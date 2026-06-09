/**
 * Derive the edge-cache `Cache-Tag`s a promote should invalidate (AECI-105).
 *
 * `POST /api/promote` mutates cacheable product / vendor / taxonomy pages; after
 * the transaction commits, the handler purges these tags by calling Cloudflare's
 * purge-by-tag API directly (Option B — no web↔api binding). The strings here
 * MUST match the vocabulary the SSR Worker
 * emits in `apps/web/src/server/cache-tags.ts` (`buildCacheTags`) — the single
 * source of truth is `docs/CACHE_STRATEGY.md` §2. Keep the two in lockstep: a tag
 * we purge that SSR never emits is a silent no-op; a tag SSR emits that we never
 * purge is silent staleness.
 *
 * Composition rules (`docs/CACHE_STRATEGY.md` §3):
 *   - Entity tags (`product:{slug}`, `vendor:{slug}`, `category|audience|phase:
 *     {slug}`) invalidate that entity's detail / browse pages.
 *   - `index:products` / `index:vendors` invalidate the listing pages.
 *   - `taxonomy` invalidates every page whose HTML renders the full taxonomy
 *     term set (home, `/categories`, `/audiences`, `/phases`) — only relevant
 *     when the *set* of taxonomy terms changed, i.e. a term was newly created.
 *   - `sitemap` invalidates `sitemap.xml` (enumerates all entities) — only when a
 *     product or vendor was newly created.
 *   - **No `route:*` tags.** §3.3 reserves the coarse `route:detail|index|browse`
 *     tags for incident bulk-invalidation and explicitly forbids them on routine
 *     writes (they would nuke every detail/index/browse page site-wide).
 *
 * Known bounded gaps (out of scope here — see the handler doc-comment and
 * `docs/REVIEW_APP_PROMOTE_API.md`):
 *   - Embedded reverse-tagging is Phase 4 and not wired yet, so e.g. a vendor edit
 *     doesn't purge product pages that embed the vendor. Falls back to the TTL.
 *   - Integration seeding is disabled under AECI-86; when it is re-enabled in
 *     `promote.ts`, this deriver must also emit `integration:{id}` and re-purge
 *     the affected source/target `product:{slug}` (tie it to the `affectedProducts`
 *     set the commented integration block maintains).
 */

import type { PromoteResponse } from '@aeci/shared';

/**
 * Returns the deduplicated set of cache tags to purge for a promote `response`,
 * or an empty array when nothing cacheable changed (e.g. an all-skipped push).
 * Pure — depends only on the response object the `$transaction` returned.
 */
export function cacheTagsForPromote(response: PromoteResponse): string[] {
  const tags = new Set<string>();

  // Product detail + products index.
  if (response.product) {
    tags.add(`product:${response.product.slug}`);
    tags.add('index:products');
    if (response.product.operation === 'created') tags.add('sitemap');
  }

  // Vendor details + vendors index.
  if (response.vendors.length > 0) {
    tags.add('index:vendors');
    for (const vendor of response.vendors) {
      tags.add(`vendor:${vendor.slug}`);
      if (vendor.operation === 'created') tags.add('sitemap');
    }
  }

  // Taxonomy browse pages: one tag per touched term (created *and* reused — the
  // product's facet membership changed either way, so its browse pages repaint).
  const taxonomy: ReadonlyArray<
    ['category' | 'audience' | 'phase', typeof response.taxonomy.categories]
  > = [
    ['category', response.taxonomy.categories],
    ['audience', response.taxonomy.audiences],
    ['phase', response.taxonomy.phases],
  ];
  let taxonomyCreated = false;
  for (const [prefix, results] of taxonomy) {
    for (const result of results) {
      tags.add(`${prefix}:${result.slug}`);
      if (result.operation === 'created') taxonomyCreated = true;
    }
  }
  // Global taxonomy nav (home / `/categories` / footer) only changes when a new
  // term was minted — a reused term is already in the nav.
  if (taxonomyCreated) tags.add('taxonomy');

  return [...tags];
}
