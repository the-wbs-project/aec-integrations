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
 *
 * ── AECI-303: THE VERSION SELECTORS (§9) ────────────────────────────────────
 * `?context_version=` / `?other_version=` are forwarded to the API, which resolves
 * them and answers with `version_diff`. Three things about that are load-bearing:
 *
 *   1. **`noindex` follows the RESPONSE, not the request.** A stale or garbage label
 *      degrades to latest server-side, so the page *serves* canonical content and
 *      marking it `noindex` would describe a page nobody is being shown; the
 *      already-query-stripped canonical dedupes the URL. Reading it off the payload
 *      also keeps `applyResolvedMeta` a pure function of `pair`, which both branches
 *      call with nothing else — so SSR/client divergence is structurally impossible
 *      rather than test-enforced (stronger than the `taxonomy-browse.resolver.ts`
 *      precedent, which has to keep `kind` in scope).
 *   2. **The API must never 404 on an unknown version label.** The pair exists; a
 *      404 would render the NotFound shell for a valid page.
 *   3. **The route needs `runGuardsAndResolvers`** (see `app.routes.ts`).
 *      Angular's default `paramsChange` explicitly excludes query params, so
 *      without it a selector change would rewrite the URL and refetch nothing.
 *
 * ── THE TRANSFERSTATE KEY CARRIES EVERY AXIS THE PAYLOAD DEPENDS ON ─────────
 * It keys on `contextSlug|otherSlug` **in URL order** plus the selection. The
 * previous key used `orderedPairSlugs` (`{min}__{max}`) and described the shared
 * slot as a feature — but the payload is orientation-**dependent**
 * (`context_product`/`other_product`, the context-relative `direction`,
 * `attestor: 'context'|'other'`), only ONE of a pair's two URLs is SSR'd per
 * document, and `TransferState.get()` never deletes. So the shared slot could only
 * ever produce a FALSE hit: SSR `/products/revit/integrations/procore`, click
 * through to `/products/procore`, then into `/products/procore/integrations/revit`
 * — path params changed, the resolver re-ran, `hasKey` was still true, and the page
 * rendered the two products swapped relative to its URL. Every other resolver key
 * in the repo already carries every axis its payload depends on; this one was the
 * outlier. Orientation-independence still belongs on the canonical, and stays there.
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
import {
  canViewVersionDiff,
  CONTEXT_VERSION_PARAM,
  OTHER_VERSION_PARAM,
} from '@aeci/shared/version-diff';

import type { AeciRequestContext } from '../../server/request-context';
import {
  fetchProductPair,
  pairPath,
  type PairVersionSelectionParams,
} from '../core/api/product-pairs';
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

  // ── The §9 version selection ─────────────────────────────────────────────
  // The seam decides whether to ASK for a historical pair at all. This is one of
  // its exactly two consult sites (the other is `resolveDiffAccess` on the API),
  // and it is not ceremony: the API must gate independently because the same-origin
  // `/api/*` passthrough is directly hittable, while this resolver is the only place
  // that knows the render is going into a URL-keyed, publicly shared, 900s cache
  // entry. Declining here means the gated reader gets the free default view off the
  // default cache key, with no round trip spent on content that would be withheld.
  const requestedContext = route.queryParamMap.get(CONTEXT_VERSION_PARAM);
  const requestedOther = route.queryParamMap.get(OTHER_VERSION_PARAM);
  const historical = Boolean(requestedContext ?? requestedOther);
  const mayViewHistory = canViewVersionDiff({ historical, viewerTier: null }) === 'full';
  const selection: PairVersionSelectionParams | undefined =
    historical && mayViewHistory
      ? { contextVersion: requestedContext, otherVersion: requestedOther }
      : undefined;

  // The key carries every axis the payload depends on — slugs in URL order plus the
  // selection. See the module header for the orientation bug the old
  // `orderedPairSlugs` key produced.
  const selectionKey = `${selection?.contextVersion ?? ''}|${selection?.otherVersion ?? ''}`;
  const stateKey = makeStateKey<ProductPairResponse | null>(
    `aeci.product-pair:${contextSlug}|${otherSlug}|${selectionKey}`,
  );
  // The canonical stays orientation-independent: both URLs of a pair canonicalise to
  // the alphabetically-first one, and `MetaService` strips the query besides — so a
  // version selection never reaches it.
  const [minSlug, maxSlug] = orderedPairSlugs(contextSlug, otherSlug);
  const canonical = canonicalUrl(`/products/${minSlug}/integrations/${maxSlug}`);

  const applyResolvedMeta = (pair: ProductPairResponse): void => {
    meta.setEntityMeta({
      entity: 'integration',
      name: pairMetaName(pair),
      description: pairMetaDescription(pair),
      canonical,
      // Pairs have no own logo; OG falls back to the site default.
      ogImage: undefined,
      // Two independent reasons not to index, OR'd:
      //   - no integrations between the two products → renders, but thin content;
      //   - a non-default version selection (§9.2) → every (vA × vB) combination
      //     would otherwise be an indexable near-duplicate.
      // `?.` + `=== false` is deliberate: the web never Zod-parses this response
      // (`core/api/fetch-or-null.ts` is types-only), so `version_diff` can be
      // genuinely `undefined` at runtime against an API Worker that predates it —
      // and `undefined?.is_default === false` is `false`, i.e. indexable, which is
      // the correct degradation.
      noindex: pair.mechanisms.length === 0 || pair.version_diff?.is_default === false,
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
          pairPath(contextSlug, otherSlug, selection),
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

  const pair = await fetchProductPair(ctx.api, contextSlug, otherSlug, selection);
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
