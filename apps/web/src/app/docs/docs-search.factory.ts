/**
 * The one impure seam of the docs search box (AECI-1270): the dynamic
 * `import()` of `algoliasearch/lite`. Modelled on
 * `AUTOCOMPLETE_SEARCH_FACTORY` (`app/search/autocomplete-search.factory.ts`):
 * the same DI-token pattern, and the same rule that the SDK is reached only
 * from `afterNextRender`, so it never enters the SSR bundle. This file is
 * imported only by the docs shell, so the lite client loads only in the lazy
 * `/docs` chunk, and only when the config is present.
 *
 * One `searchForHits` per query, on the tier's docs index, filtered to the
 * current guide (`guide:help` or `guide:vendor`), eight hits.
 */
import { InjectionToken } from '@angular/core';

import type { DocsSearchConfig } from '../search/algolia-config';
import {
  DOCS_HIGHLIGHT_POST,
  DOCS_HIGHLIGHT_PRE,
  type DocsSearchFn,
  type DocsSearchRawHit,
  docsGuideFilter,
  mapDocsSearchHits,
} from './docs-search-hits';

/** Rows per query. */
export const DOCS_SEARCH_HITS = 8;

/** The factory the box calls to get a loaded search function. */
export type CreateDocsSearch = (config: DocsSearchConfig) => Promise<DocsSearchFn>;

/**
 * DI seam for the factory. Specs provide a fake, because the Angular test
 * runner forbids `vi.mock` on relative imports (same as
 * `AUTOCOMPLETE_SEARCH_FACTORY`).
 */
export const DOCS_SEARCH_FACTORY = new InjectionToken<CreateDocsSearch>('DOCS_SEARCH_FACTORY', {
  providedIn: 'root',
  factory: () => createDocsSearch,
});

/** Loads `algoliasearch/lite` in the browser and binds a search to the docs index. */
export async function createDocsSearch(config: DocsSearchConfig): Promise<DocsSearchFn> {
  const lite = await import('algoliasearch/lite');
  const client = lite.liteClient(config.appId, config.searchKey);

  return async (query, guide) => {
    const { results } = await client.searchForHits<DocsSearchRawHit>({
      requests: [
        {
          indexName: config.docsIndex,
          query,
          filters: docsGuideFilter(guide),
          hitsPerPage: DOCS_SEARCH_HITS,
          attributesToRetrieve: ['objectID', 'url', 'section', 'page_title', 'heading'],
          attributesToHighlight: ['heading'],
          attributesToSnippet: ['content:24'],
          highlightPreTag: DOCS_HIGHLIGHT_PRE,
          highlightPostTag: DOCS_HIGHLIGHT_POST,
        },
      ],
    });
    return mapDocsSearchHits((results[0]?.hits ?? []) as DocsSearchRawHit[]);
  };
}
