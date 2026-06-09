/**
 * Unit tests for the AECI-139 incremental sync core. A fake Prisma (recording
 * delegate) + a fake `fetch` (recording batch transport) exercise the
 * membership partition (promoted → upsert, else delete), the watermark fence
 * (advance on success, hold on failure), transform-error resilience, and the
 * promote-hook id targeting — no network, no DB.
 */

import { Prisma } from '@prisma/client/edge';
import { describe, expect, it, vi } from 'vitest';

import {
  indexEntity,
  runDailySync,
  syncPromoteTargets,
  type AlgoliaSyncPrisma,
  type AlgoliaWatermark,
} from './algolia-sync';
import type {
  RawAlgoliaIntegrationRow,
  RawAlgoliaProductRow,
  RawAlgoliaVendorRow,
} from './algolia-transforms';

const CREDS = { appId: 'APP', apiKey: 'write-key' };
const ENV = 'staging' as const;

// ── Row fixtures (transform inputs + the sync signals) ──────────────────────

type ProductSyncRow = RawAlgoliaProductRow & { promotionStatus: string; updatedAt: Date };
type VendorSyncRow = RawAlgoliaVendorRow & { promotionStatus: string };

function productRow(over: Partial<ProductSyncRow> = {}): ProductSyncRow {
  return {
    id: 'p-1',
    slug: 'procore',
    name: 'Procore',
    description: 'Construction management platform.',
    logoUrl: null,
    hasApiDocs: true,
    integrationCount: 342,
    reviewCount: 0,
    ratingOverallAvg: new Prisma.Decimal(4.5),
    productVendors: [
      {
        isPrimary: true,
        vendor: {
          id: 'v-1',
          companyName: 'Procore Technologies',
          slug: 'procore-tech',
          logoUrl: null,
        },
      },
    ],
    productCategories: [{ category: { name: 'Project Management' } }],
    productAudiences: [{ audience: { name: 'Construction Management' } }],
    productPhases: [{ phase: { name: 'Construction' } }],
    promotionStatus: 'promoted',
    updatedAt: new Date('2026-06-05T00:00:00.000Z'),
    ...over,
  };
}

function vendorRow(over: Partial<VendorSyncRow> = {}): VendorSyncRow {
  return {
    id: 'v-1',
    slug: 'procore-tech',
    companyName: 'Procore Technologies',
    logoUrl: null,
    verified: true,
    headquarters: 'Carpinteria, CA',
    foundedYear: 2003,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2026-06-05T00:00:00.000Z'),
    _count: { productVendors: 8, builtIntegrations: 412 },
    description: null,
    promotionStatus: 'promoted',
    ...over,
  };
}

function integrationRow(over: Partial<RawAlgoliaIntegrationRow> = {}): RawAlgoliaIntegrationRow {
  return {
    id: 'i-1',
    name: 'Procore App',
    mechanismKind: 'native',
    mechanismName: 'Procore App',
    direction: 'bidirectional',
    sourceProduct: { id: 's-1', name: 'Procore', slug: 'procore', logoUrl: null },
    targetProduct: { id: 't-1', name: 'ACC', slug: 'acc', logoUrl: null },
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2026-06-05T00:00:00.000Z'),
    description: null,
    ...over,
  };
}

// ── Fakes ───────────────────────────────────────────────────────────────────

type FakeOpts = {
  products?: ProductSyncRow[];
  vendors?: VendorSyncRow[];
  integrationsEligible?: RawAlgoliaIntegrationRow[];
  integrationsIneligible?: Array<{ id: string }>;
  watermark?: AlgoliaWatermark | null;
};

function makeFakePrisma(opts: FakeOpts = {}) {
  const calls = {
    product: [] as Array<{ where: unknown }>,
    vendor: [] as Array<{ where: unknown }>,
    integration: [] as Array<{ where: unknown }>,
  };
  const upserts: Array<{ update: { value: AlgoliaWatermark } }> = [];
  const prisma = {
    product: {
      findMany: async (args: { where: unknown }) => {
        calls.product.push(args);
        return (opts.products ?? []) as never;
      },
    },
    vendor: {
      findMany: async (args: { where: unknown }) => {
        calls.vendor.push(args);
        return (opts.vendors ?? []) as never;
      },
    },
    integration: {
      findMany: async (args: { where: unknown }) => {
        calls.integration.push(args);
        // The ineligible query is the only one carrying an `OR` clause.
        const ineligible = JSON.stringify(args.where).includes('"OR"');
        return (
          ineligible ? (opts.integrationsIneligible ?? []) : (opts.integrationsEligible ?? [])
        ) as never;
      },
    },
    statsCache: {
      findUnique: async () => (opts.watermark == null ? null : { value: opts.watermark }),
      upsert: async (args: { update: { value: AlgoliaWatermark } }) => {
        upserts.push(args);
        return {};
      },
    },
  } as unknown as AlgoliaSyncPrisma;
  return { prisma, calls, upserts };
}

