/**
 * The taxonomy browse grid's listing REQUEST shape (AECI-746).
 *
 * A factory rather than a constant because the request is scoped to the page's
 * term: the page locks its own dimension (`{kind}_slug=<slug>`) and drops that
 * dimension's `{kind}_id` from the cross-filter passthroughs. Both callers build it
 * from here so the SSR prefetch and the client request are the same string:
 *
 *   - `taxonomy-browse.resolver.ts` calls it with the route's slug, BEFORE the term
 *     has been fetched, so the two fetches run in parallel (AECI-1508). Locking by
 *     `term.id` instead is what made them serial.
 *   - `taxonomy-browse.ts` calls it with `term.slug`, which is the route slug (the
 *     term API matches slugs exactly), so the grid refetches when a cross-filter
 *     changes and its first request line equals the prefetched one.
 *
 * Pure data — no `inject()`, no `$localize`. See `products-index.config.ts` for
 * why that matters (the eager route graph reaches this file).
 */
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import {
  PRODUCT_DEFAULT_SORT,
  PRODUCT_VALID_SORTS,
} from '../shared/listing-toolbar/product-sort-keys';
import type { PaginatedIndexRequestConfig } from '../shared/paginated-index/paginated-index-request';

/** Cross-filter params that ride the URL, minus the page's own locked dimension. */
const CROSS_FILTERS = ['category_id', 'audience_id', 'phase_id', 'trade_id'] as const;

export function taxonomyBrowseIndexRequest(
  kind: () => TaxonomyKind,
  termSlug: () => string | undefined,
): PaginatedIndexRequestConfig {
  return {
    apiPath: '/api/products',
    // The FULL product sort set, shared with `/products` so the two catalog
    // surfaces cannot offer different options (AECI-657). Before that, this page
    // accepted only three keys and rendered no control, so `rating`/`reviews`
    // were unreachable here even by hand-typed URL — and STAGE_1_SPEC.md §4.5's
    // "sort options (alphabetical, most integrations, most reviewed)" was unmet.
    validSorts: PRODUCT_VALID_SORTS,
    defaultSort: PRODUCT_DEFAULT_SORT,
    baseParams: () => ({ [`${kind()}_slug`]: termSlug() }),
    // Evaluated ONCE, matching the behaviour this replaced: `passthroughParams`
    // is a plain array in `PaginatedIndexRequestConfig`, not a function, and the
    // component builds its controller once per route activation. Do not make this
    // a getter — the object is spread at the call site, which would freeze it at
    // spread time anyway and read `kind()` before the term resolves.
    passthroughParams: CROSS_FILTERS.filter((param) => param !== `${kind()}_id`),
  };
}
