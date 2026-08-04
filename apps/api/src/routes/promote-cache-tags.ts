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
 *   - `index:products` invalidates the products listing page. (AECI-165 removed
 *     the `/vendors` and `/integrations` index pages, so `index:vendors` /
 *     `index:integrations` are no longer emitted or purged.)
 *   - `taxonomy` invalidates every page whose HTML renders the full taxonomy
 *     term set (home, `/categories`, `/audiences`, `/phases`) — only relevant
 *     when the *set* of taxonomy terms changed, i.e. a term was newly created.
 *   - `sitemap` invalidates `sitemap.xml` (enumerates all entities) — only when a
 *     product or vendor was newly created.
 *   - `pair:{min}__{max}` (Stage 1.5, §6.2) invalidates the consolidated
 *     product-pair page for an integration, keyed by its two product slugs sorted
 *     alphabetically (`promote-pair.ts`). Emitted per integration result that
 *     carries `sourceSlug`/`targetSlug` (the claims ingest, AECI-297); the pair page
 *     (AECI-294) emits the identical tag, so purge and render stay in lockstep.
 *   - `product:{poweredBySlug}` (Stage 1.5 Addendum B) invalidates the *connector*
 *     product's detail page for an integration it powers. The connector is neither
 *     endpoint, so no other rule reaches it, yet its "Integrations it powers"
 *     hub view renders that edge. Emitted per integration result that carries
 *     `poweredBySlug`.
 *   - **No `route:*` tags.** §3.3 reserves the coarse `route:detail|index|browse`
 *     tags for incident bulk-invalidation and explicitly forbids them on routine
 *     writes (they would nuke every detail/index/browse page site-wide).
 *   - **No `index:home` tag.** The home page IS purged on a promote, but NOT here:
 *     its counts come from the `stats_cache`, which the promote must refresh FIRST,
 *     so the home purge lives in `promote.ts`'s ordered refresh-then-purge task
 *     (AECI-305), not in this concurrently-fired set. Adding `index:home` here would
 *     let the purge race ahead of the refresh and re-cache stale HTML.
 *
 * Known bounded gaps (out of scope here — see the handler doc-comment and
 * `docs/REVIEW_APP_PROMOTE_API.md`):
 *   - Embedded reverse-tagging is Phase 4 and not wired yet, so e.g. a vendor edit
 *     doesn't purge product pages that embed the vendor. Falls back to the TTL.
 *   - Integration seeding is disabled under AECI-86; when it is re-enabled in
 *     `promote.ts`, this deriver must also emit `integration:{id}` and re-purge
 *     the affected source/target `product:{slug}` (tie it to the `affectedProducts`
 *     set the commented integration block maintains).
 *   - An integration whose powered-by product MOVES (re-pointed to a different
 *     connector, or cleared) only purges the NEW connector — the response carries
 *     the post-update `poweredBySlug`, not the pre-update one — so the previous
 *     connector's page falls back to the TTL. Same bounded shape as the endpoint
 *     move above; widen it here if connector re-pointing becomes common.
 */

import type { PromoteResponse } from '@aeci/shared';

import { pairCacheTag } from './promote-pair';

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

  // Vendor detail pages. (No `index:vendors` — the `/vendors` index page was
  // removed in AECI-165; it now 301-redirects to `/products`.)
  for (const vendor of response.vendors) {
    tags.add(`vendor:${vendor.slug}`);
    if (vendor.operation === 'created') tags.add('sitemap');
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

  // Pair pages (Stage 1.5, §6.2 / §7.3): a promote that touches an integration —
  // or the claims riding on it — invalidates the consolidated product-pair page.
  // Tag it by both product slugs (`pair:{min}__{max}`) so either orientation
  // repaints. The slugs come from the response's integration results (populated by
  // the claims ingest, AECI-297); older responses may omit them, so guard. The
  // pair page (AECI-294) emits the identical tag — keep them in lockstep.
  for (const integration of response.integrations) {
    if (integration.sourceSlug && integration.targetSlug) {
      tags.add(pairCacheTag(integration.sourceSlug, integration.targetSlug));
    }
    // The connector product that POWERS the edge renders it in its own
    // "Integrations it powers" hub view (Stage 1.5 Addendum B), so its detail
    // page must repaint too. Absent for edges with no powered-by product (and on
    // older responses) — guard.
    if (integration.poweredBySlug) tags.add(`product:${integration.poweredBySlug}`);
  }

  return [...tags];
}
