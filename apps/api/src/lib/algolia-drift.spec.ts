/**
 * Unit tests for the Phase 3.7 Algolia index-drift core (AECI-140). Fully
 * fake-driven: a recording Prisma `.count()` stub and a recording Algolia
 * counter prove the count→compare→emit pipeline without touching Postgres or
 * Algolia. Asserts the promoted-only filters (including the transitive
 * integration filter), per-locale index naming, the always-emit gauge, the
 * drift sign, the `onDrift` hook, and the `createAlgoliaCounter` fetch contract.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAlgoliaCounter,
  findAlgoliaIndexDrift,
  reportAlgoliaDrift,
  type AlgoliaIndexDrift,
  type DriftCountPrisma,
} from './algolia-drift';

// ── Recording fakes ──────────────────────────────────────────────────────────

type CountArgs = { where: unknown };

function makePrisma(counts: { products: number; vendors: number; integrations: number }) {
  const calls: Record<'product' | 'vendor' | 'integration', CountArgs[]> = {
    product: [],
    vendor: [],
    integration: [],
  };
  const prisma: DriftCountPrisma = {
    product: {
      async count(args) {
        calls.product.push(args);
        return counts.products;
      },
    },
    vendor: {
      async count(args) {
        calls.vendor.push(args);
        return counts.vendors;
      },
    },
    integration: {
      async count(args) {
        calls.integration.push(args);
        return counts.integrations;
      },
    },
  };
  return { prisma, calls };
}

function makeCounter(byIndex: Record<string, number>) {
  const queried: string[] = [];
  return {
    queried,
    counter: {
      async countObjects(indexName: string) {
        queried.push(indexName);
        const n = byIndex[indexName];
        if (n === undefined) throw new Error(`unexpected index ${indexName}`);
        return n;
      },
    },
  };
}

const silentLog = { log: () => undefined, warn: () => undefined };

// ── findAlgoliaIndexDrift ─────────────────────────────────────────────────────

describe('findAlgoliaIndexDrift', () => {
  it('counts promoted rows vs index objects per entity (en-US/staging) with the right filters', async () => {
    const { prisma, calls } = makePrisma({ products: 10, vendors: 5, integrations: 3 });
    const { counter, queried } = makeCounter({
      staging_products: 10,
      staging_vendors: 4,
      staging_integrations: 3,
    });

    const rows = await findAlgoliaIndexDrift({ prisma, algolia: counter }, { env: 'staging' });

    // Promoted-only filters — products/vendors direct, integrations transitive.
    expect(calls.product[0]).toEqual({ where: { promotionStatus: 'promoted' } });
    expect(calls.vendor[0]).toEqual({ where: { promotionStatus: 'promoted' } });
    expect(calls.integration[0]).toEqual({
      where: {
        sourceProduct: { promotionStatus: 'promoted' },
        targetProduct: { promotionStatus: 'promoted' },
      },
    });

    // Canonical (default-locale) index names, in entity order.
    expect(queried).toEqual(['staging_products', 'staging_vendors', 'staging_integrations']);

    expect(rows).toEqual<AlgoliaIndexDrift[]>([
      { entity: 'products', indexName: 'staging_products', supabase: 10, algolia: 10, drift: 0 },
      { entity: 'vendors', indexName: 'staging_vendors', supabase: 5, algolia: 4, drift: 1 },
      {
        entity: 'integrations',
        indexName: 'staging_integrations',
        supabase: 3,
        algolia: 3,
        drift: 0,
      },
    ]);
  });

  it('reports negative drift when an index holds orphan objects', async () => {
    const { prisma } = makePrisma({ products: 2, vendors: 0, integrations: 0 });
    const { counter } = makeCounter({
      production_products: 7,
      production_vendors: 0,
      production_integrations: 0,
    });

    const rows = await findAlgoliaIndexDrift({ prisma, algolia: counter }, { env: 'production' });

    expect(rows[0]).toMatchObject({ supabase: 2, algolia: 7, drift: -5 });
  });

  it('targets per-locale index names for a non-default locale (§7.6)', async () => {
    const { prisma } = makePrisma({ products: 1, vendors: 1, integrations: 0 });
    const { counter, queried } = makeCounter({
      staging_products_es: 1,
      staging_vendors_es: 1,
      staging_integrations_es: 0,
    });

    await findAlgoliaIndexDrift({ prisma, algolia: counter }, { env: 'staging', locale: 'es' });

    expect(queried).toEqual([
      'staging_products_es',
      'staging_vendors_es',
      'staging_integrations_es',
    ]);
  });
});

// ── reportAlgoliaDrift ────────────────────────────────────────────────────────

describe('reportAlgoliaDrift', () => {
  it('emits a gauge per entity (always) and does not fire onDrift when clean', async () => {
    const { prisma } = makePrisma({ products: 3, vendors: 2, integrations: 1 });
    const { counter } = makeCounter({
      staging_products: 3,
      staging_vendors: 2,
      staging_integrations: 1,
    });
    const gauges: AlgoliaIndexDrift[] = [];
    const onDrift = vi.fn();

    await reportAlgoliaDrift(
      { prisma, algolia: counter, emitGauge: (r) => gauges.push(r), onDrift, log: silentLog },
      { env: 'staging' },
    );

    expect(gauges).toHaveLength(3);
    expect(gauges.every((g) => g.drift === 0)).toBe(true);
    expect(onDrift).not.toHaveBeenCalled();
  });

  it('fires onDrift with only the drifted rows when indexes mismatch', async () => {
    const { prisma } = makePrisma({ products: 3, vendors: 2, integrations: 9 });
    const { counter } = makeCounter({
      staging_products: 3,
      staging_vendors: 0,
      staging_integrations: 1,
    });
    const gauges: AlgoliaIndexDrift[] = [];
    const onDrift = vi.fn();

    await reportAlgoliaDrift(
      { prisma, algolia: counter, emitGauge: (r) => gauges.push(r), onDrift, log: silentLog },
      { env: 'staging' },
    );

    // Gauge still emitted for all three entities.
    expect(gauges).toHaveLength(3);
    // onDrift gets vendors (+2) and integrations (+8), not the clean products row.
    expect(onDrift).toHaveBeenCalledTimes(1);
    const drifted = onDrift.mock.calls[0]![0] as AlgoliaIndexDrift[];
    expect(drifted.map((d) => d.entity)).toEqual(['vendors', 'integrations']);
    expect(drifted.map((d) => d.drift)).toEqual([2, 8]);
  });
});

// ── createAlgoliaCounter ──────────────────────────────────────────────────────

describe('createAlgoliaCounter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('queries the search endpoint with the management key and returns nbHits', async () => {
    const fetchMock = vi.fn(
      (_url: string, _init?: RequestInit): Promise<Response> =>
        Promise.resolve(new Response(JSON.stringify({ nbHits: 42 }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const counter = createAlgoliaCounter('APPID', 'admin-key');
    const n = await counter.countObjects('staging_products');

    expect(n).toBe(42);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://APPID-dsn.algolia.net/1/indexes/staging_products/query');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Algolia-Application-Id']).toBe('APPID');
    expect(headers['X-Algolia-API-Key']).toBe('admin-key');
    expect(String(init?.body)).toContain('hitsPerPage=0');
  });

  it('throws with the index name and status on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Index not found', { status: 404 })),
    );
    const counter = createAlgoliaCounter('APPID', 'admin-key');
    await expect(counter.countObjects('staging_missing')).rejects.toThrow(/staging_missing.*404/);
  });

  it('throws when the response carries no numeric nbHits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200 })),
    );
    const counter = createAlgoliaCounter('APPID', 'admin-key');
    await expect(counter.countObjects('staging_products')).rejects.toThrow(/nbHits/);
  });
});
