/**
 * The single impure seam for the header autocomplete (AECI-144 / Phase 3.11):
 * the dynamic `import()` of `algoliasearch/lite`, isolated here so (a) the SDK
 * stays OUT of the SSR bundle and every route's initial payload — loaded only
 * when this lazy path runs in the browser — and (b) `AutocompleteController`
 * stays a pure, fully unit-testable class that takes a structural
 * `AutocompleteSearchFn` and never touches the real module.
 *
 * Mirrors `search-controller.factory.ts` (the `/search` page seam, AECI-142):
 * same DI-token pattern, same `afterNextRender`-only dynamic-import discipline.
 * Unlike `/search` (full `instantsearch.js`), a header dropdown only needs the
 * query-only `liteClient`, so this loads `algoliasearch/lite` ALONE — no
 * InstantSearch core/connectors. One batched `searchForHits` returns products +
 * vendors in a single round-trip.
 *
 * SSR safety: `algoliasearch/lite` touches browser globals at module scope, so a
 * static top-level import would crash SSR. It is reached ONLY through the
 * `import()` below, which the caller (`SearchAutocomplete`) runs inside
 * `afterNextRender` — browser-only by construction.
 */
import { InjectionToken } from '@angular/core';

import type { AlgoliaProductRecord, AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

import type { AlgoliaPublicConfig } from './algolia-config';
import { mapAutocompleteResults, type AutocompleteSearchFn } from './autocomplete-mapping';

/** Suggestions shown per entity in the dropdown (kept tight for a header popup). */
const HITS_PER_ENTITY = 5;

/** The factory signature `SearchAutocomplete` calls to obtain a loaded search fn. */
export type CreateAutocompleteSearch = (config: AlgoliaPublicConfig) => Promise<AutocompleteSearchFn>;

/**
 * DI seam for the search factory. Defaults to the real dynamic-import
 * `createAutocompleteSearch`; the component injects it so unit tests can
 * substitute a fake (or never-resolving) factory and exercise the shell WITHOUT
 * loading the real SDK — the Angular unit-test runner forbids `vi.mock` on
 * relative imports, so this token is the supported override point (identical to
 * `SEARCH_ENGINE_FACTORY`).
 */
export const AUTOCOMPLETE_SEARCH_FACTORY = new InjectionToken<CreateAutocompleteSearch>(
  'AUTOCOMPLETE_SEARCH_FACTORY',
  { providedIn: 'root', factory: () => createAutocompleteSearch },
);

/**
 * Dynamically load `algoliasearch/lite` in the browser and return a query-only
 * search function bound to the public config. Each call issues ONE multi-index
 * `searchForHits` (products + vendors), narrowing `attributesToRetrieve` to the
 * fields the dropdown row needs so the payload stays small. The `as` cast lives
 * here, at the impure boundary, so `AutocompleteSearchFn` consumers stay typed.
 */
export async function createAutocompleteSearch(
  config: AlgoliaPublicConfig,
): Promise<AutocompleteSearchFn> {
  const lite = await import('algoliasearch/lite');
  const client = lite.liteClient(config.appId, config.searchKey);

  return async (query: string) => {
    const { results } = await client.searchForHits<AlgoliaProductRecord | AlgoliaVendorRecord>({
      requests: [
        {
          indexName: config.indexes.products,
          query,
          hitsPerPage: HITS_PER_ENTITY,
          attributesToRetrieve: ['objectID', 'name', 'slug', 'vendor_name'],
        },
        {
          indexName: config.indexes.vendors,
          query,
          hitsPerPage: HITS_PER_ENTITY,
          attributesToRetrieve: ['objectID', 'company_name', 'slug'],
        },
      ],
    });

    // Results come back in request order (products, then vendors). `searchForHits`
    // already narrows each result to `{ hits: Hit<T>[] }`; the per-index `as` is
    // the positional narrowing the typed-union return can't do on its own.
    const productHits = (results[0]?.hits ?? []) as AlgoliaProductRecord[];
    const vendorHits = (results[1]?.hits ?? []) as AlgoliaVendorRecord[];
    return mapAutocompleteResults(productHits, vendorHits);
  };
}
