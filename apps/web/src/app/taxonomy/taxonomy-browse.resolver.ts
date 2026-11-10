/**
 * Resolver factory for the four taxonomy browse routes — `/categories/:slug`,
 * `/audiences/:slug`, `/phases/:slug`, `/trades/:slug`. Phase 2 Spec §3.1 / §7 /
 * §9 / §10; trades per STAGE_1_SPEC.md §5.5a (AECI-544).
 *
 * The four routes are mechanically identical apart from the taxonomy kind, so
 * one factory produces all four resolvers (AECI-61 ships them together to keep
 * a single resolver/test/i18n pattern from drifting into four copies).
 *
 * A trade below the publication floor resolves normally here — its URL is stable
 * across the gate, so crossing the floor needs no redirect. What it does NOT get
 * is indexability: `applyBrowseMeta` sets `noindex` on a sub-floor trade
 * (AECI-546), matching its exclusion from the sitemap. The other three facets are
 * never gated.
 *
 * Server flow (RenderMode.Server):
 *   1. Fetch `GET /api/{categories|audiences|phases|trades}/:slug` via the
 *      service binding using `AeciRequestContext.api`, and in parallel the
 *      grid's first page (`GET /api/products?{kind}_slug=…`, AECI-1508).
 *   2. On `NOT_FOUND` → ask `slug_redirects` first (AECI-979, `STAGE_3_SPEC.md`
 *      §2.6 option B). On a hit, answer a 301 to the surviving term (see
 *      `applyRetiredSlugRedirect` below). Otherwise set `RESPONSE_INIT.status = 404`
 *      (SSR runtime emits a real HTTP 404 + `NOT_FOUND_TTL`), set noindex meta,
 *      return `null` so the page renders the inline NotFound panel.
 *   3. On success → set browse meta; push `product:{slug}` for every product
 *      shown onto `ctx.embedded` so `Cache-Tag` covers data-derived
 *      dependencies. Store the term and the grid page in `TransferState`
 *      (the grid page only on success). The gateway writes the
 *      arrival from the path (AECI-1297), so nothing here records a view.
 *
 * Client flow (AECI-151): on hydration / back-nav read the term out of
 * `TransferState`; on a genuine client navigation (no key) fetch it from the
 * browser via the same-origin `/api/*` passthrough (`httpGetOrNull`; ADR 0001).
 * Either way re-apply the browse meta (idempotent on hydration; the only meta
 * update on a client nav). A genuine client nav to a retired slug asks the same
 * map and replaces the URL with the survivor's (AECI-979). `RESPONSE_INIT.status` / `ctx.embedded` stay
 * server-only; page-views fire from `PageViewTracker`.
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
import { Router, type ParamMap, type ResolveFn } from '@angular/router';

import { isPublishedTrade } from '@aeci/shared';

import { fetchIndexPage, storeIndexPage } from '../shared/paginated-index/paginated-index.resolver';

import { taxonomyBrowseIndexRequest } from './taxonomy-browse.config';

import type { AeciRequestContext } from '../../server/request-context';
import { httpGetOrNull } from '../core/api/http-get-or-null';
import {
  fetchSlugRedirect,
  httpGetSlugRedirect,
  lookUpRedirect,
  setSlugRedirectResponse,
} from '../core/api/slug-redirects';
import {
  KIND_PATH_SEGMENT,
  fetchTaxonomyTermBySlug,
  type TaxonomyTermDetail,
} from '../core/api/taxonomy';
import { listingCanonicalUrl } from '../core/canonical';
import { LISTING_CACHE_KEY_PARAMS } from '../core/listing-cache-key-params';
import { MetaService } from '../core/meta.service';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

const STATE_PREFIX = 'aeci.taxonomy-browse:';

/**
 * Per-kind+slug TransferState key. Kind is included alongside the slug so a
 * category and an audience that happen to share a slug can't collide.
 */
function termStateKey(kind: TaxonomyKind, slug: string) {
  return makeStateKey<TaxonomyTermDetail | null>(`${STATE_PREFIX}${kind}:${slug}`);
}

