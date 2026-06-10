/**
 * Resolver for the home page's stats-driven sections (AECI-186, Phase 4.11): the
 * three above-the-fold stats cards (4.8) and the below-the-fold recently-added +
 * trending lists (4.10). Supplies the whole `HomeStatsResponse` to the home
 * route under the `stats` data key.
 *
 * Data source is `GET /api/stats/home` (AECI-179), which reads the daily
 * `stats_cache` snapshot — NOT a live aggregation (§10). The "Browse by" grids
 * keep their own live-taxonomy resolver (`homeBrowseResolver`); this one is
 * parallel and independent so the home route resolves both in one navigation.
 *
 * Mirrors `home-browse.resolver.ts`:
 *   - Server: fetch via the service binding (`ServerApiClient`), store in
 *     `TransferState` so hydration reuses the SSR payload.
 *   - Client (in-app nav / TransferState miss): fetch the same endpoint from the
 *     browser via the same-origin `/api/*` passthrough.
 *
 * Null-safe: a missing `REQUEST_CONTEXT` (a render mode that doesn't provide it)
 * or a failed browser fetch resolves `null`, and the `Home` component renders
 * every section's empty state. No page meta is set here — the home `<title>` /
 * JSON-LD is owned by the `Home` component constructor (static, data-independent),
 * keeping this resolver narrow like its browse sibling.
 */
import { isPlatformServer } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState, inject, makeStateKey } from '@angular/core';
import { ResolveFn } from '@angular/router';

import type { HomeStatsResponse } from '@aeci/shared';

import type { AeciRequestContext } from '../../server/request-context';
import { httpGetOrNull } from '../core/api/http-get-or-null';
import { fetchHomeStats } from '../core/api/stats';

/** TransferState key for the SSR-resolved home stats payload. */
const HOME_STATS_KEY = makeStateKey<HomeStatsResponse | null>('aeci.home-stats');

export const homeStatsResolver: ResolveFn<HomeStatsResponse | null> = async () => {
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);

  // ── Client path: in-app navigation or initial hydration. ──────────────────
  if (!isPlatformServer(platformId)) {
    return transferState.hasKey(HOME_STATS_KEY)
      ? transferState.get(HOME_STATS_KEY, null)
      : await httpGetOrNull<HomeStatsResponse>(inject(HttpClient), '/api/stats/home');
  }

  // ── Server path. ──────────────────────────────────────────────────────────
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;

  if (!ctx) {
    transferState.set(HOME_STATS_KEY, null);
    return null;
  }

  const stats = await fetchHomeStats(ctx.api);
  transferState.set(HOME_STATS_KEY, stats);

  return stats;
};
