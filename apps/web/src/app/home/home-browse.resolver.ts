/**
 * Resolver for the home page's "Browse by" grids (AECI-184, Phase 4.9). Supplies
 * the three taxonomy facets — `{ categories, audiences, phases }`, each a
 * `TaxonomyTermWithCount[]` carrying live `product_count` — to the home route.
 *
 * Data source is the **live** `GET /api/taxonomy` endpoint, NOT `stats_cache`
 * (§10): the issue scopes the browse counts to the live taxonomy so this module
 * is independent of the stats pipeline (4.3/4.4). The home route already carries
 * the `taxonomy` cache-tag (`cacheTagInputsForPath`, `path === '/'`), so a
 * taxonomy edit purges the home edge cache.
 *
 * Mirrors `taxonomy-index.resolver.ts`:
 *   - Server: fetch via the service binding (`ServerApiClient`), store in
 *     `TransferState` so hydration reuses the SSR payload.
 *   - Client (in-app nav / TransferState miss): fetch the same endpoint from the
 *     browser via the same-origin `/api/*` passthrough.
 *
 * No page meta is set here — the home `<title>` / JSON-LD is owned by the 4.11
 * home-assembly issue (AECI-186). This resolver is intentionally narrow (browse
 * data only) so 4.11 can compose it alongside the stats resolver.
 */
import { isPlatformServer } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState, inject, makeStateKey } from '@angular/core';
import { ResolveFn } from '@angular/router';

import type { TaxonomyResponse } from '@aeci/shared';

import type { AeciRequestContext } from '../../server/request-context';
import { httpGetOrNull } from '../core/api/http-get-or-null';
import { fetchTaxonomy } from '../core/api/taxonomy';

/** TransferState key for the SSR-resolved home taxonomy payload. */
const HOME_TAXONOMY_KEY = makeStateKey<TaxonomyResponse | null>('aeci.home-taxonomy');

export const homeBrowseResolver: ResolveFn<TaxonomyResponse | null> = async () => {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);

  // ── Client path: in-app navigation or initial hydration. ──────────────────
  if (!isPlatformServer(platformId)) {
    return transferState.hasKey(HOME_TAXONOMY_KEY)
      ? transferState.get(HOME_TAXONOMY_KEY, null)
      : await httpGetOrNull<TaxonomyResponse>(inject(HttpClient), '/api/taxonomy');
  }

  // ── Server path. ──────────────────────────────────────────────────────────
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;

  if (!ctx) {
    transferState.set(HOME_TAXONOMY_KEY, null);
    return null;
  }

  const taxonomy = await fetchTaxonomy(ctx.api);
  transferState.set(HOME_TAXONOMY_KEY, taxonomy);

  return taxonomy;
};