/**
 * Browse-page head metadata for a resolved term. Shared by the server and
 * client branches so the `entity: kind` → `"{name} tools — AEC Integrations"`
 * title stays single-source — and so the trade publication gate below can't
 * apply on SSR but be dropped on a client navigation.
 *
 * `product_count` rides on the detail response (`TaxonomyTermWithCountSchema`),
 * so the gate costs no extra fetch.
 */
function applyBrowseMeta(
  meta: MetaService,
  kind: TaxonomyKind,
  term: TaxonomyTermDetail,
  canonical: string,
): void {
  meta.setEntityMeta({
    entity: kind,
    name: term.name,
    description: term.description,
    canonical,
    // AECI-546 / `TRADES_VOCABULARY.md` §6 — the publication gate's indexability
    // half. A sub-floor trade page renders normally (its URL is permanent) but
    // must not be indexed, mirroring its exclusion from the sitemap. `MetaService`
    // emits a bare `noindex`; `follow` is the crawler default, which is what we
    // want here — the product links out of a thin trade page still carry weight.
    // Trades are the ONLY count-gated facet: a zero-product category or phase
    // stays indexable, because those vocabularies are curated against the catalog
    // rather than seeded closed.
    noindex: kind === 'trade' && !isPublishedTrade(term),
  });
}

/**
 * The query string a retired-slug 301 carries onto the surviving term (AECI-979).
 *
 * Unlike the detail routes, which drop the query, a browse URL's query is content:
 * `page`, `sort`, `view` and the facet ids all change what renders. So the redirect
 * keeps them. It keeps ONLY the params in `LISTING_CACHE_KEY_PARAMS`, though, not the
 * raw query. The 301 is edge-cached under the WC-4 key, which varies on exactly
 * those params. A `Location` built from the raw query would bake whichever
 * `utm_*` / `fbclid` warmed the entry into every later visitor's redirect.
 *
 * Returns `''` or a string starting with `?`. Param order follows the allowlist, so
 * the same key always produces the same `Location`.
 */
function redirectQuery(params: ParamMap): string {
  const kept = new URLSearchParams();
  for (const name of LISTING_CACHE_KEY_PARAMS) {
    for (const value of params.getAll(name)) kept.append(name, value);
  }
  const query = kept.toString();
  return query ? `?${query}` : '';
}

/**
 * Builds the resolver for one taxonomy kind. Exported resolvers below are the
 * only call sites; the factory is not exported to keep route wiring explicit.
 */
