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
 *   - **JSON-LD rides the same `noindex` decision** (AECI-518, §9.2's deferral
 *     resolved): a `WebPage` naming both endpoints in `about` plus the visible
 *     breadcrumb trail, emitted only when the page is indexable.
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
 * ── AECI-304: THE PAYWALL IS ON THE PAIR'S VENDORS, NOT THE READER ──────────
 * Historical diff depth is open when either endpoint vendor holds
 * `'integration.version_diff'`, read off the `vendors.verified` mirror already on
 * `ProductListItem.vendor`. That keeps the gate a function of the two slugs in the
 * URL, so this page stays in the shared, URL-keyed edge cache — no cookie, no
 * session, no `Cache-Control: private`, no new cache-key axis. See
 * `gateHistoricalDepth` below, which is the seam's second and last consult site.
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

import {
  orderedPairSlugs,
  type ProductPairMechanism,
  type ProductPairResponse,
} from '@aeci/shared';
import {
  canViewVersionDiff,
  CONTEXT_VERSION_PARAM,
  OTHER_VERSION_PARAM,
  vendorTiersFromMirror,
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

/** A mechanism with every claim's `version_status` marker removed. */
function withoutVersionStatus(mechanism: ProductPairMechanism): ProductPairMechanism {
  return {
    ...mechanism,
    claims: mechanism.claims.map((claim) => {
      const stripped = { ...claim };
      delete stripped.version_status;
      return stripped;
    }),
  };
}

/**
 * The seam's second consult site (§9.3 / AECI-303 AC5) — and the only one that runs
 * inside the SSR render.
 *
 * **The gate is on the pair's two endpoint vendors, never the reader** (AECI-304).
 * `vendors.verified` is the mirror of an `active` entitlement row, it already rides
 * on `ProductListItem.vendor`, and it is a function of the two slugs in the URL — so
 * the answer is URL-derived and a gated pair page stays storable in the shared,
 * URL-keyed edge cache. No cookie is read, nothing is marked `private`, and no
 * cache-key axis is added.
 *
 * The consult moved AFTER the fetch because the resolver cannot know the pair's
 * vendors until the payload arrives — the API is the authority and clamps
 * server-side, so in the ordinary case this agrees with `diff_access` and changes
 * nothing.
 *
 * It is still not ceremony. The SSR and API Workers deploy per-commit but **not
 * atomically** (`diff_access` carries `.default('full')` for exactly that reason),
 * and this resolver is the only place that knows the render — HTML *and* its
 * `TransferState` block — is going into a URL-keyed, publicly shared, 900s cache
 * entry. Against an API Worker that predates this gate, stripping here is what keeps
 * gated depth out of that entry. It degrades to `version_diff: null`, which is the
 * payload's ONE documented suppression spelling and needs no new render branch: no
 * selectors, no markers, no summary — the free latest view, in full.
 */
export function gateHistoricalDepth(
  pair: ProductPairResponse,
  historical: boolean,
): ProductPairResponse {
  const access = canViewVersionDiff({
    historical,
    pairVendorTiers: vendorTiersFromMirror([
      pair.context_product.vendor,
      pair.other_product.vendor,
    ]),
  });
  // Entitled, or nothing to withhold. A falsy `version_diff` is already the free
  // shape — `null` from the API, or genuinely `undefined` against an API Worker that
  // predates AECI-303, since the web never Zod-parses this response. A `latest_only`
  // payload is one the API has already clamped, left intact so the enum survives for
  // whoever builds the locked-state affordance.
  if (access === 'full') return pair;
  if (!pair.version_diff || pair.version_diff.diff_access === 'latest_only') return pair;
  return {
    ...pair,
    version_diff: null,
    mechanisms: pair.mechanisms.map(withoutVersionStatus),
  };
}

export const productsPairResolver: ResolveFn<ProductPairResponse | null> = async (route) => {
  const contextSlug = route.paramMap.get('contextSlug') ?? '';
  const otherSlug = route.paramMap.get('otherSlug') ?? '';
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const meta = inject(MetaService);

  // ── The §9 version selection ─────────────────────────────────────────────
  // The requested selection is forwarded unconditionally and the API is the
  // authority: AECI-304 put the gate on the PAIR'S vendors, and this resolver does
  // not know who they are until the payload comes back. The seam's consult therefore
  // moved AFTER the fetch (see `gateHistoricalDepth`).
  const requestedContext = route.queryParamMap.get(CONTEXT_VERSION_PARAM);
  const requestedOther = route.queryParamMap.get(OTHER_VERSION_PARAM);
  const historical = Boolean(requestedContext ?? requestedOther);
  const selection: PairVersionSelectionParams | undefined = historical
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
    // Two independent reasons not to index, OR'd:
    //   - no integrations between the two products → renders, but thin content;
    //   - a non-default version selection (§9.2) → every (vA × vB) combination
    //     would otherwise be an indexable near-duplicate.
    // `?.` + `=== false` is deliberate: the web never Zod-parses this response
    // (`core/api/fetch-or-null.ts` is types-only), so `version_diff` can be
    // genuinely `undefined` at runtime against an API Worker that predates it —
    // and `undefined?.is_default === false` is `false`, i.e. indexable, which is
    // the correct degradation.
    const noindex = pair.mechanisms.length === 0 || pair.version_diff?.is_default === false;
    const name = pairMetaName(pair);
    const description = pairMetaDescription(pair);

    meta.setEntityMeta({
      entity: 'integration',
      name,
      description,
      canonical,
      // Pairs have no own logo; OG falls back to the site default.
      ogImage: undefined,
      noindex,
    });

    // AECI-518 — the Stage 2 resolution of §9.2's integration-JSON-LD deferral
    // (decision record: `STAGE_2_SPEC.md` §8.7). Gated on the SAME `noindex`
    // condition: structured data must never describe a page we are telling
    // crawlers to skip, and an empty pair has no subject matter to describe
    // beyond its two endpoints. `setEntityMeta` clears prior JSON-LD, so the
    // noindex branch leaves the head clean without an explicit removal here.
    //
    // Built from `pair` — the payload AFTER `gateHistoricalDepth` (AECI-304), so
    // the LD can never describe version depth the page does not serve. Reusing
    // `name` / `description` verbatim is what keeps the structured data and the
    // `<title>` from drifting; the breadcrumb label reuses the template's own
    // `@@pair.breadcrumb.home` message id for the same reason.
    if (!noindex) {
      meta.setPairJsonLd({
        canonical,
        name,
        description,
        homeLabel: $localize`:@@pair.breadcrumb.home:Home`,
        context: pair.context_product,
        other: pair.other_product,
      });
    }
  };

  const notFoundSlug = `${contextSlug}/${otherSlug}`;

  // ── Client path: in-app navigation or initial hydration. ──────────────────
  if (!isPlatformServer(platformId)) {
    const fetched = transferState.hasKey(stateKey)
      ? transferState.get(stateKey, null)
      : await httpGetOrNull<ProductPairResponse>(
          inject(HttpClient),
          pairPath(contextSlug, otherSlug, selection),
        );
    // Idempotent on a hydration hit — the server already gated what it transferred.
    const pair = fetched ? gateHistoricalDepth(fetched, historical) : null;

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

  const fetched = await fetchProductPair(ctx.api, contextSlug, otherSlug, selection);
  // Gate BEFORE the transfer: `TransferState` is serialised into the SSR document,
  // which is the artefact that lands in the shared edge-cache entry.
  const pair = fetched ? gateHistoricalDepth(fetched, historical) : null;
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
