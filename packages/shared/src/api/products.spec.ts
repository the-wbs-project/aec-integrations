import { describe, expect, it } from 'vitest';

import {
  ProductDetailSchema,
  ProductListItemSchema,
  ProductSortSchema,
  ProductsListQuerySchema,
  ProductsListResponseSchema,
  ProductUsefulnessSchema,
  UsefulnessGroupSchema,
} from './products';
import { registerSchemaStructuralCases } from './schema-suite.harness';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const validVendorLink = {
  id: uuid(1),
  name: 'Procore',
  slug: 'procore',
  logo_url: 'https://cdn.example.com/procore.png',
};

const validPrimaryCategory = {
  id: uuid(10),
  name: 'Project management',
  slug: 'project-management',
};

const validListItem = {
  id: uuid(2),
  slug: 'procore-platform',
  name: 'Procore Platform',
  logo_url: null,
  product_role: 'application' as const,
  vendor: validVendorLink,
  primary_category: validPrimaryCategory,
  integration_count: 12,
  review_count: 5,
  rating_overall_avg: 4.2,
  rating_onboarding_avg: 3.8,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

// SortSchema defaults/unknown-key, ListQuery pagination defaults + perPage cap,
// and ListResponse page-wrap are structural — shared via the harness (AECI-113).
registerSchemaStructuralCases({
  entity: 'products',
  sortSchema: ProductSortSchema,
  sortDefault: 'created',
  listQuerySchema: ProductsListQuerySchema,
  listResponseSchema: ProductsListResponseSchema,
  validListItem,
});

describe('ProductListItemSchema', () => {
  it('parses a fully hydrated list item', () => {
    const parsed = ProductListItemSchema.parse(validListItem);
    expect(parsed.vendor?.slug).toBe('procore');
    expect(parsed.rating_overall_avg).toBe(4.2);
  });

  it('accepts null vendor (product with no vendor links — AECI-115)', () => {
    const parsed = ProductListItemSchema.parse({
      ...validListItem,
      vendor: null,
    });
    expect(parsed.vendor).toBeNull();
  });

  it('accepts null ratings (no reviews yet)', () => {
    const parsed = ProductListItemSchema.parse({
      ...validListItem,
      rating_overall_avg: null,
      rating_onboarding_avg: null,
    });
    expect(parsed.rating_overall_avg).toBeNull();
  });

  it('rejects negative integration_count', () => {
    const result = ProductListItemSchema.safeParse({
      ...validListItem,
      integration_count: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown product_role', () => {
    const result = ProductListItemSchema.safeParse({
      ...validListItem,
      product_role: 'unknown',
    });
    expect(result.success).toBe(false);
  });

  it('accepts null primary_category (product with no category links)', () => {
    const parsed = ProductListItemSchema.parse({
      ...validListItem,
      primary_category: null,
    });
    expect(parsed.primary_category).toBeNull();
  });

  it('rejects when primary_category is missing', () => {
    const item: Record<string, unknown> = { ...validListItem };
    delete item.primary_category;
    const result = ProductListItemSchema.safeParse(item);
    expect(result.success).toBe(false);
  });
});

describe('ProductDetailSchema', () => {
  it('parses a detail with empty relations', () => {
    const parsed = ProductDetailSchema.parse({
      ...validListItem,
      description: null,
      website: null,
      tool_integrations_url: null,
      api_docs_url: null,
      has_api_docs: false,
      categories: [],
      audiences: [],
      phases: [],
      usefulness: null,
      integrations_as_source: [],
      integrations_as_target: [],
      related_products: [],
      reviews: [],
    });
    expect(parsed.has_api_docs).toBe(false);
    expect(parsed.related_products).toEqual([]);
    expect(parsed.usefulness).toBeNull();
    expect(parsed.reviews).toEqual([]);
  });

  it('parses a detail with hydrated taxonomy and related products', () => {
    const parsed = ProductDetailSchema.parse({
      ...validListItem,
      description: 'Construction management platform.',
      website: 'https://procore.com',
      tool_integrations_url: null,
      api_docs_url: 'https://developers.procore.com',
      has_api_docs: true,
      categories: [{ id: uuid(3), name: 'Project management', slug: 'project-management' }],
      audiences: [{ id: uuid(4), name: 'Construction', slug: 'construction' }],
      phases: [{ id: uuid(5), name: 'Construction', slug: 'construction-phase' }],
      usefulness: {
        audiences: [
          {
            slug: 'construction',
            name: 'Construction',
            points: ['Track RFIs across the project.'],
          },
        ],
        phases: [],
      },
      integrations_as_source: [],
      integrations_as_target: [],
      related_products: [validListItem],
      reviews: [
        {
          id: uuid(6),
          rating_overall: 5,
          rating_onboarding: 4,
          title: 'Solid rollout',
          body: 'Onboarding took about a day. Stable since, and the field team uses it daily.',
          role_at_company: 'practitioner',
          years_using: 3,
          would_recommend: 'yes',
          verified_work_email: true,
          created_at: '2024-06-10T00:00:00.000Z',
        },
      ],
    });
    expect(parsed.categories).toHaveLength(1);
    expect(parsed.reviews).toHaveLength(1);
    expect(parsed.related_products).toHaveLength(1);
    expect(parsed.usefulness?.audiences[0]?.points).toEqual(['Track RFIs across the project.']);
    expect(parsed.usefulness?.phases).toEqual([]);
  });

  it('rejects when has_api_docs is missing', () => {
    const result = ProductDetailSchema.safeParse({
      ...validListItem,
      description: null,
      website: null,
      tool_integrations_url: null,
      api_docs_url: null,
      categories: [],
      audiences: [],
      phases: [],
      usefulness: null,
      integrations_as_source: [],
      integrations_as_target: [],
      related_products: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('ProductUsefulnessSchema / UsefulnessGroupSchema', () => {
  const validGroup = {
    slug: 'architecture',
    name: 'Architecture',
    points: ['Coordinate models across disciplines.', 'Resolve clashes before site.'],
  };

  it('parses a fully populated usefulness payload', () => {
    const parsed = ProductUsefulnessSchema.parse({
      audiences: [validGroup],
      phases: [{ slug: 'design', name: 'Design', points: ['Iterate options early.'] }],
    });
    expect(parsed.audiences[0]?.points).toHaveLength(2);
    expect(parsed.phases[0]?.slug).toBe('design');
  });

  it('accepts empty facet arrays (source had nothing for a facet)', () => {
    const parsed = ProductUsefulnessSchema.parse({ audiences: [], phases: [] });
    expect(parsed.audiences).toEqual([]);
    expect(parsed.phases).toEqual([]);
  });

  it('rejects a group with no points (min 1)', () => {
    const result = UsefulnessGroupSchema.safeParse({ ...validGroup, points: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a group with an empty-string point', () => {
    const result = UsefulnessGroupSchema.safeParse({ ...validGroup, points: [''] });
    expect(result.success).toBe(false);
  });

  it('rejects a group with an empty slug or name', () => {
    expect(UsefulnessGroupSchema.safeParse({ ...validGroup, slug: '' }).success).toBe(false);
    expect(UsefulnessGroupSchema.safeParse({ ...validGroup, name: '' }).success).toBe(false);
  });
});

describe('ProductSortSchema', () => {
  it('accepts each documented key', () => {
    expect(ProductSortSchema.parse('created')).toBe('created');
    expect(ProductSortSchema.parse('name')).toBe('name');
    expect(ProductSortSchema.parse('updated')).toBe('updated');
    expect(ProductSortSchema.parse('rating')).toBe('rating');
    expect(ProductSortSchema.parse('reviews')).toBe('reviews');
  });
});

describe('ProductsListQuerySchema', () => {
  it('accepts every filter and coerces has_api_docs', () => {
    const parsed = ProductsListQuerySchema.parse({
      page: '2',
      perPage: '12',
      sort: 'name',
      search: 'procore',
      category_id: uuid(6),
      audience_id: uuid(7),
      phase_id: uuid(8),
      vendor_id: uuid(9),
      product_role: 'connector',
      has_api_docs: 'true',
    });
    expect(parsed.page).toBe(2);
    expect(parsed.sort).toBe('name');
    expect(parsed.has_api_docs).toBe(true);
  });

  it('decodes a single taxonomy id to a one-element list (AECI-223)', () => {
    const parsed = ProductsListQuerySchema.parse({ category_id: uuid(6) });
    expect(parsed.category_id).toEqual([uuid(6)]);
  });

  it('decodes a comma-separated taxonomy id list to an array, preserving order', () => {
    const parsed = ProductsListQuerySchema.parse({
      category_id: `${uuid(2)},${uuid(1)}`,
      audience_id: `${uuid(7)},${uuid(8)},${uuid(9)}`,
    });
    expect(parsed.category_id).toEqual([uuid(2), uuid(1)]);
    expect(parsed.audience_id).toEqual([uuid(7), uuid(8), uuid(9)]);
  });

  it('trims whitespace and drops empty segments in a taxonomy id list', () => {
    const parsed = ProductsListQuerySchema.parse({ category_id: ` ${uuid(1)} , ${uuid(2)} ,` });
    expect(parsed.category_id).toEqual([uuid(1), uuid(2)]);
  });

  it('rejects a taxonomy id list with any non-UUID element', () => {
    const result = ProductsListQuerySchema.safeParse({ category_id: `${uuid(1)},not-a-uuid` });
    expect(result.success).toBe(false);
  });

  it('rejects an empty taxonomy id param (no valid ids)', () => {
    expect(ProductsListQuerySchema.safeParse({ category_id: '' }).success).toBe(false);
    expect(ProductsListQuerySchema.safeParse({ category_id: ',' }).success).toBe(false);
  });

  it('keeps vendor_id single — rejects a non-UUID, and does not split a CSV', () => {
    expect(ProductsListQuerySchema.safeParse({ vendor_id: 'not-a-uuid' }).success).toBe(false);
    expect(ProductsListQuerySchema.safeParse({ vendor_id: `${uuid(1)},${uuid(2)}` }).success).toBe(
      false,
    );
  });
});

describe('ProductsListResponseSchema', () => {
  it('rejects when an item fails the inner schema', () => {
    const result = ProductsListResponseSchema.safeParse({
      data: [{ ...validListItem, product_role: 'unknown' }],
      page: 1,
      perPage: 24,
      total: 1,
    });
    expect(result.success).toBe(false);
  });
});
