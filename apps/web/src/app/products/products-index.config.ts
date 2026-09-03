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
  // Shared with the toolbar's own option list (AECI-657), NOT re-listed here: a
  // literal set would let the control offer a key the controller rejects. Imported
  // from `product-sort-keys` rather than `product-sort-options` because that
  // sibling calls `$localize` and this file is in the eager graph — see above.
  validSorts: PRODUCT_VALID_SORTS,
  defaultSort: PRODUCT_DEFAULT_SORT,
  // AECI-143 / AECI-544 — taxonomy cross-filters set by the facet sidebar ride
  // the URL. Must stay in step with `DIMENSIONS` in `facet-sidebar.ts` and
  // `LISTING_CACHE_KEY_PARAMS` in `server-runtime.ts`.
  passthroughParams: ['category_id', 'audience_id', 'phase_id', 'trade_id'],
};