function createTaxonomyBrowseResolver(kind: TaxonomyKind): ResolveFn<TaxonomyTermDetail | null> {
  const segment = KIND_PATH_SEGMENT[kind];

  return async (route) => {
    const slug = route.paramMap.get('slug') ?? '';
    const platformId = inject(PLATFORM_ID);
    const transferState = inject(TransferState);
    const meta = inject(MetaService);
    const stateKey = termStateKey(kind, slug);
    // AECI-803 — the browse grid is paginated, so page 2+ self-canonicalises
    // rather than pointing at page 1. The two `setNotFoundMeta` calls below reuse
    // this value deliberately and need no branch: that method still strips the
    // whole query, so a 404 keeps self-referencing the bare term URL.
    const canonical = listingCanonicalUrl(`/${segment}/${slug}`, route.queryParamMap.get('page'));

    // ── Client path: in-app navigation or initial hydration (AECI-151). ─────
    if (!isPlatformServer(platformId)) {
      // Both injected HERE, before any await: `inject()` only works while the
      // injection context is live. `Router` is optional because the component-spec
      // harness runs this resolver without one; a null router skips the redirect
      // and renders the not-found panel.
      const http = inject(HttpClient);
      const router = inject(Router, { optional: true });
      const hydrated = transferState.hasKey(stateKey);
      const term = hydrated
        ? transferState.get(stateKey, null)
        : await httpGetOrNull<TaxonomyTermDetail>(
            http,
            `/api/${segment}/${encodeURIComponent(slug)}`,
          );

      // AECI-979: the client half of the retired-slug redirect, the same shape as
      // `createDetailResolver`'s. A SPA navigation has no HTTP status, so the 301's
      // equivalent is a `replaceUrl` navigation: the retired URL must not stay in
      // history, or Back from the survivor bounces forward again. Only a genuine
      // client nav asks. On hydration the server already asked: a mapped slug got
      // the 301 and never rendered, so a hydrated null is a real 404.
      if (!term && !hydrated && router) {
        const moved = await lookUpRedirect(() => httpGetSlugRedirect(http, kind, slug));
        if (moved) {
          void router.navigateByUrl(
            `/${segment}/${moved.to_slug}${redirectQuery(route.queryParamMap)}`,
            { replaceUrl: true },
          );
          return null;
        }
      }

      if (term) applyBrowseMeta(meta, kind, term, canonical);
      else meta.setNotFoundMeta({ kind, slug, canonical });
      return term;
    }

    // ── Server path. ────────────────────────────────────────────────────────
    const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
    const responseInit = inject(RESPONSE_INIT, { optional: true });

    // `REQUEST_CONTEXT` is only provided when the route uses RenderMode.Server.
    // The taxonomy routes sit under the catch-all server route, so this branch
    // should never hit in production — bail gracefully if it does.
    if (!ctx) {
      transferState.set(stateKey, null);
      return null;
    }

    // AECI-746 — the grid's first page is prefetched here, INSIDE this resolver
    // rather than as a sibling on the route. Without it the grid's `httpResource`
    // fires a relative `/api/products` URL that has no origin on the server, and
    // the page SSRs its "Couldn't load products" branch to every crawler.
    //
    // AECI-1508 — the grid locks its dimension by the route's slug, not `term.id`,
    // so its fetch needs nothing from the term and the two service-binding hops
    // run together. Before this they were serial on every cache miss. The term
    // fetch still throws on a non-404 error; `fetchIndexPage` fails open.
    const [term, gridPage] = await Promise.all([
      fetchTaxonomyTermBySlug(ctx.api, kind, slug),
      fetchIndexPage(
        ctx,
        taxonomyBrowseIndexRequest(
          () => kind,
          () => slug,
        ),
        route.queryParamMap,
      ),
    ]);
    transferState.set(stateKey, term);

    if (!term) {
      // AECI-979: ask the retired-slug map before committing to the 404. Reached only
      // after the term read missed, so a live term always beats a mapping and the map
      // never touches the hot path (`STAGE_3_SPEC.md` §2.6).
      const moved = await lookUpRedirect(() => fetchSlugRedirect(ctx.api, kind, slug));
      if (moved && responseInit) {
        // The origin comes off `canonical`, built while the injection context was
        // live. The awaits above have ended it.
        setSlugRedirectResponse(responseInit, {
          location: `${new URL(canonical).origin}/${segment}/${moved.to_slug}${redirectQuery(route.queryParamMap)}`,
          entity: kind,
          fromSlug: slug,
          toSlug: moved.to_slug,
        });
        return null;
      }
      if (responseInit) responseInit.status = 404;
      meta.setNotFoundMeta({ kind, slug, canonical });
      return null;
    }

    applyBrowseMeta(meta, kind, term, canonical);

    // Embedded cache-tag entities — every product rendered in the grid. Per
    // CACHE_STRATEGY.md §3 a browse page "lists every product matching the
    // facet → tag each", so editing any shown product purges this page.
    for (const product of term.products) {
      ctx.embedded.push({ type: 'product', slug: product.slug });
    }

    // Stored only now that the term exists, so a 404 page serializes no listing.
    storeIndexPage(transferState, gridPage);

    return term;
  };
}

export const categoryBrowseResolver = createTaxonomyBrowseResolver('category');
export const audienceBrowseResolver = createTaxonomyBrowseResolver('audience');
export const phaseBrowseResolver = createTaxonomyBrowseResolver('phase');
export const tradeBrowseResolver = createTaxonomyBrowseResolver('trade');
