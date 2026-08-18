/**
 * Resolver factory for the four taxonomy index routes — `/categories`,
 * `/audiences`, `/phases` (AECI-157) and `/trades` (AECI-544). The flat list of
 * every term in a facet with product counts, rendered by the shared
 * `TaxonomyIndexPage`.
 *
 * The four routes are mechanically identical apart from the facet kind, so one
 * factory produces all four resolvers — the same one-factory pattern the browse
 * resolvers (`taxonomy-browse.resolver.ts`) and the paginated index controller
 * use. AECI-61 originally shipped only `/categories` (audience / phase indexes
 * were deferred); this generalizes that resolver and lights up the others.
 *
 * The trades publication floor is NOT applied here — the resolver returns the
 * API's full ungated list and `TaxonomyIndexPage` filters for display, so the
 * TransferState payload stays a faithful copy of the API response.
 *
 * Server flow: fetch `GET /api/{segment}` via the service binding, set the index
 * meta, store in `TransferState`.
 *
 * Client flow (AECI-151): on hydration / back-nav read the list out of
 * `TransferState`; on a genuine client navigation (no key) fetch it from the
 * browser via the same-origin `/api/*` passthrough and set the index meta. The
 * list always resolves, so there is no slug / 404 path; the per-facet cache-tag
 * set (`route:index`, `index:{segment}`, `taxonomy`) is static and emitted by
 * `cacheTagInputsForPath`.
 */
import { isPlatformServer } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState, inject, makeStateKey } from '@angular/core';
import { ResolveFn } from '@angular/router';

import type { CategoriesListResponse } from '@aeci/shared';

import type { AeciRequestContext } from '../../server/request-context';
import { httpGetOrNull } from '../core/api/http-get-or-null';
import { KIND_PATH_SEGMENT, fetchTaxonomyList } from '../core/api/taxonomy';
import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/** Per-facet TransferState key (`aeci.categories-index`, etc.). */
function indexStateKey(segment: string) {
  return makeStateKey<CategoriesListResponse | null>(`aeci.${segment}-index`);
}

/** Localized index meta `name` per facet (also the page title / breadcrumb). */
function metaName(kind: TaxonomyKind): string {
  switch (kind) {
    case 'category':
      return $localize`:@@categories.index.metaName:Categories`;
    case 'audience':
      return $localize`:@@audiences.index.metaName:Audiences`;
    case 'phase':
      return $localize`:@@phases.index.metaName:Phases`;
    case 'trade':
      return $localize`:@@trades.index.metaName:Trades`;
  }
}

/** Localized index meta description per facet. */
function metaDescription(kind: TaxonomyKind): string {
  switch (kind) {
    case 'category':
      return $localize`:@@categories.index.metaDescription:Browse every AEC software category on AEC Integrations, each with its live product count.`;
    case 'audience':
      return $localize`:@@audiences.index.metaDescription:Browse every AEC software audience on AEC Integrations, each with its live product count.`;
    case 'phase':
      return $localize`:@@phases.index.metaDescription:Browse every AEC project phase on AEC Integrations, each with its live product count.`;
    case 'trade':
      return $localize`:@@trades.index.metaDescription:Find software built for your trade (electrical, roofing, concrete and more) on AEC Integrations.`;
  }
}

/** Index head metadata. Shared by the server and client branches. */
function setIndexMeta(meta: MetaService, kind: TaxonomyKind, canonical: string): void {
  meta.setEntityMeta({
    entity: 'index',
    name: metaName(kind),
    description: metaDescription(kind),
    canonical,
  });
}

/**
 * Builds the resolver for one taxonomy index. The exported resolvers below are
 * the only call sites; the factory is not exported to keep route wiring explicit
 * (mirrors `taxonomy-browse.resolver.ts`).
 */
function createTaxonomyIndexResolver(kind: TaxonomyKind): ResolveFn<CategoriesListResponse | null> {
  const segment = KIND_PATH_SEGMENT[kind];

  return async () => {
    const platformId = inject(PLATFORM_ID);
    const transferState = inject(TransferState);
    const meta = inject(MetaService);
    const canonical = canonicalUrl(`/${segment}`);
    const stateKey = indexStateKey(segment);

    // ── Client path: in-app navigation or initial hydration (AECI-151). ───────
    if (!isPlatformServer(platformId)) {
      const list = transferState.hasKey(stateKey)
        ? transferState.get(stateKey, null)
        : await httpGetOrNull<CategoriesListResponse>(inject(HttpClient), `/api/${segment}`);
      if (list) setIndexMeta(meta, kind, canonical);
      return list;
    }

    // ── Server path. ──────────────────────────────────────────────────────────
    const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;

    if (!ctx) {
      transferState.set(stateKey, null);
      return null;
    }

    const list = await fetchTaxonomyList(ctx.api, kind);
    transferState.set(stateKey, list);
    setIndexMeta(meta, kind, canonical);

    return list;
  };
}

export const categoriesIndexResolver = createTaxonomyIndexResolver('category');
export const audiencesIndexResolver = createTaxonomyIndexResolver('audience');
export const phasesIndexResolver = createTaxonomyIndexResolver('phase');
export const tradesIndexResolver = createTaxonomyIndexResolver('trade');
