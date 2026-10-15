/**
 * Resolvers for the routed claim pages `/products/:slug/claim` and
 * `/vendors/:slug/claim` (AECI-1364).
 *
 * A claim is on the company (`docs/VENDOR_SIGNUP_PROCESS.md` decision 1), so the page
 * is titled "Claim <Company>". The name comes from the reads the detail pages already
 * use: `GET /api/products/:slug` returns the product's `vendor` (the primary vendor,
 * else any linked vendor, the same pick `POST /api/requests/claim` records), and
 * `GET /api/vendors/:slug` returns the company itself. No new endpoint.
 *
 * Both reuse the detail-resolver scaffold (TransferState hydration, the browser
 * `/api/*` fetch on a client navigation) WITHOUT the detail-page side effects, the
 * `reviewProductResolver` precedent:
 *   - no `applyMeta`: the form owns its `<title>` and `robots: noindex`;
 *   - no `pushEmbedded`: the claim pages are `private, no-store` (no
 *     `ROUTE_CACHE_PATTERNS` match), so there is no `Cache-Tag` to contribute;
 *   - `trackPageView: false`: a claim page is not the entity's canonical page.
 *
 * A missing entity resolves `null` (and a real 404 on SSR). The form still renders,
 * titled "Claim your company", as it did before this resolver existed.
 */
import type { ProductDetail, VendorDetail } from '@aeci/shared';

import { fetchProductBySlug } from '../core/api/products';
import { fetchVendorBySlug } from '../core/api/vendors';
import { createDetailResolver } from '../core/create-detail-resolver';

export const claimProductResolver = createDetailResolver<ProductDetail>({
  statePrefix: 'aeci.claim-product:',
  paramName: 'slug',
  pathSegment: 'products',
  entityKind: 'product',
  fetch: fetchProductBySlug,
  trackPageView: false,
});

export const claimVendorResolver = createDetailResolver<VendorDetail>({
  statePrefix: 'aeci.claim-vendor:',
  paramName: 'slug',
  pathSegment: 'vendors',
  entityKind: 'vendor',
  fetch: fetchVendorBySlug,
  trackPageView: false,
});

/** The company a claim page names, and the product it came from (if any). */
export interface ClaimPageContext {
  /** "Claim <Company>". `null` when the entity or its vendor is unknown. */
  readonly company: string | null;
  /** "from the <Product> page". `null` on a company page. */
  readonly product: string | null;
}

/** Read the claim page's company and product off the resolved entity. */
export function claimPageContext(
  entity: 'product' | 'vendor',
  resolved: ProductDetail | VendorDetail | null | undefined,
): ClaimPageContext {
  if (!resolved) return { company: null, product: null };
  if (entity === 'vendor') {
    return { company: (resolved as VendorDetail).company_name, product: null };
  }
  const product = resolved as ProductDetail;
  return { company: product.vendor?.name ?? null, product: product.name };
}
