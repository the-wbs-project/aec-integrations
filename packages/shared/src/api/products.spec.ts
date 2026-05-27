import { describe, expect, it } from 'vitest';

import {
  ProductDetailSchema,
  ProductListItemSchema,
  ProductSortSchema,
  ProductsListQuerySchema,
  ProductsListResponseSchema,
} from './products';

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

describe('ProductListItemSchema', () => {
  it('parses a fully hydrated list item', () => {
    const parsed = ProductListItemSchema.parse(validListItem);
    expect(parsed.vendor.slug).toBe('procore');
    expect(parsed.rating_overall_avg).toBe(4.2);
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
      disciplines: [],
      phases: [],
      integrations_as_source: [],
      integrations_as_target: [],
      related_products: [],
    });
    expect(parsed.has_api_docs).toBe(false);
    expect(parsed.related_products).toEqual([]);
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
      disciplines: [{ id: uuid(4), name: 'Construction', slug: 'construction' }],
      phases: [{ id: uuid(5), name: 'Construction', slug: 'construction-phase' }],
      integrations_as_source: [],
      integrations_as_target: [],
      related_products: [validListItem],
    });
    expect(parsed.categories).toHaveLength(1);
    expect(parsed.related_products).toHaveLength(1);
  });

  it('rejects when has_api_docs is missing', () => {
    const result = ProductDetailSchema.safeParse({
      ...validListItem,
      description: null,
      website: null,
      tool_integrations_url: null,
      api_docs_url: null,
      categories: [],
      disciplines: [],
      phases: [],
      integrations_as_source: [],
      integrations_as_target: [],
      related_products: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('ProductSortSchema', () => {
  it('defaults to created', () => {
    expect(ProductSortSchema.parse(undefined)).toBe('created');
  });

  it('accepts each documented key', () => {
    expect(ProductSortSchema.parse('created')).toBe('created');
    expect(ProductSortSchema.parse('name')).toBe('name');
    expect(ProductSortSchema.parse('updated')).toBe('updated');
  });

  it('rejects unknown keys', () => {
    expect(ProductSortSchema.safeParse('rating').success).toBe(false);
  });
});

describe('ProductsListQuerySchema', () => {
  it('applies pagination + sort defaults when called with empty params', () => {
    const parsed = ProductsListQuerySchema.parse({});
    expect(parsed.page).toBe(1);
    expect(parsed.perPage).toBe(24);
    expect(parsed.sort).toBe('created');
  });

  it('accepts every filter and coerces has_api_docs', () => {
    const parsed = ProductsListQuerySchema.parse({
      page: '2',
      perPage: '12',
      sort: 'name',
      search: 'procore',
      category_id: uuid(6),
      discipline_id: uuid(7),
      phase_id: uuid(8),
      vendor_id: uuid(9),
      product_role: 'connector',
      has_api_docs: 'true',
    });
    expect(parsed.page).toBe(2);
    expect(parsed.sort).toBe('name');
    expect(parsed.has_api_docs).toBe(true);
  });

  it('rejects a non-UUID vendor_id', () => {
    const result = ProductsListQuerySchema.safeParse({ vendor_id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects perPage > 100', () => {
    const result = ProductsListQuerySchema.safeParse({ perPage: 200 });
    expect(result.success).toBe(false);
  });
});

describe('ProductsListResponseSchema', () => {
  it('wraps a page of list items', () => {
    const parsed = ProductsListResponseSchema.parse({
      data: [validListItem],
      page: 1,
      perPage: 24,
      total: 1,
    });
    expect(parsed.data).toHaveLength(1);
  });

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
