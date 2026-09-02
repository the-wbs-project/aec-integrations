/**
 * The `/products` listing REQUEST shape (AECI-746).
 *
 * Separate from `products-index.ts` on purpose. `app.routes.ts` is eager, and it
 * imports the prefetch resolver, which imports this — so anything reachable from
 * here lands in the initial bundle. Importing it from the component module instead
 * dragged the whole lazy `ProductsIndex` into the eager graph and broke the 1 MB
 * budget by ~100 kB, and the component's `meta` block calls `canonicalUrl()`,
 * which runs `inject()` and fails route extraction with NG0203 at module scope.
 *
 * So this file holds only plain data. The component spreads it and adds the
 * `meta` / presentation half; the resolver takes it as-is. One definition of the
 * request means the prefetched request line and the requested one cannot diverge.
 */
import {
  PRODUCT_DEFAULT_SORT,
  PRODUCT_VALID_SORTS,
} from '../shared/listing-toolbar/product-sort-keys';
import type { PaginatedIndexRequestConfig } from '../shared/paginated-index/paginated-index-request';

export const PRODUCTS_INDEX_REQUEST: PaginatedIndexRequestConfig = {
  apiPath: '/api/products',
  // The one product sort set (AECI-657), shared with the toolbar options so a key
  // can never be offered in the UI without the controller accepting it. Inlining
  // the literal here is how `integrations` — and, on the taxonomy pages,
  // `rating`/`reviews` — silently stopped being reachable.
  validSorts: PRODUCT_VALID_SORTS,
  defaultSort: PRODUCT_DEFAULT_SORT,
  // AECI-143 / AECI-544 — taxonomy cross-filters set by the facet sidebar ride
  // the URL. Must stay in step with `DIMENSIONS` in `facet-sidebar.ts` and
  // `LISTING_CACHE_KEY_PARAMS` in `server-runtime.ts`.
  passthroughParams: ['category_id', 'audience_id', 'phase_id', 'trade_id'],
};