type BatchCall = {
  url: string;
  body: { requests: Array<{ action: string; body: { objectID: string } }> };
};

function makeFetch(failOn?: (url: string) => boolean) {
  const calls: BatchCall[] = [];
  const fn = vi.fn(async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (failOn?.(url)) return new Response(JSON.stringify({ message: 'boom' }), { status: 500 });
    return new Response(JSON.stringify({ taskID: 1 }), { status: 200 });
  });
  return { fetchImpl: fn as unknown as typeof fetch, calls };
}

// ── indexEntity: membership partition ────────────────────────────────────────

describe('indexEntity — products', () => {
  it('upserts promoted rows and deletes non-promoted rows in one batch', async () => {
    const { prisma } = makeFakePrisma({
      products: [
        productRow({ id: 'keep', promotionStatus: 'promoted' }),
        productRow({ id: 'gone', promotionStatus: 'retracted' }),
        productRow({ id: 'gone-2', promotionStatus: 'rejected' }),
      ],
    });
    const { fetchImpl, calls } = makeFetch();

    const result = await indexEntity(prisma, fetchImpl, CREDS, ENV, 'products', {
      updatedAt: { gt: new Date(0), lte: new Date() },
    });

    expect(result).toMatchObject({
      entity: 'products',
      saved: 1,
      deleted: 2,
      ok: true,
      transformErrors: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://APP.algolia.net/1/indexes/staging_products/batch');
    const actions = calls[0]!.body.requests.map((r) => `${r.action}:${r.body.objectID}`);
    expect(actions).toEqual(['updateObject:keep', 'deleteObject:gone', 'deleteObject:gone-2']);
  });

  it('is a no-op (no fetch) when nothing changed', async () => {
    const { prisma } = makeFakePrisma({ products: [] });
    const { fetchImpl, calls } = makeFetch();
    const result = await indexEntity(prisma, fetchImpl, CREDS, ENV, 'products', {
      updatedAt: { gt: new Date(0), lte: new Date() },
    });
    expect(result).toMatchObject({ saved: 0, deleted: 0, ok: true });
    expect(calls).toHaveLength(0);
  });

  it('reports ok:false with the upstream message on a push failure', async () => {
    const { prisma } = makeFakePrisma({ products: [productRow()] });
    const { fetchImpl } = makeFetch(() => true);
    const result = await indexEntity(prisma, fetchImpl, CREDS, ENV, 'products', {
      updatedAt: { gt: new Date(0), lte: new Date() },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
  });
});

describe('indexEntity — integrations', () => {
  it('upserts eligible (both endpoints promoted) and deletes ineligible', async () => {
    const { prisma } = makeFakePrisma({
      integrationsEligible: [integrationRow({ id: 'keep' })],
      integrationsIneligible: [{ id: 'gone' }],
    });
    const { fetchImpl, calls } = makeFetch();

    const result = await indexEntity(prisma, fetchImpl, CREDS, ENV, 'integrations', {
      updatedAt: { gt: new Date(0), lte: new Date() },
    });

    expect(result).toMatchObject({ entity: 'integrations', saved: 1, deleted: 1, ok: true });
    expect(calls[0]!.url).toBe('https://APP.algolia.net/1/indexes/staging_integrations/batch');
    const actions = calls[0]!.body.requests.map((r) => `${r.action}:${r.body.objectID}`);
    expect(actions).toEqual(['updateObject:keep', 'deleteObject:gone']);
  });

  it('skips (and counts) a row whose transform throws — never wedges the run', async () => {
    const { prisma } = makeFakePrisma({
      integrationsEligible: [
        integrationRow({ id: 'good' }),
        integrationRow({ id: 'bad', mechanismKind: 'telepathy' }),
      ],
    });
    const { fetchImpl, calls } = makeFetch();
    const result = await indexEntity(prisma, fetchImpl, CREDS, ENV, 'integrations', {
      updatedAt: { gt: new Date(0), lte: new Date() },
    });
    expect(result).toMatchObject({ saved: 1, transformErrors: 1, ok: true });
    const actions = calls[0]!.body.requests.map((r) => r.body.objectID);
    expect(actions).toEqual(['good']);
  });
});

// ── runDailySync: watermark fence ────────────────────────────────────────────

describe('runDailySync', () => {
  const NOW = new Date('2026-06-09T03:00:00.000Z');
  const PRIOR: AlgoliaWatermark = {
    products: '2026-06-01T00:00:00.000Z',
    vendors: '2026-06-01T00:00:00.000Z',
    integrations: '2026-06-01T00:00:00.000Z',
  };

  it('queries each entity with the [prior, cutoff] window and advances all on success', async () => {
    const { prisma, calls, upserts } = makeFakePrisma({
      products: [productRow()],
      vendors: [vendorRow()],
      watermark: PRIOR,
    });
    const { fetchImpl } = makeFetch();

    const result = await runDailySync(prisma, fetchImpl, CREDS, ENV, NOW);

    expect(result.cutoff).toBe('2026-06-09T03:00:00.000Z');
    const productWhere = calls.product[0]!.where as { updatedAt: { gt: Date; lte: Date } };
    expect(productWhere.updatedAt.gt.toISOString()).toBe(PRIOR.products);
    expect(productWhere.updatedAt.lte.toISOString()).toBe('2026-06-09T03:00:00.000Z');
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.update.value).toEqual({
      products: '2026-06-09T03:00:00.000Z',
      vendors: '2026-06-09T03:00:00.000Z',
      integrations: '2026-06-09T03:00:00.000Z',
    });
  });

  it('holds the watermark of an entity whose push failed (others advance)', async () => {
    const { prisma, upserts } = makeFakePrisma({
      products: [productRow()],
      vendors: [vendorRow()],
      watermark: PRIOR,
    });
    // Only the vendors index push fails.
    const { fetchImpl } = makeFetch((url) => url.includes('staging_vendors'));

    await runDailySync(prisma, fetchImpl, CREDS, ENV, NOW);

    expect(upserts[0]!.update.value).toEqual({
      products: '2026-06-09T03:00:00.000Z',
      vendors: '2026-06-01T00:00:00.000Z', // held for retry
      integrations: '2026-06-09T03:00:00.000Z',
    });
  });

  it('treats a missing watermark row as epoch (self-healing full sweep)', async () => {
    const { prisma, calls } = makeFakePrisma({ products: [productRow()], watermark: null });
    const { fetchImpl } = makeFetch();
    await runDailySync(prisma, fetchImpl, CREDS, ENV, NOW);
    const productWhere = calls.product[0]!.where as { updatedAt: { gt: Date } };
    expect(productWhere.updatedAt.gt.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });
});

// ── syncPromoteTargets: id-scoped, skips empty entities ──────────────────────

describe('syncPromoteTargets', () => {
  it('indexes the touched product + vendors by id and skips empty integrations', async () => {
    const { prisma, calls } = makeFakePrisma({
      products: [productRow({ id: 'p-1' })],
      vendors: [vendorRow({ id: 'v-1' })],
    });
    const { fetchImpl, calls: fetchCalls } = makeFetch();

    const results = await syncPromoteTargets(prisma, fetchImpl, CREDS, ENV, {
      product: { id: 'p-1' },
      vendors: [{ id: 'v-1' }],
      integrations: [],
    });

    expect(results.map((r) => r.entity)).toEqual(['products', 'vendors']);
    expect(calls.integration).toHaveLength(0);
    const productWhere = calls.product[0]!.where as { id: { in: string[] } };
    expect(productWhere.id.in).toEqual(['p-1']);
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'https://APP.algolia.net/1/indexes/staging_products/batch',
      'https://APP.algolia.net/1/indexes/staging_vendors/batch',
    ]);
  });

  it('returns no results when the promote touched nothing indexable', async () => {
    const { prisma } = makeFakePrisma();
    const { fetchImpl, calls } = makeFetch();
    const results = await syncPromoteTargets(prisma, fetchImpl, CREDS, ENV, {
      product: null,
      vendors: [],
      integrations: [],
    });
    expect(results).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
