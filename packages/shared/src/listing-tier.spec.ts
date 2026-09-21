import { describe, expect, it } from 'vitest';

import {
  listingTierField,
  productListingTier,
  vendorListingTier,
  type ProductListingTierInput,
  type VendorListingTierInput,
} from './listing-tier';

/**
 * The AECI-636 `listing_tier` rule, table by table. The firewall half (inputs are
 * content only) lives in `entitlements.spec.ts` beside the rest of the ranking
 * firewall; this file is ordinary behaviour coverage.
 */

const product: ProductListingTierInput = {
  name: 'Procore',
  description: 'Construction management.',
  categories: ['Project Management'],
  website: 'https://procore.example',
  logo_url: 'https://cdn.example/procore.png',
};

const vendor: VendorListingTierInput = {
  company_name: 'Procore Technologies',
  description: 'Construction software.',
  headquarters: 'Carpinteria, CA',
  website: 'https://procore.example',
  logo_url: 'https://cdn.example/procore.png',
};

describe('productListingTier', () => {
  it('is 2 when every input is present', () => {
    expect(productListingTier(product)).toBe(2);
  });

  it.each([
    ['categories', { categories: [] }],
    ['website', { website: null }],
    ['logo', { logo_url: null }],
    ['name', { name: '' }],
  ])('is 1 with a description and only %s missing', (_label, patch) => {
    expect(productListingTier({ ...product, ...patch })).toBe(1);
  });

  it('is 1 with a description and two of the others missing', () => {
    expect(productListingTier({ ...product, website: null, logo_url: null })).toBe(1);
  });

  it('has no tier with three of the others missing', () => {
    expect(
      productListingTier({ ...product, categories: [], website: null, logo_url: null }),
    ).toBeUndefined();
  });

  it('has no tier without a description, however complete the rest is', () => {
    expect(productListingTier({ ...product, description: null })).toBeUndefined();
  });

  it('treats blank and whitespace-only strings as missing', () => {
    expect(productListingTier({ ...product, description: '   ' })).toBeUndefined();
    expect(productListingTier({ ...product, website: ' ', logo_url: '\t' })).toBe(1);
  });

  it('treats a category list of blank names as no category', () => {
    expect(productListingTier({ ...product, categories: ['', '  '] })).toBe(1);
  });
});

describe('vendorListingTier', () => {
  it('is 2 when every input is present', () => {
    expect(vendorListingTier(vendor)).toBe(2);
  });

  it.each([
    ['headquarters', { headquarters: null }],
    ['website', { website: null }],
    ['logo', { logo_url: null }],
  ])('is 1 with a description and only %s missing', (_label, patch) => {
    expect(vendorListingTier({ ...vendor, ...patch })).toBe(1);
  });

  it('is 1 with two missing and has no tier with three missing', () => {
    expect(vendorListingTier({ ...vendor, headquarters: null, website: null })).toBe(1);
    expect(
      vendorListingTier({ ...vendor, headquarters: null, website: null, logo_url: null }),
    ).toBeUndefined();
  });

  it('has no tier without a description', () => {
    expect(vendorListingTier({ ...vendor, description: '' })).toBeUndefined();
  });
});

describe('listingTierField', () => {
  it('carries a tier as the record key', () => {
    expect(listingTierField(2)).toEqual({ listing_tier: 2 });
    expect(listingTierField(1)).toEqual({ listing_tier: 1 });
  });

  it('OMITS the key for no tier, rather than writing null or undefined', () => {
    // Algolia sorts a record that LACKS a customRanking attribute last. A present
    // null would not behave the same way, so the key must not exist at all.
    const fragment = listingTierField(undefined);
    expect(fragment).toEqual({});
    expect('listing_tier' in fragment).toBe(false);
  });
});
