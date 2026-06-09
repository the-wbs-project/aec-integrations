/**
 * Unit tests for the AECI-137 Supabase-row → Algolia-record transforms. Each
 * mapper is asserted field-by-field AND validated against the shared Zod record
 * schema (`@aeci/shared/algolia-records`) — the "transform output IS a valid
 * index record" guarantee the sync pipeline (3.5/3.6) relies on.
 */

import {
  AlgoliaIntegrationRecordSchema,
  AlgoliaProductRecordSchema,
  AlgoliaVendorRecordSchema,
} from '@aeci/shared/algolia-records';
import { Prisma } from '@prisma/client/edge';
import { describe, expect, it } from 'vitest';

import {
  toAlgoliaIntegration,
  toAlgoliaProduct,
  toAlgoliaVendor,
  type RawAlgoliaIntegrationRow,
  type RawAlgoliaProductRow,
  type RawAlgoliaVendorRow,
} from './algolia-transforms';

// ---------------------------------------------------------------------------
// Fixtures (typed against the Raw* payloads so a select change breaks the build)
// ---------------------------------------------------------------------------

const productRow: RawAlgoliaProductRow = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'procore',
  name: 'Procore',
  description: 'Construction management platform.',
  logoUrl: 'https://cdn.brandfetch.io/procore.png',
  hasApiDocs: true,
  integrationCount: 342,
  reviewCount: 0,
  ratingOverallAvg: new Prisma.Decimal(4.5),
  // Primary vendor is listed SECOND to prove pickPrimaryVendor selects by
  // isPrimary, not array order.
  productVendors: [
    {
      isPrimary: false,
      vendor: { id: 'v-2', companyName: 'Reseller LLC', slug: 'reseller', logoUrl: null },
    },
    {
      isPrimary: true,
      vendor: {
        id: 'v-1',
        companyName: 'Procore Technologies',
        slug: 'procore-technologies',
        logoUrl: null,
      },
    },
  ],
  productCategories: [
    { category: { name: 'Project Management' } },
    { category: { name: 'Document Control' } },
  ],
  productAudiences: [{ audience: { name: 'Construction Management' } }],
  productPhases: [
    { phase: { name: 'Construction' } },
    { phase: { name: 'Closeout & Operations' } },
  ],
};

const vendorRow: RawAlgoliaVendorRow = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'procore-technologies',
  companyName: 'Procore Technologies',
  logoUrl: null,
  verified: true,
  headquarters: 'Carpinteria, CA',
  foundedYear: 2003,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  _count: { productVendors: 8, builtIntegrations: 412 },
  description: null,
};

const integrationRow: RawAlgoliaIntegrationRow = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Procore App',
  mechanismKind: 'native',
  mechanismName: 'Procore App',
  direction: 'bidirectional',
  sourceProduct: { id: 's-1', name: 'Procore', slug: 'procore', logoUrl: null },
  targetProduct: {
    id: 't-1',
    name: 'Autodesk Construction Cloud',
    slug: 'autodesk-construction-cloud',
    logoUrl: null,
  },
  createdAt: new Date('2024-01-01T00:00:00Z'),
  updatedAt: new Date('2024-01-01T00:00:00Z'),
  description: null,
};

// ---------------------------------------------------------------------------
// toAlgoliaProduct
// ---------------------------------------------------------------------------

