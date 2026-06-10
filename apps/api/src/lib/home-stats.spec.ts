/**
 * Unit tests for the AECI-178 home-stats compute core. A fake Prisma (recording
 * delegate, deriving results from base fixtures — products, integrations,
 * page_views, categories) exercises each compute function and the `runHomeStats`
 * orchestration: every written value is validated against its
 * `statsCacheValueSchemas` schema, empty `page_views` yields `[]` without
 * throwing, and one failing key never aborts the others. No DB, no network.
 */

import { statsCacheValueSchemas } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  computeIntegrationsAdded30d,
  computeMostActiveCategory,
  computeMostIntegratedProduct,
  computeRecentIntegrations,
  computeRecentlyAddedProducts,
  computeTotalIntegrations,
  computeTrendingProducts,
  runHomeStats,
  type HomeStatsPrisma,
} from './home-stats';
import type { RawIntegrationListRow, RawProductListRow } from './prisma-helpers';

const NOW = new Date('2026-06-10T00:00:00.000Z');
const within7d = new Date('2026-06-08T00:00:00.000Z'); // inside both windows
const within30d = new Date('2026-05-20T00:00:00.000Z'); // inside 30d, outside 7d
const old = new Date('2026-01-01T00:00:00.000Z'); // outside both windows

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A `RawProductListRow` superset — valid for `productListSelect` (trending /
 *  recently-added) and `mostIntegratedSelect` (a strict subset). */
function productRow(over: Partial<RawProductListRow> = {}): RawProductListRow {
  return {
    id: 'p-1',
    slug: 'procore',
    name: 'Procore',
    logoUrl: null,
    productRole: 'application',
    integrationCount: 0,
    reviewCount: 0,
    ratingOverallAvg: null,
    ratingOnboardingAvg: null,
    createdAt: within30d,
    updatedAt: within30d,
    productVendors: [],
    productCategories: [],
    ...over,
  } as RawProductListRow;
}

/** An integration row carrying both the list-hydration fields (recent) and the
 *  per-endpoint category-id edges (most-active-category). */
type IntegrationFixture = Omit<RawIntegrationListRow, 'sourceProduct' | 'targetProduct'> & {
  sourceProduct: RawIntegrationListRow['sourceProduct'] & {
    productCategories: { categoryId: string }[];
  };
  targetProduct: RawIntegrationListRow['targetProduct'] & {
    productCategories: { categoryId: string }[];
  };
};

function integrationRow(over: Partial<IntegrationFixture> = {}): IntegrationFixture {
  return {
    id: 'i-1',
    name: null,
    mechanismKind: null,
    mechanismName: null,
    direction: null,
    sourceProduct: {
      id: 's-1',
      name: 'Source',
      slug: 'source',
      logoUrl: null,
      productCategories: [],
    },
    targetProduct: {
      id: 't-1',
      name: 'Target',
      slug: 'target',
      logoUrl: null,
      productCategories: [],
    },
    createdAt: within30d,
    updatedAt: within30d,
    ...over,
  };
}

type CategoryFixture = { id: string; name: string; slug: string };
type MostIntegratedFixture = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  integrationCount: number;
} | null;
type PageViewFixture = { productId: string | null; createdAt: Date };

type FakeOpts = {
  integrations?: IntegrationFixture[];
  products?: RawProductListRow[];
  mostIntegratedRow?: MostIntegratedFixture;
  pageViews?: PageViewFixture[];
  categories?: CategoryFixture[];
  findFirstThrows?: boolean;
};

