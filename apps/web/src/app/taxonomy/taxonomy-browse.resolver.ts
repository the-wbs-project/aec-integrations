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
 *      service binding using `AeciRequestContext.api`.
 *   2. On `NOT_FOUND` → set `RESPONSE_INIT.status = 404` (SSR runtime emits a
 *      real HTTP 404 + `NOT_FOUND_TTL`), set noindex meta, return `null` so the
 *      page renders the inline NotFound panel.
 *   3. On success → set browse meta; push `product:{slug}` for every product
 *      shown onto `ctx.embedded` so `Cache-Tag` covers data-derived
 *      dependencies; queue the fire-and-forget `POST /api/page-views` payload.
 *      Store in `TransferState`.
 *
 * Client flow (AECI-151): on hydration / back-nav read the term out of
 * `TransferState`; on a genuine client navigation (no key) fetch it from the
 * browser via the same-origin `/api/*` passthrough (`httpGetOrNull`; ADR 0001).
 * Either way re-apply the browse meta (idempotent on hydration; the only meta
 * update on a client nav). `RESPONSE_INIT.status` / `ctx.embedded` stay
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
import { ResolveFn } from '@angular/router';

import { isPublishedTrade } from '@aeci/shared';

import { prefetchIndexPage } from '../shared/paginated-index/paginated-index.resolver';

import { taxonomyBrowseIndexRequest } from './taxonomy-browse.config';

import type { AeciRequestContext } from '../../server/request-context';
import { httpGetOrNull } from '../core/api/http-get-or-null';
import {
  KIND_PATH_SEGMENT,
  fetchTaxonomyTermBySlug,
  type TaxonomyTermDetail,
} from '../core/api/taxonomy';
import { canonicalUrl } from '../core/canonical';
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
    const canonical = canonicalUrl(`/${segment}/${slug}`);

    // ── Client path: in-app navigation or initial hydration (AECI-151). ─────
    if (!isPlatformServer(platformId)) {
      const term = transferState.hasKey(stateKey)
        ? transferState.get(stateKey, null)
        : await httpGetOrNull<TaxonomyTermDetail>(
            inject(HttpClient),
            `/api/${segment}/${encodeURIComponent(slug)}`,
          );

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

    const term = await fetchTaxonomyTermBySlug(ctx.api, kind, slug);
    transferState.set(stateKey, term);

    if (!term) {
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

    ctx.pageView = {
      route: `/${segment}/:slug`,
      entity_type: kind,
      entity_id: term.id,
    };

    // AECI-746 — prefetch the grid's first page here, INSIDE this resolver rather
    // than as a sibling on the route, because the request is scoped to `term.id`
    // and sibling resolvers run in parallel (there would be no term yet). Without
    // it the grid's `httpResource` fires a relative `/api/products` URL that has no
    // origin on the server, and the page SSRs its "Couldn't load products" branch
    // to every crawler.
    await prefetchIndexPage(
      ctx,
      transferState,
      taxonomyBrowseIndexRequest(
        () => kind,
        () => term.id,
      ),
      route.queryParamMap,
    );

    return term;
  };
}

export const categoryBrowseResolver = createTaxonomyBrowseResolver('category');
export const audienceBrowseResolver = createTaxonomyBrowseResolver('audience');
export const phaseBrowseResolver = createTaxonomyBrowseResolver('phase');
export const tradeBrowseResolver = createTaxonomyBrowseResolver('trade');