describe('toAlgoliaProduct', () => {
  it('denormalizes a product into a valid §7.1 record', () => {
    const record = toAlgoliaProduct(productRow);
    expect(record).toEqual({
      objectID: '11111111-1111-4111-8111-111111111111',
      name: 'Procore',
      slug: 'procore',
      description: 'Construction management platform.',
      vendor_name: 'Procore Technologies',
      vendor_slug: 'procore-technologies',
      categories: ['Project Management', 'Document Control'],
      audiences: ['Construction Management'],
      phases: ['Construction', 'Closeout & Operations'],
      integration_count: 342,
      review_count: 0,
      rating_overall_avg: 4.5,
      has_api_docs: true,
      logo_url: 'https://cdn.brandfetch.io/procore.png',
    });
    expect(() => AlgoliaProductRecordSchema.parse(record)).not.toThrow();
  });

  it('surfaces a null vendor (no links) rather than fabricating one', () => {
    const record = toAlgoliaProduct({ ...productRow, productVendors: [] });
    expect(record.vendor_name).toBeNull();
    expect(record.vendor_slug).toBeNull();
    expect(() => AlgoliaProductRecordSchema.parse(record)).not.toThrow();
  });

  it('keeps a null rating as null (no approved reviews)', () => {
    const record = toAlgoliaProduct({ ...productRow, ratingOverallAvg: null });
    expect(record.rating_overall_avg).toBeNull();
  });

  it('emits empty taxonomy arrays when a product has no taxonomy links', () => {
    const record = toAlgoliaProduct({
      ...productRow,
      productCategories: [],
      productAudiences: [],
      productPhases: [],
    });
    expect(record.categories).toEqual([]);
    expect(record.audiences).toEqual([]);
    expect(record.phases).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toAlgoliaVendor
// ---------------------------------------------------------------------------

describe('toAlgoliaVendor', () => {
  it('denormalizes a vendor (counts from _count) into a valid §7.1 record', () => {
    const record = toAlgoliaVendor(vendorRow);
    expect(record).toEqual({
      objectID: '22222222-2222-4222-8222-222222222222',
      company_name: 'Procore Technologies',
      slug: 'procore-technologies',
      description: null,
      headquarters: 'Carpinteria, CA',
      founded_year: 2003,
      product_count: 8,
      integration_count: 412,
      logo_url: null,
    });
    expect(() => AlgoliaVendorRecordSchema.parse(record)).not.toThrow();
  });

  it('keeps null headquarters / founded_year', () => {
    const record = toAlgoliaVendor({ ...vendorRow, headquarters: null, foundedYear: null });
    expect(record.headquarters).toBeNull();
    expect(record.founded_year).toBeNull();
    expect(() => AlgoliaVendorRecordSchema.parse(record)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// toAlgoliaIntegration
// ---------------------------------------------------------------------------

describe('toAlgoliaIntegration', () => {
  it('denormalizes source/target + derives mechanism_rank into a valid §7.1 record', () => {
    const record = toAlgoliaIntegration(integrationRow);
    expect(record).toEqual({
      objectID: '33333333-3333-4333-8333-333333333333',
      source_product_name: 'Procore',
      source_product_slug: 'procore',
      target_product_name: 'Autodesk Construction Cloud',
      target_product_slug: 'autodesk-construction-cloud',
      mechanism_kind: 'native',
      mechanism_name: 'Procore App',
      direction: 'bidirectional',
      description: null,
      mechanism_rank: 6,
    });
    expect(() => AlgoliaIntegrationRecordSchema.parse(record)).not.toThrow();
  });

  it('ranks each mechanism_kind per §7.3 (native 6 … partner 1, null 0)', () => {
    const rankFor = (mechanismKind: string | null) =>
      toAlgoliaIntegration({ ...integrationRow, mechanismKind }).mechanism_rank;
    expect(rankFor('native')).toBe(6);
    expect(rankFor('marketplace-app')).toBe(5);
    expect(rankFor('iPaaS')).toBe(4);
    expect(rankFor('api')).toBe(3);
    expect(rankFor('webhook')).toBe(2);
    expect(rankFor('partner')).toBe(1);
    expect(rankFor(null)).toBe(0);
  });

  it('passes a null mechanism_kind / direction through (rank 0)', () => {
    const record = toAlgoliaIntegration({
      ...integrationRow,
      mechanismKind: null,
      direction: null,
    });
    expect(record.mechanism_kind).toBeNull();
    expect(record.direction).toBeNull();
    expect(record.mechanism_rank).toBe(0);
    expect(() => AlgoliaIntegrationRecordSchema.parse(record)).not.toThrow();
  });

  it('throws on an out-of-enum mechanism_kind (data-integrity violation, fail loud)', () => {
    expect(() => toAlgoliaIntegration({ ...integrationRow, mechanismKind: 'telepathy' })).toThrow(
      /unknown mechanism_kind/,
    );
  });
});