function makeFakePrisma(opts: FakeOpts = {}) {
  const upserts = new Map<string, unknown>();
  const calls = { findFirst: [] as unknown[] };

  const prisma = {
    integration: {
      count: async (args?: { where?: { createdAt?: { gte?: Date } } }) => {
        const items = opts.integrations ?? [];
        const gte = args?.where?.createdAt?.gte;
        return gte ? items.filter((i) => i.createdAt >= gte).length : items.length;
      },
      findMany: async (args: { take?: number }) => {
        const items = opts.integrations ?? [];
        // The recent-integrations query is the only one carrying `take` — sort by
        // createdAt desc and slice. The category-edge query carries no `take`.
        if (args.take !== undefined) {
          const sorted = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return sorted.slice(0, args.take) as never;
        }
        return items as never;
      },
    },
    product: {
      findFirst: async (args: unknown) => {
        calls.findFirst.push(args);
        if (opts.findFirstThrows) throw new Error('findFirst boom');
        return (opts.mostIntegratedRow ?? null) as never;
      },
      findMany: async (args: {
        where?: { id?: { in?: string[] }; createdAt?: { gte?: Date } };
      }) => {
        const items = opts.products ?? [];
        if (args.where?.id?.in) {
          const ids = new Set(args.where.id.in);
          // Returned in fixture order (compute reorders to the page-view ranking).
          return items.filter((p) => ids.has(p.id)) as never;
        }
        const gte = args.where?.createdAt?.gte;
        const recent = (gte ? items.filter((p) => p.createdAt >= gte) : items)
          .slice()
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 10);
        return recent as never;
      },
    },
    pageView: {
      groupBy: async (args: { where?: { createdAt?: { gte?: Date } }; take?: number }) => {
        const gte = args.where?.createdAt?.gte;
        const filtered = (opts.pageViews ?? []).filter(
          (pv) => pv.productId !== null && (!gte || pv.createdAt >= gte),
        );
        const counts = new Map<string, number>();
        for (const pv of filtered) counts.set(pv.productId!, (counts.get(pv.productId!) ?? 0) + 1);
        const groups = [...counts.entries()]
          .map(([productId, c]) => ({ productId, _count: { _all: c } }))
          .sort((a, b) => b._count._all - a._count._all || a.productId.localeCompare(b.productId));
        return groups.slice(0, args.take ?? groups.length) as never;
      },
    },
    taxonomyCategory: {
      findMany: async () => (opts.categories ?? []) as never,
    },
    statsCache: {
      upsert: async (args: { where: { key: string }; create: { value: unknown } }) => {
        upserts.set(args.where.key, args.create.value);
        return {};
      },
    },
  } as unknown as HomeStatsPrisma;

  return { prisma, upserts, calls };
}

// ── Per-key compute functions ────────────────────────────────────────────────

describe('computeTotalIntegrations', () => {
  it('counts every integration', async () => {
    const { prisma } = makeFakePrisma({
      integrations: [integrationRow({ id: 'a' }), integrationRow({ id: 'b' })],
    });
    expect(await computeTotalIntegrations(prisma)).toBe(2);
  });

  it('returns 0 on an empty DB', async () => {
    const { prisma } = makeFakePrisma();
    expect(await computeTotalIntegrations(prisma)).toBe(0);
  });
});

describe('computeIntegrationsAdded30d', () => {
  it('counts only integrations created within the last 30 days', async () => {
    const { prisma } = makeFakePrisma({
      integrations: [
        integrationRow({ id: 'fresh', createdAt: within7d }),
        integrationRow({ id: 'recent', createdAt: within30d }),
        integrationRow({ id: 'stale', createdAt: old }),
      ],
    });
    expect(await computeIntegrationsAdded30d(prisma, NOW)).toBe(2);
  });
});

describe('computeMostIntegratedProduct', () => {
  it('maps the row Prisma returns and passes the ordering', async () => {
    const { prisma, calls } = makeFakePrisma({
      mostIntegratedRow: {
        id: 'p-9',
        name: 'Revit',
        slug: 'revit',
        logoUrl: 'l.png',
        integrationCount: 42,
      },
    });
    const result = await computeMostIntegratedProduct(prisma);
    expect(result).toEqual({
      product: { id: 'p-9', name: 'Revit', slug: 'revit', logo_url: 'l.png' },
      integration_count: 42,
    });
    // Ordering is delegated to the DB — assert the contract is passed through.
    expect(calls.findFirst[0]).toMatchObject({
      orderBy: [{ integrationCount: 'desc' }, { name: 'asc' }],
    });
  });

  it('returns null on an empty DB (skips the key)', async () => {
    const { prisma } = makeFakePrisma({ mostIntegratedRow: null });
    expect(await computeMostIntegratedProduct(prisma)).toBeNull();
  });
});

