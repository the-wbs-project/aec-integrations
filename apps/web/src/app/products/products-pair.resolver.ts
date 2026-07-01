/**
 * Resolver for the product-PAIR page `/products/:contextSlug/integrations/:otherSlug`
 * (Stage 1.5 §7 — AECI-294).
 *
 * The pair page is two-param with a *default-orientation* canonical, so it can't
 * use the single-param `createDetailResolver` scaffold — but it mirrors it: the
 * SSR branch fetches over the service binding and stores into `TransferState`;
 * the client branch reuses that (hydration / back-nav) or fetches via the
 * same-origin `/api/*` passthrough on a genuine in-app navigation; a `null`
 * (either slug unknown or the two equal) sets `RESPONSE_INIT.status = 404` on the
 * server and renders the NotFound shell.
 *
 * Two pair-specific rules (§7.3):
 *   - **Canonical is always the alphabetically-first orientation** — both URLs
 *     of a pair canonicalise to one indexable page.
 *   - **An empty pair (no integrations) is `noindex`** — it still renders (the
 *     API returns 200 `mechanisms: []`), but thin content isn't indexed.
 */
import { isPlatformServer } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  PLATFORM_ID,
  REQUEST_CONTEXT,
  RESPONSE_INIT,
  TransferState,
  inject,
  makeStateKey,
} from '@angular/core';
import { ResolveFn } from '@angular/router';

import { orderedPairSlugs, type ProductPairResponse } from '@aeci/shared';

import type { AeciRequestContext } from '../../server/request-context';
import { fetchProductPair } from '../core/api/product-pairs';
import { httpGetOrNull } from '../core/api/http-get-or-null';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';

/** `<title>` name — "{context} and {other} integrations". */
function pairMetaName(pair: ProductPairResponse): string {
  const context = pair.context_product.name;
  const other = pair.other_product.name;
  return $localize`:@@pair.meta.title:${context}:context: and ${other}:other: integrations`;
}

/** Meta description — honest one-liner about the pair. */
function pairMetaDescription(pair: ProductPairResponse): string {
  const context = pair.context_product.name;
  const other = pair.other_product.name;
  return $localize`:@@pair.meta.description:How ${context}:context: and ${other}:other: exchange data across their integrations.`;
}

export const productsPairResolver: ResolveFn<ProductPairResponse | null> = async (route) => {
  const contextSlug = route.paramMap.get('contextSlug') ?? '';
  const otherSlug = route.paramMap.get('otherSlug') ?? '';
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const meta = inject(MetaService);

  // Key + canonical are orientation-independent: both URLs of a pair share one
  // TransferState slot and canonicalise to the alphabetically-first orientation.
  const [minSlug, maxSlug] = orderedPairSlugs(contextSlug, otherSlug);
  const stateKey = makeStateKey<ProductPairResponse | null>(
    `aeci.product-pair:${minSlug}__${maxSlug}`,
  );
  const canonical = canonicalUrl(`/products/${minSlug}/integrations/${maxSlug}`);

  const applyResolvedMeta = (pair: ProductPairResponse): void => {
    meta.setEntityMeta({
      entity: 'integration',
      name: pairMetaName(pair),
      description: pairMetaDescription(pair),
      canonical,
      // Pairs have no own logo; OG falls back to the site default.
      ogImage: undefined,
      // No integrations between the two products → render, but don't index.
      noindex: pair.mechanisms.length === 0,
    });
    // No JSON-LD: §9.2 defers integration structured data to Stage 2.
  };

  const notFoundSlug = `${contextSlug}/${otherSlug}`;

  // ── Client path: in-app navigation or initial hydration. ──────────────────
  if (!isPlatformServer(platformId)) {
    const pair = transferState.hasKey(stateKey)
      ? transferState.get(stateKey, null)
      : await httpGetOrNull<ProductPairResponse>(
          inject(HttpClient),
          `/api/products/${encodeURIComponent(contextSlug)}/integrations/${encodeURIComponent(
            otherSlug,
          )}`,
        );

    if (pair) applyResolvedMeta(pair);
    else meta.setNotFoundMeta({ kind: 'integration', slug: notFoundSlug, canonical });
    return pair;
  }

  // ── Server path (RenderMode.Server). ──────────────────────────────────────
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });

  if (!ctx) {
    transferState.set(stateKey, null);
    return null;
  }

  const pair = await fetchProductPair(ctx.api, contextSlug, otherSlug);
  transferState.set(stateKey, pair);

  if (!pair) {
    if (responseInit) responseInit.status = 404;
    meta.setNotFoundMeta({ kind: 'integration', slug: notFoundSlug, canonical });
    return null;
  }

  applyResolvedMeta(pair);

  // Embedded cache tags: the two `product:` tags come from the path
  // (`cacheTagInputsForPath`); push only the data-derived per-mechanism vendor /
  // connector-product tags so a purge on those cascades here.
  for (const mechanism of pair.mechanisms) {
    if (mechanism.built_by_vendor) {
      ctx.embedded.push({ type: 'vendor', slug: mechanism.built_by_vendor.slug });
    }
    if (mechanism.powered_by_product) {
      ctx.embedded.push({ type: 'product', slug: mechanism.powered_by_product.slug });
    }
  }

  // Route-only page view — a pair has no single entity id, so we count the route
  // (both `entity_*` fields are optional). Fires on 2xx only (empty pairs still
  // count as a route view).
  ctx.pageView = { route: '/products/:contextSlug/integrations/:otherSlug' };

  return pair;
};
