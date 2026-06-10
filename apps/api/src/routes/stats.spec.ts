import {
  HomeStatsResponseSchema,
  type HomeStatsResponse,
  type IntegrationListItem,
  type MostActiveCategory,
  type MostIntegratedProduct,
  type ProductListItem,
} from '@aeci/shared';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import {
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createStatsHomeHandler } from './stats';

function buildApp(prisma: MockAcceleratedPrisma) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  app.get(
    '/api/stats/home',
    createStatsHomeHandler(() => prisma as never),
  );
  return app;
}

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const productLink = {
  id: uuid(1),
  name: 'Procore',
  slug: 'procore',
  logo_url: 'https://cdn.example.com/procore.png',
};

const categoryRef = { id: uuid(2), name: 'Project Management', slug: 'project-management' };

const mostIntegratedProduct: MostIntegratedProduct = {
  product: productLink,
  integration_count: 37,
};

const mostActiveCategory: MostActiveCategory = {
  category: categoryRef,
  integration_count: 64,
};

const integration: IntegrationListItem = {
  id: uuid(3),
  name: 'Procore → BIM 360',
  mechanism_kind: 'native',
  mechanism_name: 'Built-in connector',
  direction: 'bidirectional',
  source: productLink,
  target: { id: uuid(4), name: 'BIM 360', slug: 'bim-360', logo_url: null },
  created_at: '2026-01-03T00:00:00.000Z',
  updated_at: '2026-01-04T00:00:00.000Z',
};

const product: ProductListItem = {
  id: uuid(5),
  slug: 'autodesk-construction-cloud',
  name: 'Autodesk Construction Cloud',
  logo_url: null,
  product_role: 'application',
  vendor: { id: uuid(6), name: 'Autodesk', slug: 'autodesk', logo_url: null },
  primary_category: categoryRef,
  integration_count: 12,
  review_count: 5,
  rating_overall_avg: 4.2,
  rating_onboarding_avg: 3.8,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

/** All seven `home.*` rows, each `value` matching its per-key schema. */
const allHomeRows = [
  { key: 'home.total_integrations', value: 128 },
  { key: 'home.integrations_added_30d', value: 9 },
  { key: 'home.most_integrated_product', value: mostIntegratedProduct },
  { key: 'home.most_active_category', value: mostActiveCategory },
  { key: 'home.recent_integrations', value: [integration] },
  { key: 'home.trending_products', value: [product] },
  { key: 'home.recently_added_products', value: [product] },
];

async function getJson(prisma: MockAcceleratedPrisma) {
  const res = await buildApp(prisma).request(
    '/api/stats/home',
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { res, body: (await res.json()) as HomeStatsResponse };
}

describe('GET /api/stats/home', () => {
  it('assembles the payload from a seeded stats_cache and passes the shared schema', async () => {
    const prisma = makeMockAcceleratedPrisma({ statsCache: { findMany: allHomeRows } });
    const { res, body } = await getJson(prisma);

    expect(res.status).toBe(200);
    const parsed = HomeStatsResponseSchema.parse(body);
    expect(parsed.total_integrations).toBe(128);
    expect(parsed.integrations_added_30d).toBe(9);
    expect(parsed.most_integrated_product?.product.slug).toBe('procore');
    expect(parsed.most_active_category?.integration_count).toBe(64);
    expect(parsed.recent_integrations[0]?.source.slug).toBe('procore');
    expect(parsed.trending_products).toHaveLength(1);
    expect(parsed.recently_added_products).toHaveLength(1);
    expect(prisma.statsCache.findMany).toHaveBeenCalledOnce();
  });

  it('returns an empty-but-valid 200 when the cache is empty (no 500)', async () => {
    // Default mock → statsCache.findMany resolves to [] (cold cache).
    const prisma = makeMockAcceleratedPrisma();
    const { res, body } = await getJson(prisma);

    expect(res.status).toBe(200);
    expect(body).toEqual({
      total_integrations: 0,
      integrations_added_30d: 0,
      most_integrated_product: null,
      most_active_category: null,
      recent_integrations: [],
      trending_products: [],
      recently_added_products: [],
    });
    // Still a valid HomeStatsResponse.
    expect(HomeStatsResponseSchema.safeParse(body).success).toBe(true);
  });

  it('falls back to the per-field default when a cached value is malformed (no 500)', async () => {
    const prisma = makeMockAcceleratedPrisma({
      statsCache: {
        findMany: [
          { key: 'home.total_integrations', value: 'not-a-number' }, // drifted scalar
          { key: 'home.most_integrated_product', value: { product: { id: 'not-a-uuid' } } }, // drifted card
          { key: 'home.recent_integrations', value: [{ bogus: true }] }, // drifted list
          { key: 'home.integrations_added_30d', value: 9 }, // valid sibling survives
        ],
      },
    });
    const { res, body } = await getJson(prisma);

    expect(res.status).toBe(200);
    expect(body.total_integrations).toBe(0);
    expect(body.most_integrated_product).toBeNull();
    expect(body.recent_integrations).toEqual([]);
    // A valid sibling key is unaffected by a drifted neighbour.
    expect(body.integrations_added_30d).toBe(9);
    expect(HomeStatsResponseSchema.safeParse(body).success).toBe(true);
  });

  it('emits Cache-Control: private, no-store (never edge-cached)', async () => {
    const prisma = makeMockAcceleratedPrisma({ statsCache: { findMany: allHomeRows } });
    const res = await buildApp(prisma).request(
      '/api/stats/home',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
