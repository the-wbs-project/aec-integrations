import { Injectable, type Signal, signal } from '@angular/core';
import type { ParamMap } from '@angular/router';

import { sortReplicasFor } from '@aeci/shared/algolia';
import type { AlgoliaProductRecord, AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

import {
  BoundedHistoryStore,
  listingHistoryKey,
} from '../shared/paginated-index/listing-history-store';

import {
  facetAttributesFor,
  flattenPages,
  type IndexSnapshot,
  type IndexView,
  type SearchSnapshot,
} from './search-controller';
import { filtersFromParams, filtersToParams } from './search-url-state';

/**
 * What `/search` showed when the reader left a history entry, for Back and
 * Forward only (the AECI-1900 rule, applied to `/search`).
 *
 * Why it exists. `/search` gets its rows from Algolia only after the search
 * code loads, after the first render. So on Back the router restored the saved
 * position over a page with no rows. Measured by a reviewer: left at 3,200,
 * clamped to 1,341, landed at 3,457. Rendering what the reader left in the
 * first frame, before the search code loads, makes the page as tall as it was,
 * and the router's own restoration lands. Nothing here scrolls.
 *
 * Rules, the listing store's ({@link BoundedHistoryStore}): in memory per tab,
 * never in localStorage, sessionStorage or a cookie, the last 5 entries, 5
 * minutes old at most, one entry per history entry, and never touched on the
 * server. Read only when the page is created by a Back or Forward.
 *
 * The key ({@link searchHistoryKey}) carries the path, the query, the tab, the
 * sort and every filter and range of both tabs. The entry also records the
 * pages each tab had loaded, so "Load more" continues after them.
 */
@Injectable({ providedIn: 'root' })
export class SearchHistoryStore extends BoundedHistoryStore<SearchSnapshot> {
  /** The snapshot for `key` at history entry `entryId`, or `null`. `now` is for specs. */
  read(key: string, entryId: number | null, now: number = Date.now()): SearchSnapshot | null {
    return this.readValue(key, entryId, now);
  }

  /** Store what the page showed for history entry `entryId`. `now` is for specs. */
  write(key: string, entryId: number | null, snapshot: SearchSnapshot, now = Date.now()): void {
    this.writeValue(key, entryId, snapshot, now);
  }
}

/**
 * The store key for a `/search` URL: the path, the query as the page reads it,
 * the tab, the sort the page starts that tab on (an absent or unknown token is
 * the default), and every filter and range of both tabs in their one URL form.
 * Presentation-only params such as `?view=` are left out, as on the listings.
 */
export function searchHistoryKey(params: ParamMap): string {
  const q = params.get('q')?.trim() ?? '';
  const tab = params.get('tab') === 'vendors' ? 'vendors' : 'products';
  const replicas = sortReplicasFor(tab);
  const token = params.get('sort');
  const sort = replicas.some((r) => r.sort === token) ? token : (replicas[0]?.sort ?? '');
  const filters = JSON.stringify(filtersToParams(filtersFromParams(params)));
  return listingHistoryKey(
    '/search',
    `q=${JSON.stringify(q)} tab=${tab} sort=${sort} filters=${filters}`,
  );
}

/** What the `/search` template binds: the controller, or a restored snapshot. */
export interface SearchView {
  readonly query: Signal<string>;
  readonly stalled: Signal<boolean>;
  readonly error: Signal<boolean>;
  readonly ready: Signal<boolean>;
  readonly products: IndexView<AlgoliaProductRecord>;
  readonly vendors: IndexView<AlgoliaVendorRecord>;
}

/** A snapshot shown before the search code loads, and what the reader did meanwhile. */
export interface RestoredSearchView {
  readonly view: SearchView;
  /** Apply every action taken on `view` to the controller that replaces it. */
  replay(target: SearchView): void;
}

/**
 * A read-only {@link SearchView} over a snapshot, for the frames before the
 * search code loads. Its rows, counts and facet rows are the snapshot's, so the
 * controller that later takes over from the same snapshot draws the same thing.
 * A click in that window ("Load more", a filter, a sort) is kept and replayed on
 * the controller, so nothing the reader does is dropped.
 */
export function restoredSearchView(snapshot: SearchSnapshot): RestoredSearchView {
  const queue: ((target: SearchView) => void)[] = [];

  function index<T>(entity: 'products' | 'vendors', s: IndexSnapshot): IndexView<T> {
    const later = (action: (target: IndexView<unknown>) => void) =>
      queue.push((target) => action(target[entity]));
    const loadingMore = signal(false);
    const sortBy = signal(s.sortBy);
    const attrs = facetAttributesFor(entity);
    return {
      entity,
      hits: signal(flattenPages(s.pages) as T[]),
      nbHits: signal(s.nbHits),
      hasMore: signal(s.hasMore),
      loadingMore,
      loadMore: () => {
        if (loadingMore() || !s.hasMore) return;
        loadingMore.set(true);
        later((target) => target.loadMore());
      },
      refinementLists: attrs.refinementLists.map((attribute) => {
        const items = [...(s.refinementLists[attribute] ?? [])];
        return {
          attribute,
          items: signal(items),
          canRefine: signal(items.length > 0),
          refine: (value: string) =>
            later((target) =>
              target.refinementLists.find((rl) => rl.attribute === attribute)?.refine(value),
            ),
        };
      }),
      numericMenus: attrs.numericMenus.map((attribute) => ({
        attribute,
        items: signal([...(s.numericMenus[attribute] ?? [])]),
        refine: (value: string) =>
          later((target) =>
            target.numericMenus.find((nm) => nm.attribute === attribute)?.refine(value),
          ),
      })),
      ranges: attrs.ranges.map((attribute) => {
        const range = s.ranges[attribute];
        return {
          attribute,
          bounds: signal({ ...range?.bounds }),
          start: signal<[number | undefined, number | undefined]>(
            range ? [range.start[0], range.start[1]] : [undefined, undefined],
          ),
          canRefine: signal(false),
          refine: (values: [number | undefined, number | undefined]) =>
            later((target) =>
              target.ranges.find((rg) => rg.attribute === attribute)?.refine(values),
            ),
        };
      }),
      sortBy,
      refineSort: (indexName: string) => {
        sortBy.set(indexName);
        later((target) => target.refineSort(indexName));
      },
      sortOptions: s.sortOptions,
    };
  }

  return {
    view: {
      query: signal(snapshot.query),
      stalled: signal(false),
      error: signal(false),
      ready: signal(true),
      products: index<AlgoliaProductRecord>('products', snapshot.products),
      vendors: index<AlgoliaVendorRecord>('vendors', snapshot.vendors),
    },
    replay: (target) => {
      for (const action of queue.splice(0)) action(target);
    },
  };
}