describe('computeMostActiveCategory', () => {
  const categories = [
    { id: 'c-1', name: 'Project Management', slug: 'project-management' },
    { id: 'c-2', name: 'Design', slug: 'design' },
  ];

  it('counts distinct integrations whose source OR target is in the category', async () => {
    const { prisma } = makeFakePrisma({
      categories,
      integrations: [
        // i-1 touches c-1 and c-2 (union counts each once)
        integrationRow({
          id: 'i-1',
          sourceProduct: {
            id: 's-1',
            name: 'S',
            slug: 's',
            logoUrl: null,
            productCategories: [{ categoryId: 'c-1' }],
          },
          targetProduct: {
            id: 't-1',
            name: 'T',
            slug: 't',
            logoUrl: null,
            productCategories: [{ categoryId: 'c-2' }],
          },
        }),
        // i-2 is internal to c-1 (both endpoints) — counts c-1 once, not twice
        integrationRow({
          id: 'i-2',
          sourceProduct: {
            id: 's-2',
            name: 'S2',
            slug: 's2',
            logoUrl: null,
            productCategories: [{ categoryId: 'c-1' }],
          },
          targetProduct: {
            id: 't-2',
            name: 'T2',
            slug: 't2',
            logoUrl: null,
            productCategories: [{ categoryId: 'c-1' }],
          },
        }),
      ],
    });
    // c-1 touched by i-1 + i-2 = 2; c-2 touched by i-1 = 1 → c-1 wins.
    expect(await computeMostActiveCategory(prisma)).toEqual({
      category: { id: 'c-1', name: 'Project Management', slug: 'project-management' },
      integration_count: 2,
    });
  });

  it('breaks ties alphabetically by category name', async () => {
    const { prisma } = makeFakePrisma({
      categories,
      integrations: [
        integrationRow({
          id: 'i-1',
          sourceProduct: {
            id: 's',
            name: 'S',
            slug: 's',
            logoUrl: null,
            productCategories: [{ categoryId: 'c-1' }],
          },
          targetProduct: {
            id: 't',
            name: 'T',
            slug: 't',
            logoUrl: null,
            productCategories: [{ categoryId: 'c-2' }],
          },
        }),
      ],
    });
    // c-1 and c-2 each count 1 → "Design" (c-2) sorts before "Project Management".
    expect(await computeMostActiveCategory(prisma)).toEqual({
      category: { id: 'c-2', name: 'Design', slug: 'design' },
      integration_count: 1,
    });
  });

  it('returns null when there are no integrations (skips the key)', async () => {
    const { prisma } = makeFakePrisma({ categories });
    expect(await computeMostActiveCategory(prisma)).toBeNull();
  });
});

describe('computeRecentIntegrations', () => {
  it('returns the newest integrations as IntegrationListItems (synthesized name)', async () => {
    const { prisma } = makeFakePrisma({
      integrations: [
        integrationRow({ id: 'newest', createdAt: within7d }),
        integrationRow({ id: 'older', createdAt: old }),
      ],
    });
    const result = await computeRecentIntegrations(prisma);
    expect(result.map((r) => r.id)).toEqual(['newest', 'older']);
    expect(result[0]!.name).toBe('Source → Target'); // null name synthesized by the mapper
  });
});

describe('computeTrendingProducts', () => {
  it('ranks the top products by page views (last 7d), reordered to the ranking', async () => {
    const { prisma } = makeFakePrisma({
      products: [
        productRow({ id: 'p-1', slug: 'a', name: 'A' }),
        productRow({ id: 'p-2', slug: 'b', name: 'B' }),
      ],
      pageViews: [
        { productId: 'p-1', createdAt: within7d },
        { productId: 'p-2', createdAt: within7d },
        { productId: 'p-2', createdAt: within7d }, // p-2 has 2 views, p-1 has 1
        { productId: 'p-1', createdAt: old }, // outside the 7d window — ignored
        { productId: 'ghost', createdAt: within7d }, // no product row — dropped
      ],
    });
    const result = await computeTrendingProducts(prisma, NOW);
    expect(result.map((r) => r.id)).toEqual(['p-2', 'p-1']);
  });

  it('returns [] when there are no page views (does not throw)', async () => {
    const { prisma } = makeFakePrisma({ products: [productRow()], pageViews: [] });
    await expect(computeTrendingProducts(prisma, NOW)).resolves.toEqual([]);
  });
});

describe('computeRecentlyAddedProducts', () => {
  it('returns products created in the last 30 days, newest first', async () => {
    const { prisma } = makeFakePrisma({
      products: [
        productRow({ id: 'fresh', slug: 'fresh', createdAt: within7d }),
        productRow({ id: 'recent', slug: 'recent', createdAt: within30d }),
        productRow({ id: 'stale', slug: 'stale', createdAt: old }),
      ],
    });
    const result = await computeRecentlyAddedProducts(prisma, NOW);
    expect(result.map((r) => r.id)).toEqual(['fresh', 'recent']);
  });
});

// ── runHomeStats orchestration ───────────────────────────────────────────────

// The end-to-end `runHomeStats` test validates every written value against its
// `statsCacheValueSchemas` schema, and those schemas require `id` to be a UUID
// (`LinkRefSchema` / `ProductListItemSchema` / `IntegrationListItemSchema`), so
// the orchestration fixture uses real UUIDs (the per-key compute tests above
// don't validate, so they keep friendlier ids).
const U = {
  p1: '11111111-1111-4111-8111-111111111111',
  p2: '22222222-2222-4222-8222-222222222222',
  i1: '33333333-3333-4333-8333-333333333333',
  i2: '44444444-4444-4444-8444-444444444444',
  c1: '55555555-5555-4555-8555-555555555555',
  c2: '66666666-6666-4666-8666-666666666666',
};

