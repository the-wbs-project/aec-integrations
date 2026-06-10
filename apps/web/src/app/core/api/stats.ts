/**
 * Typed accessor for the home-stats API surface (apps/api `GET
 * /api/stats/home`). Wraps `ServerApiClient.request<T>` so the home stats
 * resolver stays free of stringly-typed paths — parallels `core/api/taxonomy.ts`.
 *
 * Anchor: Phase 2 Spec §3.1 / §7 — the API Worker is reached by the SSR Worker
 * via `env.API.fetch(...)` (service binding). This helper wraps that server-only
 * `ServerApiClient` and runs during SSR; the resolver's browser hydration-miss
 * branch fetches the same endpoint via the same-origin `/api/*` passthrough
 * (`core/api/http-get-or-null.ts`), not this client.
 *
 * Unlike the entity accessors there is no `fetchOrNull`: `GET /api/stats/home`
 * (AECI-179) has no NOT_FOUND case — it always returns a valid 200
 * `HomeStatsResponse`, with `0` / `[]` / `null` fields when the daily
 * `stats_cache` snapshot is sparse (pre-launch). The 4.11 consumer branches on
 * those empties for the home empty states.
 */
import type { HomeStatsResponse } from '@aeci/shared';

import type { ServerApiClient } from '../../../server-api-client';

/**
 * Fetch the daily home-stats snapshot (`GET /api/stats/home`) — the §4.1
 * above-the-fold cards (total integrations / most-integrated product /
 * most-active category) plus the below-the-fold recently-added + trending
 * lists. Reads `stats_cache` (AECI-178 cron), never a live aggregation.
 */
export async function fetchHomeStats(client: ServerApiClient): Promise<HomeStatsResponse> {
  return client.request<HomeStatsResponse>('/api/stats/home');
}
