/**
 * Resolver for `/vendors/:slug`. Phase 2 Spec §3.1 / §7 / §9 / §10.
 *
 * The hydration / 404 / null-ctx SSR scaffold lives in `createDetailResolver`
 * (`../core/create-detail-resolver`). This file supplies only the vendor
 * specifics: the fetch fn, `applyMeta` (head tags + JSON-LD, runs on SSR and
 * on client navigations), and `pushEmbedded` (server-only Cache-Tag entities).
 *
 * The title and meta description are composed from the vendor's own catalog
 * footprint (§9.1, AECI-802) — see `vendorMetaName` / `vendorMetaDescription`.
 *
 * On success → set page meta + JSON-LD; push embedded cache tags
 * (`product:{slug}` for each product shown on the vendor page) onto
 * `ctx.embedded` so `Cache-Tag` covers data-derived dependencies.
 */
import type { VendorDetail } from '@aeci/shared';

import { fetchVendorBySlug } from '../core/api/vendors';
import { createDetailResolver } from '../core/create-detail-resolver';
import { metaTrustLine } from '../core/meta-copy';
import { composeEntityDescription, vendorProductNames } from '../core/meta.helpers';

/**
 * Exported for `/preview/vendor-detail`, which sets its own head from a fixture
 * instead of going through this resolver. `apps/web/e2e/meta.spec.ts` is the only
 * end-to-end coverage of entity metadata and it runs against that preview, so a
 * second copy of this composer there would let the e2e pass over a preview that
 * no longer matches the real page.
 *
 * `<title>` name for a vendor page: `"{name} products and integrations"`, which
 * `MetaService` suffixes into `"{name} products and integrations · AEC
 * Integrations"` (Phase 2 Spec §9.1, AECI-802).
 *
 * No separator before "products". AECI-802's issue text proposed an em dash;
 * U+2014 in a shipped `apps/web` string literal is an ESLint error
 * (`NO_EM_DASH_IN_COPY`) and the brand voice bars it outright (`PRODUCT.md`).
 * The modifier exists because a title carrying only the company name competes
 * with that company's own domain for its own brand query, which a directory
 * loses by definition.
 */
export function vendorMetaName(vendor: VendorDetail): string {
  const name = vendor.company_name;
  return $localize`:@@vendors.detail.meta.title:${name}:name: products and integrations`;
}

/**
 * `<meta name="description">` for a vendor page — the §9.1 ladder (AECI-802):
 * a sentence composed from the vendor's catalog footprint, else the vendor's own
 * blurb, else `MetaService`'s `@@meta.defaultDescription` (reached by returning
 * `null`).
 *
 * **The count is `product_count`, never `integration_count`.** A vendor's
 * `integration_count` counts integrations that vendor BUILT
 * (`built_by_vendor_id`, `drizzle-helpers.ts`), not integrations across its
 * products, and it is zero for almost every vendor. Quoting it in a snippet
 * would state something the number does not mean.
 *
 * `Organization.description` in the JSON-LD is deliberately NOT varied
 * (`buildVendorJsonLd` reads `vendor.description` directly), matching the
 * product side's §13.6 rule: structured data states a factual entity property,
 * this is a SERP snippet.
 */
export function vendorMetaDescription(vendor: VendorDetail): string | null {
  const count = vendor.product_count;
  if (count > 0) {
    const name = vendor.company_name;
    // Null when the embedded product list is empty despite a non-zero count —
    // falling through to the blurb then beats naming nothing.
    const composed = composeEntityDescription({
      // Capped at the count so the singular branch cannot name two products.
      names: vendorProductNames(vendor).slice(0, count),
      trustLine: metaTrustLine(),
      render: (list) =>
        count === 1
          ? $localize`:@@vendors.detail.meta.description.one:${name}:name: publishes 1 product in the AEC directory: ${list}:list:.`
          : $localize`:@@vendors.detail.meta.description.other:${name}:name: publishes ${count}:count: products in the AEC directory, including ${list}:list:.`,
    });
    if (composed) return composed;
  }

  return vendor.description;
}

export const vendorDetailResolver = createDetailResolver<VendorDetail>({
  statePrefix: 'aeci.vendor-detail:',
  paramName: 'slug',
  pathSegment: 'vendors',
  entityKind: 'vendor',
  fetch: fetchVendorBySlug,
  applyMeta: (meta, vendor, canonical) => {
    meta.setEntityMeta({
      entity: 'vendor',
      name: vendorMetaName(vendor),
      description: vendorMetaDescription(vendor),
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
