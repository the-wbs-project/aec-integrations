import type { ParamMap } from '@angular/router';

import { compareText } from '@aeci/shared/text-sort';

import { facetAttributesFor } from './search-controller';

/**
 * `/search` filters in the URL (2026-10-26), so a reload, the Back button or a
 * shared link keeps them, as `/products` does with its filters.
 *
 * The shape is InstantSearch's own per-index UI state, so the controller hands
 * it to `initialUiState` / `setUiState` unchanged:
 *   - refinement lists: one repeated param per value, `?categories=A&categories=B`.
 *     Repeated rather than comma-joined, because facet values are free text.
 *   - numeric menus and ranges: InstantSearch's string, `min:max` with either
 *     side empty (`?integration_count=1:10`, `?v_founded_year=2000:`), or one
 *     number for an exact bucket (`?integration_count=0`).
 *
 * Products filters use the bare attribute name. Vendors filters take a `v_`
 * prefix, because both tabs facet on `integration_count`. Only attributes a tab
 * actually facets on are read, so a hand-edited junk param is ignored.
 */
export type SearchTab = 'products' | 'vendors';

export interface TabFilters {
  readonly refinementList: Readonly<Record<string, readonly string[]>>;
  readonly numericMenu: Readonly<Record<string, string>>;
  readonly range: Readonly<Record<string, string>>;
}

export type SearchFilters = Readonly<Record<SearchTab, TabFilters>>;

const TABS: readonly SearchTab[] = ['products', 'vendors'];

/** The URL param for a tab's facet attribute. */
export function filterParamName(tab: SearchTab, attribute: string): string {
  return tab === 'vendors' ? `v_${attribute}` : attribute;
}

export function emptyFilters(): SearchFilters {
  return {
    products: { refinementList: {}, numericMenu: {}, range: {} },
    vendors: { refinementList: {}, numericMenu: {}, range: {} },
  };
}

/** Read the filters from the query params. Unknown params are ignored. */
export function filtersFromParams(params: ParamMap): SearchFilters {
  const out = emptyFilters() as Record<SearchTab, TabFilters>;
  for (const tab of TABS) {
    const attrs = facetAttributesFor(tab);
    const refinementList: Record<string, string[]> = {};
    const numericMenu: Record<string, string> = {};
    const range: Record<string, string> = {};
    for (const attribute of attrs.refinementLists) {
      const values = params.getAll(filterParamName(tab, attribute)).filter((v) => v !== '');
      if (values.length > 0) refinementList[attribute] = sortedUnique(values);
    }
    for (const attribute of attrs.numericMenus) {
      const value = params.get(filterParamName(tab, attribute));
      if (value && isNumericToken(value) && value !== ':') numericMenu[attribute] = value;
    }
    for (const attribute of attrs.ranges) {
      const value = params.get(filterParamName(tab, attribute));
      if (value && isNumericToken(value) && value !== ':') range[attribute] = value;
    }
    out[tab] = { refinementList, numericMenu, range };
  }
  return out;
}

/**
 * The query params for a filter state. Every attribute either tab facets on is
 * present, as `null` when unset, so a `merge` navigation clears a filter that
 * was removed.
 */
export function filtersToParams(filters: SearchFilters): Record<string, string | string[] | null> {
  const params: Record<string, string | string[] | null> = {};
  for (const tab of TABS) {
    const attrs = facetAttributesFor(tab);
    const tabFilters = filters[tab];
    for (const attribute of attrs.refinementLists) {
      const values = tabFilters.refinementList[attribute] ?? [];
      params[filterParamName(tab, attribute)] = values.length > 0 ? sortedUnique(values) : null;
    }
    for (const attribute of attrs.numericMenus) {
      params[filterParamName(tab, attribute)] = tabFilters.numericMenu[attribute] || null;
    }
    for (const attribute of attrs.ranges) {
      params[filterParamName(tab, attribute)] = tabFilters.range[attribute] || null;
    }
  }
  return params;
}

/**
 * Pull the filter part out of an InstantSearch UI state (keyed by index id),
 * dropping the empty values InstantSearch leaves behind.
 */
export function filtersFromUiState(uiState: Readonly<Record<string, unknown>>): SearchFilters {
  const out = emptyFilters() as Record<SearchTab, TabFilters>;
  for (const tab of TABS) {
    const index = (uiState[tab] ?? {}) as {
      refinementList?: Record<string, string[] | undefined>;
      numericMenu?: Record<string, string | undefined>;
      range?: Record<string, string | undefined>;
    };
    const refinementList: Record<string, string[]> = {};
    for (const [attribute, values] of Object.entries(index.refinementList ?? {})) {
      if (values && values.length > 0) refinementList[attribute] = sortedUnique(values);
    }
    out[tab] = {
      refinementList,
      numericMenu: compact(index.numericMenu),
      range: compact(index.range),
    };
  }
  return out;
}

/** Whether two filter states select the same thing (value order ignored). */
export function sameFilters(a: SearchFilters, b: SearchFilters): boolean {
  return JSON.stringify(filtersToParams(a)) === JSON.stringify(filtersToParams(b));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function compact(record: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (value && value !== ':') out[key] = value;
  }
  return out;
}

/** `min:max` with either side empty, or a single number. Never NaN text. */
function isNumericToken(value: string): boolean {
  return /^-?\d*(\.\d+)?(:-?\d*(\.\d+)?)?$/.test(value);
}
