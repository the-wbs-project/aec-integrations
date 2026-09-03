/**
 * Vendor-neutral search-telemetry vocabulary.
 *
 * These three exports are the surviving half of the retired `search-rum.ts`
 * (AECI-174). That module paired them with `emitSearchQuery`, a Datadog **RUM**
 * `aeci.search.query` action; AECI-643 (`docs/POSTHOG_MIGRATION_SPEC.md` §3.9)
 * re-homed `status` / `duration_ms` / `results_bucket` onto the PostHog
 * `search_performed` event, and AECI-651 deleted the RUM emit along with the
 * rest of the Datadog leg. The vocabulary outlived the vendor, so it lives here
 * rather than in either controller — both `search-controller.ts` and the
 * `search_performed` payload it builds depend on it.
 *
 * `results_bucket` exists because a raw result count is unbounded-cardinality as
 * an event property. The bucket is the shape analytics actually pivots on; see
 * `docs/ANALYTICS.md` §6 (the activation funnel's first step).
 */

/** Whether a query resolved or errored. */
export type SearchStatus = 'ok' | 'error';

/** Coarse result-count bucket — keeps `results_bucket` low-cardinality. */
export type ResultsBucket = 'none' | '1-5' | '6-20' | '21+';

/** Map a result count to its coarse, low-cardinality bucket. */
export function resultsBucket(nbHits: number): ResultsBucket {
  if (nbHits <= 0) return 'none';
  if (nbHits <= 5) return '1-5';
  if (nbHits <= 20) return '6-20';
  return '21+';
}
