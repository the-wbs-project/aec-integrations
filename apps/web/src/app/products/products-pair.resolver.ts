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
 * ── AECI-953: AN EMPTY PAIR MAY BE A MOVED PAIR ─────────────────────────────
 * A promote that re-points an endpoint keeps the edge's id and updates its row in
 * place, but the pair page is keyed by two product SLUGS — so the URL moves and the
 * old one served 200 + `noindex` with no redirect. AECI-726 did that to 37 live
 * Procore edges and AECI-950 to 15 more. The API now answers an empty pair with
 * `moved_to` when `integration_endpoint_moves` says the content went somewhere, and
 * this resolver turns that into a **301** on the server and a `replaceUrl` navigation
 * on the client.
 *
 * Two things about the server branch are load-bearing:
 *
 *   1. **It is `RESPONSE_INIT`, not `RedirectCommand`.** Angular's own redirect path
 *      (`@angular/ssr`'s `createRedirectResponse`) unconditionally sets
 *      `Vary: X-Forwarded-Prefix`. `CLAUDE.md` forbids any `Vary` value but
 *      `Accept-Language`, and `withCacheHeaders` runs `applySeoHeaders` — the thing
 *      that strips a forbidden `Vary` — on 2xx and 404 only, so a 3xx would carry it
 *      to the edge. The same call also discards the headers set here.
 *   2. **It runs before the `!pair` 404 branch and before the TransferState write.**
 *      The Worker drops the body on a 3xx, so a transferred payload would serialise a
 *      page nobody renders.
 *
 * A pair with even one surviving mechanism never redirects — Smartsheet kept one of
 * its two Procore Project Management edges through AECI-726, and that page is smaller,
 * not moved.
 *
 * ── AECI-991: A 404 MAY BE A RETIRED ENDPOINT SLUG ──────────────────────────
 * `moved_to` only ever rides a **200**, so it cannot answer a pair URL whose endpoint
 * product is *gone*: the API resolves both slugs to rows before it looks at anything
 * else, and a missing row is a 404 with no body to carry a hint. That is the shape a
 * merge-then-retire leaves behind — AECI-809 re-pointed 44 edges onto Autodesk Forma
 * and then retracted the Autodesk Construction Cloud record, and all 44
 * `/products/autodesk-construction-cloud/integrations/*` URLs started 404ing while
 * `/products/autodesk-construction-cloud` itself still 301'd correctly.
 *
 * So the not-found branch consults `slug_redirects` (AECI-978) and rewrites the path
 * **prefix**: `/products/{from}/integrations/{x}` → `/products/{to}/integrations/{x}`.
 * Four things about it:
 *
 *   1. **BOTH slugs are looked up, not just the context one.** §11.2 makes both
 *      orientations of a real pair indexable, so the retired endpoint is the second
 *      segment in half the indexed URLs. One rewrite, one 301, either way.
 *   2. **It is one rule, not one row per pair.** A merge retires ONE slug and fixes
 *      every pair page under it. Minting a per-pair record instead would mean writing
 *      44 rows to say one thing, and re-deriving them at every future merge.
 *   3. **It runs only after the pair read returned nothing** — the same ordering rule
 *      `createDetailResolver` follows, for the same reason: a live page must always
 *      beat a mapping, which is what lets a redirect be seeded ahead of the retraction.
 *   4. **A rewrite that collapses the two slugs is refused.** `{from}` mapping onto
 *      the other endpoint's own slug would produce `/products/x/integrations/x`,
 *      which the API 404s by definition — a 301 onto a guaranteed 404 is worse than
 *      the 404 we already have.
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
import { ResolveFn, Router } from '@angular/router';

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
import { fetchSlugRedirect, httpGetSlugRedirect, lookUpRedirect } from '../core/api/slug-redirects';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';

/**
 * `Cache-Control` for the moved-pair 301 (AECI-953).
 *
 * The same `public, max-age=3600, s-maxage=86400` the SSR Worker's other permanent
 * redirects carry (`server-runtime.ts` — `/integrations/:id`, `/vendors/bluebeam`,
 * `/disciplines`), rather than a detail page's 900s. A redirect is a mapping, not
 * content: it changes only when a promote moves the edge again, and that promote
 * purges the `pair:` tag below. No `stale-while-revalidate` — `RESILIENCE` deliberately
 * omits it on redirects.
 *
 * Written as a literal because `buildCacheControl` lives in `server-runtime.ts`, which
 * app code cannot import (it pulls in the Worker `Bindings` types).
 */
const MOVED_PAIR_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';

/**
 * The pair-page path a moved pair redirects to. One spelling for both branches, so the
 * `Location` header and the client-side `navigateByUrl` can never disagree.
 *
 * The API has already oriented the two slugs for the requesting URL, so this does NOT
 * canonicalise them — the endpoint the reader asked for stays in frame, and the new
 * page's own `<link rel=canonical>` handles the alphabetical rule (§7.1/§11.2).
 */
function movedPairPath(movedTo: { context_slug: string; other_slug: string }): string {
  return `/products/${movedTo.context_slug}/integrations/${movedTo.other_slug}`;
}

/**
 * Apply the retired-slug map to the two slugs of a pair URL (AECI-991).
 *
 * `null` when neither slug is mapped (the ordinary case — most pair 404s are junk),
 * or when the rewrite would name a pair whose two endpoints are the same product.
 *
 * Both lookups go out in ONE wave. They are independent, this request has already
 * decided to 404, and serialising them would double the latency of a page nobody is
 * being shown.
 */
async function rewriteRetiredPairSlugs(
  contextSlug: string,
  otherSlug: string,
  lookup: (slug: string) => Promise<{ to_slug: string } | null>,
): Promise<{ context_slug: string; other_slug: string } | null> {
  const [context, other] = await Promise.all([
    lookUpRedirect(() => lookup(contextSlug)),
    lookUpRedirect(() => lookup(otherSlug)),
  ]);
  if (!context && !other) return null;
  const nextContext = context?.to_slug ?? contextSlug;
  const nextOther = other?.to_slug ?? otherSlug;
  // A merge whose survivor is the pair's OTHER endpoint — the two products are now
  // one, there is no pair, and the API 404s equal slugs by definition.
  if (nextContext === nextOther) return null;
  return { context_slug: nextContext, other_slug: nextOther };
}

/**
 * `Cache-Tag` for a retired-endpoint pair 301 (AECI-991), per `CACHE_STRATEGY.md`
 * §2 and §3 rule 6.
 *
 * Four tags, and each answers a different way this redirect goes wrong:
 *
 *   - **the OLD `pair:` tag** — the retired endpoint COMES BACK. A re-promote of that
 *     slug purges its pair tags and nothing else, and without this the edge would keep
 *     redirecting readers away from a page that is live again for the full 24h
 *     `s-maxage`. This is rule 6's `{from_slug}` argument, applied to a pair URL.
 *   - **the NEW `pair:` tag** — the destination pair changes or empties, so the 301
 *     stops being the right answer.
 *   - **`product:` for both mapped slugs** — the survivor being renamed or retired in
 *     turn purges `product:{to_slug}` through the ordinary rules, and a re-promote of
 *     the retired slug purges `product:{from_slug}`.
 *
 * Both pair tags are built in the alphabetical `{min}__{max}` form the rest of the
 * system uses, so a purge from any producer matches. Editing `slug_redirects` itself
 * purges nothing — that is an operator action with no writer to hook (rule 6).
 */
function retiredPairCacheTags(
  contextSlug: string,
  otherSlug: string,
  rewritten: { context_slug: string; other_slug: string },
): string {
  const [oldMin, oldMax] = orderedPairSlugs(contextSlug, otherSlug);
  const [newMin, newMax] = orderedPairSlugs(rewritten.context_slug, rewritten.other_slug);
  const tags = [`pair:${oldMin}__${oldMax}`, `pair:${newMin}__${newMax}`];
  // Only the slugs that actually changed carry a `product:` tag — an unmapped
  // endpoint's product page has nothing to do with this redirect.
  for (const [from, to] of [
    [contextSlug, rewritten.context_slug],
    [otherSlug, rewritten.other_slug],
  ]) {
    if (from !== to) tags.push(`product:${from}`, `product:${to}`);
  }
  return [...new Set(tags)].join(',');
}

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
    // `<title>` from drifting; the breadcrumb labels reuse the template's own
    // `@@pair.breadcrumb.home` / `@@pair.breadcrumb.integrations` message ids for
    // the same reason.
    if (!noindex) {
      meta.setPairJsonLd({
        canonical,
        name,
        description,
        homeLabel: $localize`:@@pair.breadcrumb.home:Home`,
        integrationsLabel: $localize`:@@pair.breadcrumb.integrations:Integrations`,
        context: pair.context_product,
        other: pair.other_product,
      });
    }
  };

  const notFoundSlug = `${contextSlug}/${otherSlug}`;

  // ── Client path: in-app navigation or initial hydration. ──────────────────
  if (!isPlatformServer(platformId)) {
    // Injected HERE, before the fetch — `inject()` only works while the injection
    // context is live, and the first `await` below ends it. `optional` because the
    // component-spec harness runs this resolver without a router; the app itself
    // always has one, and a null router simply skips the redirect and renders.
    const router = inject(Router, { optional: true });
    const http = inject(HttpClient);
    const fetched = transferState.hasKey(stateKey)
      ? transferState.get(stateKey, null)
      : await httpGetOrNull<ProductPairResponse>(http, pairPath(contextSlug, otherSlug, selection));
    // Idempotent on a hydration hit — the server already gated what it transferred.
    const pair = fetched ? gateHistoricalDepth(fetched, historical) : null;

    // AECI-953 — the client half of the moved-pair redirect. A SPA navigation has no
    // HTTP status, so the equivalent of a 301 is a `replaceUrl` navigation: the moved
    // URL must not sit in the history stack, or Back from the new page lands on the
    // page that just redirected and bounces forward again.
    const movedTo = pair?.moved_to;
    if (movedTo && router) {
      void router.navigateByUrl(movedPairPath(movedTo), { replaceUrl: true });
      return null;
    }

    // AECI-991 — the client half of the retired-endpoint rewrite. Same `replaceUrl`
    // reasoning as above: the retired URL must not sit in the history stack.
    if (!pair && router) {
      const rewritten = await rewriteRetiredPairSlugs(contextSlug, otherSlug, (slug) =>
        httpGetSlugRedirect(http, 'product', slug),
      );
      if (rewritten) {
        void router.navigateByUrl(movedPairPath(rewritten), { replaceUrl: true });
        return null;
      }
    }

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

  // ── AECI-953: the moved-pair 301, before anything else the server does ──────
  // Checked ahead of the `!pair` 404 branch and ahead of the TransferState write:
  // this response has no readable body, so transferring a payload into it would
  // serialise a page nobody renders.
  const movedTo = pair?.moved_to;
  if (movedTo && responseInit) {
    responseInit.status = 301;
    // `ResponseInit.headers` is typed `HeadersInit | undefined`, though `@angular/ssr`
    // always builds a real `Headers` and hands the SAME object to both DI and the final
    // `new Response(...)`. Normalising rather than casting keeps that an assumption we
    // can be wrong about without losing the headers.
    const headers = responseInit.headers instanceof Headers ? responseInit.headers : new Headers();
    responseInit.headers = headers;
    // The origin comes off `canonical`, which `canonicalUrl` already built ABOVE, in
    // the injection context. Calling `canonicalUrl` here would throw — it injects
    // `REQUEST`, and the `await` on the fetch has ended that context.
    headers.set('Location', `${new URL(canonical).origin}${movedPairPath(movedTo)}`);
    // Set HERE rather than left to the SSR Worker. `withCacheHeaders` treats a 3xx as
    // neither 2xx nor 404 and hands it to `ensureNoStore`, which only fills in a
    // Cache-Control when one is absent — so a permanent mapping would otherwise be
    // re-rendered on every crawler hit. The tag is the OLD pair's, which is what the
    // promote purges when the edge moves again or moves back.
    headers.set('Cache-Control', MOVED_PAIR_CACHE_CONTROL);
    headers.set('Cache-Tag', `pair:${minSlug}__${maxSlug}`);
    transferState.set(stateKey, null);
    return null;
  }

  transferState.set(stateKey, pair);

  if (!pair) {
    // ── AECI-991: the pair 404 may be a retired ENDPOINT slug ────────────────
    // Consulted here and nowhere else, so §2.6's "only on the not-found branch"
    // rule is literally true for this route too: the read has already missed.
    const rewritten = responseInit
      ? await rewriteRetiredPairSlugs(contextSlug, otherSlug, (slug) =>
          fetchSlugRedirect(ctx.api, 'product', slug),
        )
      : null;
    if (rewritten && responseInit) {
      responseInit.status = 301;
      const headers =
        responseInit.headers instanceof Headers ? responseInit.headers : new Headers();
      responseInit.headers = headers;
      headers.set('Location', `${new URL(canonical).origin}${movedPairPath(rewritten)}`);
      headers.set('Cache-Control', MOVED_PAIR_CACHE_CONTROL);
      headers.set('Cache-Tag', retiredPairCacheTags(contextSlug, otherSlug, rewritten));
      return null;
    }
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
