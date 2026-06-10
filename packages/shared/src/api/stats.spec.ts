import { describe, expect, it } from 'vitest';

import {
  HomeStatsResponseSchema,
  MostActiveCategorySchema,
  MostIntegratedProductSchema,
  ProductRefSchema,
  STATS_CACHE_KEYS,
  StatsCacheKeySchema,
  statsCacheValueSchemas,
  TaxonomyCountsSchema,
  TaxonomyRefSchema,
} from './stats';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const validProductLink = {
  id: uuid(1),
  name: 'Procore Platform',
  slug: 'procore-platform',
  logo_url: 'https://cdn.example.com/procore.png',
};

const validLinkRef = {
  id: uuid(2),
  name: 'Project management',
  slug: 'project-management',
};

const validTerm = {
  ...validLinkRef,
  description: 'Tools for planning, scheduling, and tracking work.',
  display_order: 10,
  product_count: 42,
};

const validProductListItem = {
  id: uuid(3),
  slug: 'autodesk-construction-cloud',
  name: 'Autodesk Construction Cloud',
  logo_url: null,
  product_role: 'application' as const,
  vendor: { id: uuid(4), name: 'Autodesk', slug: 'autodesk', logo_url: null },
  primary_category: validLinkRef,
  integration_count: 12,
  review_count: 5,
  rating_overall_avg: 4.2,
  rating_onboarding_avg: 3.8,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

const validIntegrationListItem = {
  id: uuid(5),
  name: 'Procore → BIM 360',
  mechanism_kind: 'native' as const,
  mechanism_name: 'Procore + Autodesk Build',
  direction: 'bidirectional' as const,
  source: validProductLink,
  target: { id: uuid(6), name: 'BIM 360', slug: 'bim-360', logo_url: null },
  created_at: '2026-01-03T00:00:00.000Z',
  updated_at: '2026-01-04T00:00:00.000Z',
};

const validHomeStats = {
  total_integrations: 128,
  integrations_added_30d: 9,
  most_integrated_product: { product: validProductLink, integration_count: 37 },
  most_active_category: { category: validLinkRef, integration_count: 64 },
  recent_integrations: [validIntegrationListItem],
  trending_products: [validProductListItem],
  recently_added_products: [validProductListItem],
};

describe('HomeStatsResponseSchema', () => {
  it('round-trips a fully populated payload', () => {
    const parsed = HomeStatsResponseSchema.parse(validHomeStats);
    expect(parsed.total_integrations).toBe(128);
    expect(parsed.most_integrated_product?.product.slug).toBe('procore-platform');
    expect(parsed.most_active_category?.integration_count).toBe(64);
    expect(parsed.recent_integrations[0]?.source.slug).toBe('procore-platform');
    expect(parsed.trending_products).toHaveLength(1);
  });

  it('accepts empty arrays (cold cache, nothing computed yet)', () => {
    const parsed = HomeStatsResponseSchema.parse({
      ...validHomeStats,
      recent_integrations: [],
      trending_products: [],
      recently_added_products: [],
    });
    expect(parsed.recent_integrations).toEqual([]);
  });

  it('accepts null for the two single-card fields (sparse cache, no data yet)', () => {
    const parsed = HomeStatsResponseSchema.parse({
      ...validHomeStats,
      most_integrated_product: null,
      most_active_category: null,
    });
    expect(parsed.most_integrated_product).toBeNull();
    expect(parsed.most_active_category).toBeNull();
  });

  it('rejects when a top-level field is missing', () => {
    const payload: Record<string, unknown> = { ...validHomeStats };
    delete payload.total_integrations;
    expect(HomeStatsResponseSchema.safeParse(payload).success).toBe(false);
  });

  it('rejects a non-numeric total_integrations', () => {
    const result = HomeStatsResponseSchema.safeParse({
      ...validHomeStats,
      total_integrations: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative integration_count inside a nested card', () => {
    const result = HomeStatsResponseSchema.safeParse({
      ...validHomeStats,
      most_integrated_product: { product: validProductLink, integration_count: -1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bad enum inside a nested trending product', () => {
    const result = HomeStatsResponseSchema.safeParse({
      ...validHomeStats,
      trending_products: [{ ...validProductListItem, product_role: 'unknown' }],
    });
    expect(result.success).toBe(false);
  });

  it('enforces the per-array caps from §6.5 (≤10 / ≤5 / ≤10)', () => {
    const integrations = Array.from({ length: 11 }, () => validIntegrationListItem);
    const products = Array.from({ length: 11 }, () => validProductListItem);

    expect(
      HomeStatsResponseSchema.safeParse({ ...validHomeStats, recent_integrations: integrations })
        .success,
    ).toBe(false);
    expect(
      HomeStatsResponseSchema.safeParse({
        ...validHomeStats,
        trending_products: products.slice(0, 6),
      }).success,
    ).toBe(false);
    expect(
      HomeStatsResponseSchema.safeParse({ ...validHomeStats, recently_added_products: products })
        .success,
    ).toBe(false);
  });
});

describe('statsCacheValueSchemas (per-key jsonb shapes)', () => {
  it('covers exactly the enumerated stats_cache keys', () => {
    expect(Object.keys(statsCacheValueSchemas).sort()).toEqual([...STATS_CACHE_KEYS].sort());
  });

  it('parses a bare number for a scalar key and rejects a string', () => {
    expect(statsCacheValueSchemas['home.total_integrations'].parse(7)).toBe(7);
    expect(statsCacheValueSchemas['home.integrations_added_30d'].safeParse('7').success).toBe(
      false,
    );
  });

  it('round-trips the most_integrated_product key value', () => {
    const parsed = statsCacheValueSchemas['home.most_integrated_product'].parse({
      product: validProductLink,
      integration_count: 37,
    });
    expect(parsed).toEqual({ product: validProductLink, integration_count: 37 });
  });

  it('parses a TaxonomyTermWithCount[] for a *_counts key', () => {
    const parsed = statsCacheValueSchemas.category_counts.parse([validTerm]);
    expect(parsed).toHaveLength(1);
    expect(statsCacheValueSchemas.audience_counts.parse([])).toEqual([]);
  });

  it('caps home.trending_products at 5', () => {
    const products = Array.from({ length: 6 }, () => validProductListItem);
    expect(statsCacheValueSchemas['home.trending_products'].safeParse(products).success).toBe(
      false,
    );
  });
});

describe('StatsCacheKeySchema', () => {
  it('accepts a known key and rejects an unknown one', () => {
    expect(StatsCacheKeySchema.parse('home.trending_products')).toBe('home.trending_products');
    expect(StatsCacheKeySchema.safeParse('home.unknown').success).toBe(false);
  });
});

describe('§6.5 contract aliases', () => {
  it('ProductRefSchema accepts a ProductLink', () => {
    expect(ProductRefSchema.parse(validProductLink).slug).toBe('procore-platform');
  });

  it('TaxonomyRefSchema accepts a LinkRef', () => {
    expect(TaxonomyRefSchema.parse(validLinkRef).slug).toBe('project-management');
  });

  it('MostIntegratedProductSchema / MostActiveCategorySchema parse their cards', () => {
    expect(
      MostIntegratedProductSchema.parse({ product: validProductLink, integration_count: 1 })
        .integration_count,
    ).toBe(1);
    expect(
      MostActiveCategorySchema.parse({ category: validLinkRef, integration_count: 2 })
        .integration_count,
    ).toBe(2);
  });

  it('TaxonomyCountsSchema parses a list of terms', () => {
    expect(TaxonomyCountsSchema.parse([validTerm, validTerm])).toHaveLength(2);
  });
});
