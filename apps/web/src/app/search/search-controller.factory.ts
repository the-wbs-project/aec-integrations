/**
 * The single impure seam for `/search` (AECI-142): the dynamic `import()` of
 * `instantsearch.js` + `algoliasearch/lite`, isolated here so (a) the heavy
 * search SDK stays OUT of the SSR bundle and every other route's payload —
 * loaded only when this lazy chunk runs in the browser — and (b)
 * `SearchController` stays a pure, fully unit-testable wiring class that takes a
 * structural `InstantSearchLib` and never touches the real modules.
 *
 * SSR safety: `instantsearch.js` / `algoliasearch/lite` touch browser globals at
 * module scope, so a static top-level import would crash SSR. They are reached
 * ONLY through the `import()` calls below, which the caller (`SearchPage`) runs
 * inside `afterNextRender` — browser-only by construction. Mirrors the
 * dynamic-import discipline in `apps/web/src/app/datadog.provider.ts`.
 *
 * Subpath imports (`instantsearch.js/es`, `.../es/widgets`, `.../es/connectors`)
 * pull only the connectors + the `index`/`configure` widgets we use, dropping
 * the unused prebuilt DOM widgets; `algoliasearch/lite`'s `liteClient` is the
 * search-only client (no indexing surface).
 */
import { InjectionToken } from '@angular/core';

import type { AlgoliaPublicConfig } from './algolia-config';
import type { InstantSearchLib } from './search-controller';

export interface SearchEngine {
  /** The structural SDK surface `SearchController` drives. */
  lib: InstantSearchLib;
  /** The query-only Algolia client (`liteClient`). */
  searchClient: unknown;
}

/** The factory signature `SearchPage` calls to obtain a loaded search engine. */
export type CreateSearchEngine = (config: AlgoliaPublicConfig) => Promise<SearchEngine>;

/**
 * DI seam for the engine factory. Defaults to the real dynamic-import
 * `createSearchEngine`; `SearchPage` injects it so unit tests can substitute a
 * fake (or never-resolving) factory and exercise the shell WITHOUT loading the
 * real `instantsearch.js` SDK — the Angular unit-test runner forbids `vi.mock`
 * on relative imports, so this token is the supported override point.
 */
export const SEARCH_ENGINE_FACTORY = new InjectionToken<CreateSearchEngine>(
  'SEARCH_ENGINE_FACTORY',
  { providedIn: 'root', factory: () => createSearchEngine },
);

/**
 * Dynamically load the search SDK in the browser and assemble the
 * `InstantSearchLib` + a query-only client from the public config. The `as`
 * casts live here, at the impure boundary, so the rest of the search code is
 * strictly typed against `InstantSearchLib`.
 */
export async function createSearchEngine(config: AlgoliaPublicConfig): Promise<SearchEngine> {
  const [is, widgets, connectors, lite] = await Promise.all([
    import('instantsearch.js/es'),
    import('instantsearch.js/es/widgets'),
    import('instantsearch.js/es/connectors'),
    import('algoliasearch/lite'),
  ]);

  const instantsearch = (is.default ?? (is as unknown)) as InstantSearchLib['instantsearch'];

  const lib: InstantSearchLib = {
    instantsearch,
    index: widgets.index as unknown as InstantSearchLib['index'],
    configure: widgets.configure as unknown as InstantSearchLib['configure'],
    connectSearchBox:
      connectors.connectSearchBox as unknown as InstantSearchLib['connectSearchBox'],
    connectHits: connectors.connectHits as unknown as InstantSearchLib['connectHits'],
    connectStats: connectors.connectStats as unknown as InstantSearchLib['connectStats'],
    connectPagination:
      connectors.connectPagination as unknown as InstantSearchLib['connectPagination'],
    connectRefinementList:
      connectors.connectRefinementList as unknown as InstantSearchLib['connectRefinementList'],
    connectNumericMenu:
      connectors.connectNumericMenu as unknown as InstantSearchLib['connectNumericMenu'],
    connectRange: connectors.connectRange as unknown as InstantSearchLib['connectRange'],
    connectSortBy: connectors.connectSortBy as unknown as InstantSearchLib['connectSortBy'],
  };

  const searchClient = lite.liteClient(config.appId, config.searchKey);
  return { lib, searchClient };
}
