import { describe, expect, it } from 'vitest';

import {
  VendorDetailSchema,
  VendorListItemSchema,
  VendorSortSchema,
  VendorsListQuerySchema,
  VendorsListResponseSchema,
} from './vendors';
import { registerSchemaStructuralCases } from './schema-suite.harness';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const validVendorListItem = {
  id: uuid(1),
  slug: 'procore',
  company_name: 'Procore Technologies',
  logo_url: null,
  verified: true,
  headquarters: 'Carpinteria, CA',
  founded_year: 2002,
  product_count: 3,
  integration_count: 12,
  review_count: 5,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

const validProductListItem = {
  id: uuid(2),
  slug: 'procore-platform',
  name: 'Procore Platform',
  logo_url: null,
  product_role: 'application' as const,
  vendor: {
    id: uuid(1),
    name: 'Procore Technologies',
    slug: 'procore',
    logo_url: null,
  },
  primary_category: null,
  integration_count: 12,
  review_count: 5,
  rating_overall_avg: 4.2,
  rating_onboarding_avg: 3.8,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

// Structural cases (sort defaults/unknown-key, pagination defaults + perPage cap,
// response page-wrap) are shared via the harness (AECI-113).
registerSchemaStructuralCases({
  entity: 'vendors',
  sortSchema: VendorSortSchema,
  sortDefault: 'created',
  listQuerySchema: VendorsListQuerySchema,
  listResponseSchema: VendorsListResponseSchema,
  validListItem: validVendorListItem,
});

describe('VendorListItemSchema', () => {
  it('parses a valid list item', () => {
    const parsed = VendorListItemSchema.parse(validVendorListItem);
    expect(parsed.company_name).toBe('Procore Technologies');
    expect(parsed.verified).toBe(true);
  });

  it('rejects an empty company_name', () => {
    const result = VendorListItemSchema.safeParse({
      ...validVendorListItem,
      company_name: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative product_count', () => {
    const result = VendorListItemSchema.safeParse({
      ...validVendorListItem,
      product_count: -1,
    });
    expect(result.success).toBe(false);
  });

  it('accepts nullable headquarters and founded_year', () => {
    const parsed = VendorListItemSchema.parse({
      ...validVendorListItem,
      headquarters: null,
      founded_year: null,
    });
    expect(parsed.headquarters).toBeNull();
    expect(parsed.founded_year).toBeNull();
  });

  it('rejects a non-integer founded_year', () => {
    const result = VendorListItemSchema.safeParse({
      ...validVendorListItem,
      founded_year: 2002.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('VendorDetailSchema', () => {
  it('parses a detail with empty products list', () => {
    const parsed = VendorDetailSchema.parse({
      ...validVendorListItem,
      headquarters: null,
      founded_year: null,
      description: null,
      website: null,
      linkedin_url: null,
      x_url: null,
      facebook_url: null,
      instagram_url: null,
      youtube_url: null,
      products: [],
    });
    expect(parsed.products).toEqual([]);
  });

  it('parses a detail with hydrated products and social links', () => {
    const parsed = VendorDetailSchema.parse({
      ...validVendorListItem,
      description: 'Construction tech vendor.',
      website: 'https://procore.com',
      linkedin_url: 'https://www.linkedin.com/company/procore-technologies',
      x_url: 'https://x.com/procoretech',
      facebook_url: 'https://www.facebook.com/procoretech',
      instagram_url: 'https://www.instagram.com/procoretech',
      youtube_url: 'https://www.youtube.com/@procoretechnologies',
      products: [validProductListItem],
    });
    expect(parsed.products).toHaveLength(1);
    expect(parsed.founded_year).toBe(2002);
    expect(parsed.headquarters).toBe('Carpinteria, CA');
    expect(parsed.linkedin_url).toBe('https://www.linkedin.com/company/procore-technologies');
    expect(parsed.x_url).toBe('https://x.com/procoretech');
    expect(parsed.youtube_url).toBe('https://www.youtube.com/@procoretechnologies');
  });

  it('rejects a non-URL social link', () => {
    const result = VendorDetailSchema.safeParse({
      ...validVendorListItem,
      description: null,
      website: null,
      linkedin_url: 'not-a-url',
      x_url: null,
      facebook_url: null,
      instagram_url: null,
      youtube_url: null,
      products: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('VendorsListQuerySchema', () => {
  it('coerces verified=true from a string', () => {
    const parsed = VendorsListQuerySchema.parse({ verified: 'true' });
    expect(parsed.verified).toBe(true);
  });
});
