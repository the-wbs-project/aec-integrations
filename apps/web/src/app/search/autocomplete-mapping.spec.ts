import { describe, expect, it } from 'vitest';

import type { AlgoliaProductRecord, AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

import {
  mapAutocompleteResults,
  productToSuggestion,
  vendorToSuggestion,
} from './autocomplete-mapping';

function product(overrides: Partial<AlgoliaProductRecord> = {}): AlgoliaProductRecord {
  return {
    objectID: '11111111-1111-1111-1111-111111111111',
    name: 'Procore',
    slug: 'procore',
    description: null,
    vendor_name: 'Procore Technologies',
    vendor_slug: 'procore-technologies',
    categories: [],
    audiences: [],
    phases: [],
    trades: [],
    trade_aliases: [],
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    has_api_docs: false,
    logo_url: null,
    ...overrides,
  };
}

function vendor(overrides: Partial<AlgoliaVendorRecord> = {}): AlgoliaVendorRecord {
  return {
    objectID: '22222222-2222-2222-2222-222222222222',
    company_name: 'Autodesk',
    slug: 'autodesk',
    description: null,
    headquarters: null,
    founded_year: null,
    product_count: 0,
    integration_count: 0,
    logo_url: null,
    ...overrides,
  };
}

describe('productToSuggestion', () => {
  it('maps name → title, vendor_name → subtitle, links to /products/:slug', () => {
    expect(productToSuggestion(product())).toEqual({
      kind: 'product',
      objectID: '11111111-1111-1111-1111-111111111111',
      title: 'Procore',
      subtitle: 'Procore Technologies',
      routerLink: ['/products', 'procore'],
    });
  });

  it('keeps subtitle null when the product has no vendor', () => {
    expect(productToSuggestion(product({ vendor_name: null })).subtitle).toBeNull();
  });
});

describe('vendorToSuggestion', () => {
  it('maps company_name → title, null subtitle, links to /vendors/:slug', () => {
    expect(vendorToSuggestion(vendor())).toEqual({
      kind: 'vendor',
      objectID: '22222222-2222-2222-2222-222222222222',
      title: 'Autodesk',
      subtitle: null,
      routerLink: ['/vendors', 'autodesk'],
    });
  });
});

describe('mapAutocompleteResults', () => {
  it('splits the two positional hit slices into product + vendor suggestions', () => {
    const result = mapAutocompleteResults(
      [product({ slug: 'a' }), product({ objectID: 'p2', slug: 'b' })],
      [vendor({ slug: 'v' })],
    );
    expect(result.products.map((s) => s.routerLink)).toEqual([
      ['/products', 'a'],
      ['/products', 'b'],
    ]);
    expect(result.products.every((s) => s.kind === 'product')).toBe(true);
    expect(result.vendors).toHaveLength(1);
    expect(result.vendors[0].kind).toBe('vendor');
  });

  it('returns empty lists for empty inputs', () => {
    expect(mapAutocompleteResults([], [])).toEqual({ products: [], vendors: [] });
  });
});
