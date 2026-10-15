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
 *
 * Any OTHER failure (a 5xx, a timeout, a network error) also resolves `null`, with no
 * 404 and no not-found meta. The name is decoration: before this resolver the form
 * needed no API read, so a failed read must not break SSR or cancel the client
 * navigation. The scaffold rethrows non-404 errors on both platforms (`fetchOrNull`
 * on the server, `httpGetOrNull` in the browser), so the guard wraps the whole
 * resolver rather than its `fetch` option, which the browser path never calls. On a
 * server failure nothing is stored in `TransferState`, so hydration retries the read
 * from the browser once.
 */
import type { ResolveFn } from '@angular/router';

import type { ProductDetail, VendorDetail } from '@aeci/shared';

import { fetchProductBySlug } from '../core/api/products';
import { fetchVendorBySlug } from '../core/api/vendors';
import { createDetailResolver } from '../core/create-detail-resolver';

/**
 * Resolve `null` instead of failing when the wrapped resolver throws. The wrapped
 * call runs synchronously inside this function, before its first `await`, so the
 * scaffold's `inject()` calls still see the router's injection context.
 */
function nullOnFailure<T>(resolver: ResolveFn<T | null>): ResolveFn<T | null> {
  return async (route, state) => {
    try {
      return await (resolver(route, state) as Promise<T | null>);
    } catch {
      return null;
    }
  };
}

export const claimProductResolver = nullOnFailure(
  createDetailResolver<ProductDetail>({
    statePrefix: 'aeci.claim-product:',
    paramName: 'slug',
    pathSegment: 'products',
    entityKind: 'product',
    fetch: fetchProductBySlug,
    trackPageView: false,
  }),
);

export const claimVendorResolver = nullOnFailure(
  createDetailResolver<VendorDetail>({
    statePrefix: 'aeci.claim-vendor:',
    paramName: 'slug',
    pathSegment: 'vendors',
    entityKind: 'vendor',
    fetch: fetchVendorBySlug,
    trackPageView: false,
  }),
);

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
