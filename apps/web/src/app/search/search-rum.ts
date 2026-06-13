/**
 * Browser-RUM emit for client-side Algolia search (AECI-174).
 *
 * Search runs BROWSER-SIDE, direct to Algolia with the search-only key (§7.5), so
 * its latency + error rate are a Datadog **RUM** signal, not a Worker metric. On
 * every query that resolves or errors, the two search surfaces call
 * `emitSearchQuery(...)`:
 *   - `/search` (`search-controller.ts`) emits PER INDEX from each index's
 *     `connectStats` render (`index: 'products' | 'vendors'`, `duration_ms` =
 *     Algolia `processingTimeMS`), and ONE `index: 'federated'` error from the
 *     InstantSearch instance `error` event (a batched multi-query fails as a unit).
 *   - the header autocomplete (`autocomplete-controller.ts`) emits ONE
 *     `index: 'federated'` per query (a single batched `searchForHits`), with
 *     `duration_ms` = client round-trip.
 *
 * The contract (context fields, low-cardinality, NO raw query text) is defined in
 * `docs/OBSERVABILITY.md` → "Browser search RUM".
 *
 * `emitSearchQuery` mirrors the discipline of `apps/web/src/app/datadog.provider.ts`:
 * `@datadog/browser-rum` is a browser-only SDK, so it is reached ONLY through a
 * dynamic `import()` (the module is already loaded + initialized at app bootstrap;
 * this resolves the cached module). It is fire-and-forget and swallows failures —
 * observability MUST NOT break search. Both callers run post-hydration (inside
 * `afterNextRender`), so this is browser-only by construction; when RUM is not
 * provisioned (dev without secrets), `addAction` is a safe no-op.
 *
 * The function is injected into each controller as a `SearchQueryEmitter` seam
 * (default = `emitSearchQuery`), so unit tests assert the emitted context with a
 * `vi.fn()` WITHOUT importing the real SDK — the same seam pattern as
 * `SEARCH_ENGINE_FACTORY` / `AUTOCOMPLETE_SEARCH_FACTORY`.
 */

/** Which Algolia surface produced the query. */
export type SearchIndex = 'products' | 'vendors' | 'integrations' | 'federated';

/** Whether the query resolved or errored. */
export type SearchStatus = 'ok' | 'error';

/** Coarse result-count bucket — keeps `results_bucket` low-cardinality. */
export type ResultsBucket = 'none' | '1-5' | '6-20' | '21+';

/** The low-cardinality context attached to every `aeci.search.query` action. */
export interface SearchQueryContext {
  readonly index: SearchIndex;
  readonly status: SearchStatus;
  /** Algolia `processingTimeMS` or the client round-trip, in ms. */
  readonly duration_ms: number;
  readonly results_bucket: ResultsBucket;
}

/** The injectable emit seam (default impl: `emitSearchQuery`). */
export type SearchQueryEmitter = (ctx: SearchQueryContext) => void;

/** Map a result count to its coarse, low-cardinality bucket. */
export function resultsBucket(nbHits: number): ResultsBucket {
  if (nbHits <= 0) return 'none';
  if (nbHits <= 5) return '1-5';
  if (nbHits <= 20) return '6-20';
  return '21+';
}

/**
 * Emit the `aeci.search.query` RUM action. Browser-only (callers run after
 * hydration); dynamic-imports the cached SDK; never throws.
 */
export const emitSearchQuery: SearchQueryEmitter = (ctx) => {
  void import('@datadog/browser-rum')
    .then(({ datadogRum }) => {
      datadogRum.addAction('aeci.search.query', { ...ctx });
    })
    .catch(() => {
      // Observability MUST NOT break search — swallow load/emit failures.
    });
};