function fullFixture(): FakeOpts {
  return {
    integrations: [
      integrationRow({
        id: U.i1,
        createdAt: within7d,
        sourceProduct: {
          id: U.p1,
          name: 'A',
          slug: 'a',
          logoUrl: null,
          productCategories: [{ categoryId: U.c1 }],
        },
        targetProduct: {
          id: U.p2,
          name: 'B',
          slug: 'b',
          logoUrl: null,
          productCategories: [{ categoryId: U.c2 }],
        },
      }),
      integrationRow({
        id: U.i2,
        createdAt: old,
        sourceProduct: { id: U.p1, name: 'A', slug: 'a', logoUrl: null, productCategories: [] },
        targetProduct: { id: U.p2, name: 'B', slug: 'b', logoUrl: null, productCategories: [] },
      }),
    ],
    products: [
      productRow({ id: U.p1, slug: 'a', name: 'A', integrationCount: 5, createdAt: within7d }),
      productRow({ id: U.p2, slug: 'b', name: 'B', integrationCount: 9, createdAt: within30d }),
    ],
    mostIntegratedRow: { id: U.p2, name: 'B', slug: 'b', logoUrl: null, integrationCount: 9 },
    pageViews: [{ productId: U.p1, createdAt: within7d }],
    categories: [
      { id: U.c1, name: 'Project Management', slug: 'project-management' },
      { id: U.c2, name: 'Design', slug: 'design' },
    ],
  };
}

describe('runHomeStats', () => {
  it('writes all seven home.* keys with values that pass their own schema', async () => {
    const { prisma, upserts } = makeFakePrisma(fullFixture());

    const result = await runHomeStats(prisma, NOW);

    const written = result.keys.filter((k) => k.status === 'written').map((k) => k.key);
    expect(written).toEqual([
      'home.total_integrations',
      'home.integrations_added_30d',
      'home.most_integrated_product',
      'home.most_active_category',
      'home.recent_integrations',
      'home.trending_products',
      'home.recently_added_products',
    ]);

    // Every cached value round-trips its source-of-truth schema (the §10 contract).
    for (const [key, value] of upserts) {
      const schema = statsCacheValueSchemas[key as keyof typeof statsCacheValueSchemas];
      expect(schema.safeParse(value).success, `${key} failed its schema`).toBe(true);
    }

    expect(upserts.get('home.total_integrations')).toBe(2);
    expect(upserts.get('home.integrations_added_30d')).toBe(1);
    expect(upserts.get('home.most_integrated_product')).toMatchObject({ integration_count: 9 });
    expect(upserts.get('home.most_active_category')).toMatchObject({ integration_count: 1 });
  });

  it('skips most_integrated_product / most_active_category on an empty DB (no throw)', async () => {
    const { prisma, upserts } = makeFakePrisma(); // no fixtures at all

    const result = await runHomeStats(prisma, NOW);

    const byKey = new Map(result.keys.map((k) => [k.key, k.status]));
    expect(byKey.get('home.most_integrated_product')).toBe('skipped');
    expect(byKey.get('home.most_active_category')).toBe('skipped');
    // Scalar / list keys still write — 0 and [] are valid values.
    expect(upserts.get('home.total_integrations')).toBe(0);
    expect(upserts.get('home.trending_products')).toEqual([]);
    expect(upserts.has('home.most_integrated_product')).toBe(false);
  });

  it('empty page_views → home.trending_products = [] without throwing', async () => {
    const { prisma, upserts } = makeFakePrisma({ ...fullFixture(), pageViews: [] });

    const result = await runHomeStats(prisma, NOW);

    expect(result.keys.find((k) => k.key === 'home.trending_products')?.status).toBe('written');
    expect(upserts.get('home.trending_products')).toEqual([]);
  });

  it('isolates a failing key — the rest still write (partial failure)', async () => {
    // findFirst throws → most_integrated_product fails; the other six proceed.
    const { prisma, upserts } = makeFakePrisma({ ...fullFixture(), findFirstThrows: true });

    const result = await runHomeStats(prisma, NOW);

    const failed = result.keys.find((k) => k.key === 'home.most_integrated_product');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toContain('findFirst boom');
    expect(upserts.has('home.most_integrated_product')).toBe(false);
    // The six other keys still wrote despite the one failure.
    expect(result.keys.filter((k) => k.status === 'written')).toHaveLength(6);
  });

  it('never throws and always returns an outcome per key', async () => {
    const { prisma } = makeFakePrisma(fullFixture());
    const result = await runHomeStats(prisma, NOW);
    expect(result.keys).toHaveLength(7);
  });

  it('records a non-negative per-key durationMs for every key (AECI-180)', async () => {
    const { prisma } = makeFakePrisma(fullFixture());
    const result = await runHomeStats(prisma, NOW);
    expect(result.keys.every((k) => typeof k.durationMs === 'number' && k.durationMs >= 0)).toBe(
      true,
    );
  });
});
