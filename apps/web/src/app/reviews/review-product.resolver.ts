/**
 * Resolver for `/products/:slug/review` (AECI-200 / Phase 5.9).
 *
 * The review form needs the product's `id` (the POST body), `name`, and `slug`
 * (copy + back link), plus the standard NOT_FOUND → 404 shell. It reuses the
 * shared detail-resolver scaffold (TransferState hydration + the browser-side
 * `/api/*` fetch on a client navigation) but DELIBERATELY omits the
 * product-detail side effects:
 *   - no `applyMeta` — the form owns its own `<title>` + `robots: noindex`
 *     (mirroring the request forms), so the review page must NOT emit the
 *     product's canonical link or Product JSON-LD;
 *   - no `pushEmbedded` — the route is non-cacheable (no `ROUTE_CACHE_PATTERNS`
 *     match), so there is no `Cache-Tag` to contribute;
 *   - `trackPageView: false` — THE load-bearing opt-out. `/products/:slug/review`
 *     is not the product's canonical page, so an SSR landing here (a direct hit
 *     or the post-login `?return=` bounce-back) must not fire a
 *     `POST /api/page-views` for the product. Reusing the full
 *     `productDetailResolver` would miscount review-form visits as product
 *     detail views and skew the trending signal (AECI-177/179).
 */
import type { ProductDetail } from '@aeci/shared';

import { fetchProductBySlug } from '../core/api/products';
import { createDetailResolver } from '../core/create-detail-resolver';

export const reviewProductResolver = createDetailResolver<ProductDetail>({
  statePrefix: 'aeci.review-product:',
  paramName: 'slug',
  pathSegment: 'products',
  entityKind: 'product',
  fetch: fetchProductBySlug,
  trackPageView: false,
});
