import { describe, expect, it } from 'vitest';

import {
  CategoriesListResponseSchema,
  CategoryDetailSchema,
  AudienceDetailSchema,
  PhaseDetailSchema,
  TaxonomyResponseSchema,
  TaxonomyTermWithCountSchema,
} from './taxonomy';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const validTerm = {
  id: uuid(1),
  name: 'Project management',
  slug: 'project-management',
  description: 'Tools for planning, scheduling, and tracking work.',
  display_order: 10,
  product_count: 42,
};

const validProductListItem = {
  id: uuid(2),
  slug: 'procore-platform',
  name: 'Procore Platform',
  logo_url: null,
  product_role: 'application' as const,
  vendor: { id: uuid(3), name: 'Procore', slug: 'procore', logo_url: null },
  primary_category: null,
  integration_count: 12,
  review_count: 5,
  rating_overall_avg: 4.2,
  rating_onboarding_avg: 3.8,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

describe('TaxonomyTermWithCountSchema', () => {
  it('parses a valid term', () => {
    const parsed = TaxonomyTermWithCountSchema.parse(validTerm);
    expect(parsed.product_count).toBe(42);
  });

  it('accepts a null description', () => {
    const parsed = TaxonomyTermWithCountSchema.parse({ ...validTerm, description: null });
    expect(parsed.description).toBeNull();
  });

  it('rejects a negative product_count', () => {
    const result = TaxonomyTermWithCountSchema.safeParse({
      ...validTerm,
      product_count: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer display_order', () => {
    const result = TaxonomyTermWithCountSchema.safeParse({
      ...validTerm,
      display_order: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('CategoryDetailSchema / AudienceDetailSchema / PhaseDetailSchema', () => {
  it('parse with an empty products array', () => {
    const detail = { ...validTerm, products: [] };
    expect(CategoryDetailSchema.parse(detail).products).toEqual([]);
    expect(AudienceDetailSchema.parse(detail).products).toEqual([]);
    expect(PhaseDetailSchema.parse(detail).products).toEqual([]);
  });

  it('parse with hydrated products', () => {
    const detail = { ...validTerm, products: [validProductListItem] };
    expect(CategoryDetailSchema.parse(detail).products).toHaveLength(1);
  });

  it('reject when products is missing', () => {
    const result = CategoryDetailSchema.safeParse(validTerm);
    expect(result.success).toBe(false);
  });
});

describe('TaxonomyResponseSchema', () => {
  it('parses categories, audiences, and phases together', () => {
    const parsed = TaxonomyResponseSchema.parse({
      categories: [validTerm],
      audiences: [validTerm],
      phases: [validTerm],
    });
    expect(parsed.categories).toHaveLength(1);
    expect(parsed.audiences).toHaveLength(1);
    expect(parsed.phases).toHaveLength(1);
  });

  it('rejects when a list is missing', () => {
    const result = TaxonomyResponseSchema.safeParse({
      categories: [],
      audiences: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('CategoriesListResponseSchema', () => {
  it('parses a flat list', () => {
    const parsed = CategoriesListResponseSchema.parse({ data: [validTerm] });
    expect(parsed.data).toHaveLength(1);
  });
});
