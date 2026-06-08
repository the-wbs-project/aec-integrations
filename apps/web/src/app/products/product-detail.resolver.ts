/**
 * Resolver for `/products/:slug`. Phase 2 Spec §3.1 / §7 / §9 / §10.
 *
 * The hydration / 404 / null-ctx SSR scaffold lives in `createDetailResolver`
 * (`../core/create-detail-resolver`). This file supplies only the product
 * specifics: the fetch fn, `applyMeta` (head tags + JSON-LD, runs on SSR and
 * on client navigations), and `pushEmbedded` (server-only Cache-Tag entities).
 *
 * On success → set page meta + JSON-LD; push embedded cache tags
 * (`vendor:{slug}` + `integration:{id}` + `product:{slug}` for each shown
 * integration's partner product) onto `ctx.embedded` so `Cache-Tag` covers
 * data-derived dependencies.
 */
import type { ProductDetail } from '@aeci/shared';

import { fetchProductBySlug } from '../core/api/products';
import { createDetailResolver } from '../core/create-detail-resolver';

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
      description: product.description,
      canonical,
      ogImage: product.logo_url ?? undefined,
    });
    meta.setProductJsonLd(product);
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
  },
});
