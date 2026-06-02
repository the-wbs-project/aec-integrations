/**
 * Resolver for `/products/:slug`. Phase 2 Spec §3.1 / §7 / §9 / §10.
 *
 * Server flow (RenderMode.Server, the only mode this route uses):
 *   1. Fetch `GET /api/products/:slug` via the service binding (no public
 *      surface) using the `AeciRequestContext.api` client.
 *   2. On `NOT_FOUND` envelope → set `RESPONSE_INIT.status = 404` so the SSR
 *      runtime emits a real HTTP 404 + `NOT_FOUND_TTL`; set noindex meta;
 *      return `null` so the route component renders the inline NotFound
 *      panel (AECI-62 replaces the panel with the global 404 shell).
 *   3. On success → set page meta + JSON-LD; push embedded cache tags
 *      (`vendor:{slug}` + `integration:{id}` + `product:{slug}` for each
 *      shown integration's partner product) onto
 *      `ctx.embedded` so `Cache-Tag` covers data-derived dependencies; queue
 *      the fire-and-forget `POST /api/page-views` payload. Store the result
 *      in `TransferState` so client-hydration skips the fetch.
 *
 * Client flow (hydration): read the `ProductDetail` (or `null`) out of
 * `TransferState`. No fetch, no meta side-effects — the SSR-rendered HTML
 * already carries them.
 */
import { isPlatformServer } from '@angular/common';
import {
  PLATFORM_ID,
  REQUEST,
  REQUEST_CONTEXT,
  RESPONSE_INIT,
  TransferState,
  inject,
  makeStateKey,
} from '@angular/core';
import { ResolveFn } from '@angular/router';

import type { ProductDetail } from '@aeci/shared';

import type { AeciRequestContext } from '../../server/request-context';
import { fetchProductBySlug } from '../core/api/products';
import { MetaService } from '../core/meta.service';

const PRODUCT_DETAIL_STATE_PREFIX = 'aeci.product-detail:';

/**
 * Per-slug TransferState key. Slug is included so a future cross-route
 * prefetch (e.g. hover-prefetch on a product card) can't collide with the
 * active page's data.
 */
function productStateKey(slug: string) {
  return makeStateKey<ProductDetail | null>(`${PRODUCT_DETAIL_STATE_PREFIX}${slug}`);
}

export const productDetailResolver: ResolveFn<ProductDetail | null> = async (route) => {
  const slug = route.paramMap.get('slug') ?? '';
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const stateKey = productStateKey(slug);

  // Client hydration path. SSR populated TransferState; just read it back.
  // Defensive `null` default: if a future navigation lands a path the SSR
  // didn't render (e.g. client-side routing to a new slug), we return null
  // and let the component render the inline NotFound panel — preferable to
  // a runtime crash.
  if (!isPlatformServer(platformId)) {
    return transferState.get(stateKey, null);
  }

  // Server path.
  const meta = inject(MetaService);
  const request = inject(REQUEST, { optional: true });
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });
  const origin = request ? new URL(request.url).origin : 'https://aecintegrations.com';
  const canonical = `${origin}/products/${slug}`;

  // `REQUEST_CONTEXT` is only provided by `@angular/ssr` when the route uses
  // `RenderMode.Server` (see `@angular/ssr@21.2.10` `ssr.mjs:1268`). The
  // products route is registered with `RenderMode.Server` in
  // `app.routes.server.ts`, so this branch should never hit in production —
  // bail gracefully if it does (prerender / future render-mode changes).
  if (!ctx) {
    transferState.set(stateKey, null);
    return null;
  }

  const product = await fetchProductBySlug(ctx.api, slug);
  transferState.set(stateKey, product);

  if (!product) {
    if (responseInit) responseInit.status = 404;
    meta.setNotFoundMeta({ kind: 'product', slug, canonical });
    return null;
  }

  meta.setEntityMeta({
    entity: 'product',
    name: product.name,
    description: product.description,
    canonical,
    ogImage: product.logo_url ?? undefined,
  });
  meta.setProductJsonLd(product);

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

  ctx.pageView = {
    route: '/products/:slug',
    entity_type: 'product',
    entity_id: product.id,
  };

  return product;
};
