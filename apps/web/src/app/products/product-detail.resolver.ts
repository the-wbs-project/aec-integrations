/**
 * Resolver for `/products/:slug`. Phase 2 Spec §3.1 / §7 / §9 / §10.
 *
 * The hydration / 404 / null-ctx SSR scaffold lives in `createDetailResolver`
 * (`../core/create-detail-resolver`). This file supplies only the product
 * specifics: the fetch fn, `applyMeta` (head tags + JSON-LD, runs on SSR and
 * on client navigations), and `pushEmbedded` (server-only Cache-Tag entities).
 *
 * The meta description is role-varied (§13.6) — see `productMetaDescription`.
 *
 * On success → set page meta + JSON-LD; push embedded cache tags
 * (`vendor:{slug}` + `integration:{id}` + `product:{slug}` for each shown
 * integration's partner product) onto `ctx.embedded` so `Cache-Tag` covers
 * data-derived dependencies.
 */
import type { ProductDetail } from '@aeci/shared';

import { fetchProductBySlug } from '../core/api/products';
import { createDetailResolver } from '../core/create-detail-resolver';

import { connectedProductCount } from './powered-hub-grouping';

/**
 * `<meta name="description">` for a product page, role-varied per Stage 1.5
 * Addendum C §13.6 (AECI-707).
 *
 * Every role except `connector` keeps the Phase 2 §9.1 default: the entity's own
 * description, truncated to ~155 chars by `MetaService`. A connector page
 * instead targets *"«connector» for construction"*-class queries, which its
 * vendor-written description almost never does. **Pair-shaped queries stay on
 * pair pages** (Addendum A §11.2) so the two addenda never compete for one SERP
 * with two different pages.
 *
 * Gated on `N > 0` as well as the role: with nothing to count the variant would
 * assert less than the real description does, so it falls back. `N` is
 * `connectedProductCount`'s catalog-reach figure, the same number the hero line
 * renders, so the snippet and the page agree.
 *
 * `SoftwareApplication.description` in the JSON-LD is deliberately NOT varied
 * (`buildProductJsonLd` reads `product.description` directly): the structured
 * data states a factual entity property, while this is a SERP snippet.
 */
function productMetaDescription(product: ProductDetail): string | null {
  if (product.product_role !== 'connector') return product.description;
  const count = connectedProductCount(product.integrations_as_connector, product.slug);
  if (count === 0) return product.description;
  const name = product.name;
  return $localize`:@@products.detail.meta.connector:${name}:name: connects ${count}:count: construction and AEC products. See the integrations it powers and reviews from the teams using them.`;
}

export const productDetailResolver = createDetailResolver<ProductDetail>({
  statePrefix: 'aeci.product-detail:',
  paramName: 'slug',
  pathSegment: 'products',
  entityKind: 'product',
  fetch: fetchProductBySlug,
  applyMeta: (meta, product, canonical) => {
    meta.setEntityMeta({
      entity: 'product',
      name: product.name,
      description: productMetaDescription(product),
      canonical,
      ogImage: product.logo_url ?? undefined,
    });
    // `canonical` gives the node a stable `@id` (AECI-518) — the URI the pair
    // page's `about[]` entries reference so the two describe ONE product.
    meta.setProductJsonLd(product, canonical);
  },
  pushEmbedded: (ctx, product) => {
    // Embedded cache-tag entities — vendor, every integration shown, and
    // each partner product rendered in the integrations list. Per
    // CACHE_STRATEGY.md §3: "any entity rendered in the response — even
    // transitively — contributes a tag." Partner product names / slugs appear
    // as links in the integrations section, so their product:{slug} tags are
    // required for purge correctness when those products are updated.
    // `buildCacheTags` deduplicates; pushing the same slug twice is harmless.
    // `vendor` is nullable (AECI-115) — only tag it when the product has one.
    if (product.vendor) ctx.embedded.push({ type: 'vendor', slug: product.vendor.slug });
    for (const i of product.integrations_as_source) {
      ctx.embedded.push({ type: 'integration', id: i.id });
      ctx.embedded.push({ type: 'product', slug: i.target.slug });
    }
    for (const i of product.integrations_as_target) {
      ctx.embedded.push({ type: 'integration', id: i.id });
      ctx.embedded.push({ type: 'product', slug: i.source.slug });
    }
    // Powered edges (Stage 1.5 Addendum B): this product is the connector, so
    // BOTH endpoints are rendered — the hub heading links one and the chip links
    // the other — and each contributes a tag under the same §3 rule.
    for (const i of product.integrations_as_connector) {
      ctx.embedded.push({ type: 'integration', id: i.id });
      ctx.embedded.push({ type: 'product', slug: i.source.slug });
      ctx.embedded.push({ type: 'product', slug: i.target.slug });
    }
  },
});
