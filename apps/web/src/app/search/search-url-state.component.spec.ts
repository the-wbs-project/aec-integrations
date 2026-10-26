import { convertToParamMap } from '@angular/router';
import { describe, expect, it } from 'vitest';

import {
  emptyFilters,
  filtersFromParams,
  filtersFromUiState,
  filtersToParams,
  sameFilters,
} from './search-url-state';

describe('search URL filter state', () => {
  it('reads repeated list params, menus and v_-prefixed vendor params', () => {
    const filters = filtersFromParams(
      convertToParamMap({
        categories: ['Scheduling', 'Accounting & ERP'],
        integration_count: '1:10',
        v_integration_count: '51:',
        v_founded_year: '2000:2010',
      }),
    );
    expect(filters.products.refinementList).toEqual({
      categories: ['Accounting & ERP', 'Scheduling'],
    });
    expect(filters.products.numericMenu).toEqual({ integration_count: '1:10' });
    expect(filters.vendors.numericMenu).toEqual({ integration_count: '51:' });
    expect(filters.vendors.range).toEqual({ founded_year: '2000:2010' });
  });

  it('ignores params no tab facets on, and malformed numbers', () => {
    const filters = filtersFromParams(
      convertToParamMap({ headquarters: 'Paris', integration_count: 'lots', q: 'revit' }),
    );
    expect(sameFilters(filters, emptyFilters())).toBe(true);
  });

  it('writes every known param, null when unset, so a merge clears removed filters', () => {
    const params = filtersToParams({
      ...emptyFilters(),
      products: { refinementList: { trades: ['Roofing'] }, numericMenu: {}, range: {} },
    });
    expect(params['trades']).toEqual(['Roofing']);
    expect(params['categories']).toBeNull();
    expect(params['integration_count']).toBeNull();
    expect(params['v_founded_year']).toBeNull();
  });

  it('round-trips through the URL unchanged', () => {
    const filters = filtersFromUiState({
      products: {
        refinementList: { categories: ['B', 'A'], phases: [] },
        numericMenu: { integration_count: '0' },
        query: 'revit',
        page: 2,
      },
      vendors: { range: { founded_year: ':1990' } },
    });
    const params = filtersToParams(filters);
    const back = filtersFromParams(
      convertToParamMap(
        Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null)) as Record<
          string,
          string | string[]
        >,
      ),
    );
    expect(sameFilters(back, filters)).toBe(true);
    expect(back.products.refinementList).toEqual({ categories: ['A', 'B'] });
  });

  it('treats value order as irrelevant', () => {
    const a = filtersFromUiState({ products: { refinementList: { categories: ['A', 'B'] } } });
    const b = filtersFromUiState({ products: { refinementList: { categories: ['B', 'A'] } } });
    expect(sameFilters(a, b)).toBe(true);
  });
});
