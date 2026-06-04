/**
 * Resolver factory for the three taxonomy browse routes — `/categories/:slug`,
 * `/audiences/:slug`, `/phases/:slug`. Phase 2 Spec §3.1 / §7 / §9 / §10.
 *
 * The three routes are mechanically identical apart from the taxonomy kind, so
 * one factory produces all three resolvers (AECI-61 ships them together to keep
 * a single resolver/test/i18n pattern from drifting into three copies).
 *
 * Server flow (RenderMode.Server):
 *   1. Fetch `GET /api/{categories|audiences|phases}/:slug` via the service
 *      binding (no public surface) using `AeciRequestContext.api`.
 *   2. On `NOT_FOUND` → set `RESPONSE_INIT.status = 404` (SSR runtime emits a
 *      real HTTP 404 + `NOT_FOUND_TTL`), set noindex meta, return `null` so the
 *      page renders the inline NotFound panel.
 *   3. On success → set browse meta (`entity: kind` → `"{name} tools — AEC
 *      Integrations"`); push `product:{slug}` for every product shown onto
 *      `ctx.embedded` so `Cache-Tag` covers data-derived dependencies; queue the
 *      fire-and-forget `POST /api/page-views` payload. Store in `TransferState`.
 *
 * Client flow (hydration): read the resolved term (or `null`) out of
 * `TransferState`. No fetch, no meta side-effects.
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

import type { AeciRequestContext } from '../../server/request-context';
import {
  KIND_PATH_SEGMENT,
  fetchTaxonomyTermBySlug,
  type TaxonomyTermDetail,
} from '../core/api/taxonomy';
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
 * Builds the resolver for one taxonomy kind. Exported resolvers below are the
 * only call sites; the factory is not exported to keep route wiring explicit.
 */
function createTaxonomyBrowseResolver(kind: TaxonomyKind): ResolveFn<TaxonomyTermDetail | null> {
  const segment = KIND_PATH_SEGMENT[kind];

  return async (route) => {
    const slug = route.paramMap.get('slug') ?? '';
    const platformId = inject(PLATFORM_ID);
    const transferState = inject(TransferState);
    const stateKey = termStateKey(kind, slug);

    // Client hydration path — SSR populated TransferState; read it back.
    if (!isPlatformServer(platformId)) {
      return transferState.get(stateKey, null);
    }

    // Server path.
    const meta = inject(MetaService);
    const request = inject(REQUEST, { optional: true });
    const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
    const responseInit = inject(RESPONSE_INIT, { optional: true });
    const origin = request ? new URL(request.url).origin : 'https://aecintegrations.com';
    const canonical = `${origin}/${segment}/${slug}`;

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

    meta.setEntityMeta({
      entity: kind,
      name: term.name,
      description: term.description,
      canonical,
    });

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

    return term;
  };
}

export const categoryBrowseResolver = createTaxonomyBrowseResolver('category');
export const audienceBrowseResolver = createTaxonomyBrowseResolver('audience');
export const phaseBrowseResolver = createTaxonomyBrowseResolver('phase');
