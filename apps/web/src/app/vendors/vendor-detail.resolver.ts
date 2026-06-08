/**
 * Resolver for `/vendors/:slug`. Phase 2 Spec §3.1 / §7 / §9 / §10.
 *
 * The hydration / 404 / null-ctx SSR scaffold lives in `createDetailResolver`
 * (`../core/create-detail-resolver`). This file supplies only the vendor
 * specifics: the fetch fn, `applyMeta` (head tags + JSON-LD, runs on SSR and
 * on client navigations), and `pushEmbedded` (server-only Cache-Tag entities).
 *
 * On success → set page meta + JSON-LD; push embedded cache tags
 * (`product:{slug}` for each product shown on the vendor page) onto
 * `ctx.embedded` so `Cache-Tag` covers data-derived dependencies.
 */
import type { VendorDetail } from '@aeci/shared';

import { fetchVendorBySlug } from '../core/api/vendors';
import { createDetailResolver } from '../core/create-detail-resolver';

export const vendorDetailResolver = createDetailResolver<VendorDetail>({
  statePrefix: 'aeci.vendor-detail:',
  paramName: 'slug',
  pathSegment: 'vendors',
  entityKind: 'vendor',
  fetch: fetchVendorBySlug,
  applyMeta: (meta, vendor, canonical) => {
    meta.setEntityMeta({
      entity: 'vendor',
      name: vendor.company_name,
      description: vendor.description,
      canonical,
      ogImage: vendor.logo_url ?? undefined,
    });
    meta.setVendorJsonLd(vendor);
  },
  pushEmbedded: (ctx, vendor) => {
    // Embedded cache-tag entities — every product rendered in the products
    // section. Per CACHE_STRATEGY.md §3: "any entity rendered in the response
    // — even transitively — contributes a tag." Product cards link to their
    // own detail pages, so their `product:{slug}` tags are required for purge
    // correctness when those products are updated. `buildCacheTags`
    // deduplicates; pushing the same slug twice is harmless.
    for (const product of vendor.products) {
      ctx.embedded.push({ type: 'product', slug: product.slug });
    }
  },
});
