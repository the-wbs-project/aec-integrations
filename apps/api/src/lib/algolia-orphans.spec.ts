/**
 * Unit tests for the Algolia orphan sweep (AECI-266). Fully fake-driven — a
 * recording promoted-id provider, a recording browse client, and a recording
 * delete client prove the browse→diff→(cap)→delete pipeline without touching D1
 * or Algolia. Covers: orphan computation across all three entities, per-locale
 * index naming, dry-run as a no-op, apply deleting EXACTLY the orphans (never a
 * promoted id), the safety cap (fractional + absolute, with --force override),
 * idempotent re-run, per-entity browse-throw isolation, the empty-index
 * short-circuit, and the fetch-based browse/delete client contracts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAlgoliaDeleteClient,
  createAlgoliaObjectIdClient,
  DEFAULT_SAFETY_CAP,
  sweepAlgoliaOrphans,
  type AlgoliaDeleteClient,
  type AlgoliaObjectIdClient,
  type EntityOrphanResult,
  type PromotedIdProvider,
  type SafetyCap,
} from './algolia-orphans';

// A cap that never refuses — used by tests exercising deletion MECHANICS rather
// than the cap itself (real indexes carry 40+ objects, so 1–3 orphans stay well
// under the default 20% / 50-object thresholds; the small fixtures here would
// otherwise trip the cap).
const PERMISSIVE_CAP: SafetyCap = { maxDeletes: 1000, maxFraction: 1, override: false };

// The "Fixture Procore" orphan objectIDs from the issue (one per entity index).
const ORPHAN_PRODUCT = '00000000-0000-0000-0000-000000000061';
const ORPHAN_VENDOR = '00000000-0000-0000-0000-000000000062';
const ORPHAN_INTEGRATION = '00000000-0000-0000-0000-000000000065';

// ── Recording fakes ──────────────────────────────────────────────────────────

function makePromotedIds(sets: {
  products: string[];
  vendors: string[];
  integrations: string[];
}): PromotedIdProvider {
  return {
    productIds: async () => new Set(sets.products),
    vendorIds: async () => new Set(sets.vendors),
    integrationIds: async () => new Set(sets.integrations),
  };
}

function makeBrowse(byIndex: Record<string, string[] | Error>) {
  const browsed: string[] = [];
  const client: AlgoliaObjectIdClient = {
    async enumerateObjectIDs(indexName: string) {
      browsed.push(indexName);
      const v = byIndex[indexName];
      if (v === undefined) throw new Error(`unexpected index ${indexName}`);
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return { client, browsed };
}

function makeRemover(failOn?: (indexName: string) => boolean) {
  const deletes: Array<{ index: string; ids: string[] }> = [];
  const client: AlgoliaDeleteClient = {
    async deleteObjects(index: string, ids: string[]) {
      deletes.push({ index, ids });
      if (failOn?.(index)) return { ok: false as const, status: 500, message: 'boom' };
      return { ok: true as const, status: 200 };
    },
  };
  return { client, deletes };
}

const silentLog = { log: () => undefined, warn: () => undefined };

// ── sweepAlgoliaOrphans ───────────────────────────────────────────────────────

describe('sweepAlgoliaOrphans', () => {
  it('computes orphans (index − D1) per entity and browses the canonical names in order', async () => {
    const ids = makePromotedIds({ products: ['p1', 'p2'], vendors: ['v1'], integrations: ['i1'] });
    const { client: browse, browsed } = makeBrowse({
      staging_products: ['p1', 'p2', ORPHAN_PRODUCT],
      staging_vendors: ['v1', ORPHAN_VENDOR],
      staging_integrations: ['i1', ORPHAN_INTEGRATION],
    });
    const { client: remove, deletes } = makeRemover();
    const emitted: EntityOrphanResult[] = [];

    const result = await sweepAlgoliaOrphans(
      { ids, browse, remove, emit: (r) => emitted.push(r), log: silentLog },
      { env: 'staging', apply: false },
    );

    expect(browsed).toEqual(['staging_products', 'staging_vendors', 'staging_integrations']);
    expect(result.entities.map((e) => e.orphanIds)).toEqual([
      [ORPHAN_PRODUCT],
      [ORPHAN_VENDOR],
      [ORPHAN_INTEGRATION],
    ]);
    expect(result.entities.map((e) => e.promotedCount)).toEqual([2, 1, 1]);
    expect(result.totalOrphans).toBe(3);
    // Dry-run: nothing deleted.
    expect(deletes).toEqual([]);
    expect(result.totalDeleted).toBe(0);
    // emit fires once per entity (always).
    expect(emitted).toHaveLength(3);
  });

  it('targets per-locale index names for a non-default locale (§7.6)', async () => {
    const ids = makePromotedIds({ products: [], vendors: [], integrations: [] });
    const { client: browse, browsed } = makeBrowse({
      staging_products_es: [],
      staging_vendors_es: [],
      staging_integrations_es: [],
    });
    const { client: remove } = makeRemover();

    await sweepAlgoliaOrphans(
      { ids, browse, remove, log: silentLog },
      { env: 'staging', locale: 'es', apply: true },
    );

    expect(browsed).toEqual([
      'staging_products_es',
      'staging_vendors_es',
      'staging_integrations_es',
    ]);
  });

  it('dry-run reports orphans but deletes nothing', async () => {
    const ids = makePromotedIds({ products: ['p1'], vendors: [], integrations: [] });
    const { client: browse } = makeBrowse({
      production_products: ['p1', ORPHAN_PRODUCT],
      production_vendors: [],
      production_integrations: [],
    });
    const { client: remove, deletes } = makeRemover();

    const result = await sweepAlgoliaOrphans(
      { ids, browse, remove, log: silentLog },
      { env: 'production', apply: false },
    );

    expect(result.entities[0]!.orphanIds).toEqual([ORPHAN_PRODUCT]);
    expect(result.entities[0]!.deleted).toBe(0);
    expect(deletes).toEqual([]);
  });

  it('apply deletes EXACTLY the orphans and never a promoted id', async () => {
    const ids = makePromotedIds({ products: ['p1', 'p2'], vendors: ['v1'], integrations: ['i1'] });
    const { client: browse } = makeBrowse({
      staging_products: ['p1', 'p2', ORPHAN_PRODUCT],
      staging_vendors: ['v1', ORPHAN_VENDOR],
      staging_integrations: ['i1', ORPHAN_INTEGRATION],
    });
    const { client: remove, deletes } = makeRemover();

    const result = await sweepAlgoliaOrphans(
      { ids, browse, remove, log: silentLog },
      { env: 'staging', apply: true, safetyCap: PERMISSIVE_CAP },
    );

    expect(deletes).toEqual([
      { index: 'staging_products', ids: [ORPHAN_PRODUCT] },
      { index: 'staging_vendors', ids: [ORPHAN_VENDOR] },
      { index: 'staging_integrations', ids: [ORPHAN_INTEGRATION] },
    ]);
    expect(result.totalDeleted).toBe(3);
    expect(result.entities.every((e) => e.ok && !e.skippedBySafetyCap)).toBe(true);
    // Promoted ids must never appear in any delete call.
    const allDeleted = deletes.flatMap((d) => d.ids);
    for (const id of ['p1', 'p2', 'v1', 'i1']) expect(allDeleted).not.toContain(id);
  });

  it('records a delete failure as ok:false without aborting other entities', async () => {
    const ids = makePromotedIds({ products: ['p1'], vendors: ['v1'], integrations: ['i1'] });
    const { client: browse } = makeBrowse({
      staging_products: ['p1', ORPHAN_PRODUCT],
      staging_vendors: ['v1', ORPHAN_VENDOR],
      staging_integrations: ['i1'],
    });
    const { client: remove, deletes } = makeRemover((index) => index === 'staging_products');

    const result = await sweepAlgoliaOrphans(
      { ids, browse, remove, log: silentLog },
      { env: 'staging', apply: true, safetyCap: PERMISSIVE_CAP },
    );

    expect(result.entities[0]).toMatchObject({ ok: false, deleted: 0, error: 'boom' });
    // Vendors still swept + deleted.
    expect(result.entities[1]).toMatchObject({ ok: true, deleted: 1 });
    expect(deletes).toContainEqual({ index: 'staging_vendors', ids: [ORPHAN_VENDOR] });
  });

  describe('safety cap', () => {
    it('refuses a fractional over-limit (empty D1 → 100% orphans) and deletes nothing', async () => {
      const tenIds = Array.from({ length: 10 }, (_, i) => `obj-${i}`);
      const ids = makePromotedIds({ products: [], vendors: [], integrations: [] });
      const { client: browse } = makeBrowse({
        staging_products: tenIds,
        staging_vendors: [],
        staging_integrations: [],
      });
      const { client: remove, deletes } = makeRemover();
      const warns: string[] = [];

      const result = await sweepAlgoliaOrphans(
        { ids, browse, remove, log: { log: () => undefined, warn: (m) => warns.push(String(m)) } },
        { env: 'staging', apply: true, safetyCap: DEFAULT_SAFETY_CAP },
      );

      expect(result.entities[0]).toMatchObject({
        orphanIds: tenIds,
        deleted: 0,
        skippedBySafetyCap: true,
      });
      expect(deletes).toEqual([]); // no delete attempted
      expect(warns[0]).toMatch(/REFUSING to delete 10\/10/);
    });

    it('override (--force) bypasses the cap and deletes them all', async () => {
      const tenIds = Array.from({ length: 10 }, (_, i) => `obj-${i}`);
      const ids = makePromotedIds({ products: [], vendors: [], integrations: [] });
      const { client: browse } = makeBrowse({
        staging_products: tenIds,
        staging_vendors: [],
        staging_integrations: [],
      });
      const { client: remove, deletes } = makeRemover();

      const result = await sweepAlgoliaOrphans(
        { ids, browse, remove, log: silentLog },
        { env: 'staging', apply: true, safetyCap: { ...DEFAULT_SAFETY_CAP, override: true } },
      );

      expect(result.entities[0]).toMatchObject({ deleted: 10, skippedBySafetyCap: false });
      expect(deletes[0]).toEqual({ index: 'staging_products', ids: tenIds });
    });

    it('refuses an absolute over-limit even when the fraction is allowed', async () => {
      // 4 orphans of a 5-object index = 80%; allow the fraction (1.0) but cap the
      // absolute count at 2 → still refused.
      const ids = makePromotedIds({ products: ['keep'], vendors: [], integrations: [] });
      const { client: browse } = makeBrowse({
        staging_products: ['keep', 'a', 'b', 'c', 'd'],
        staging_vendors: [],
        staging_integrations: [],
      });
      const { client: remove, deletes } = makeRemover();

      const result = await sweepAlgoliaOrphans(
        { ids, browse, remove, log: silentLog },
        {
          env: 'staging',
          apply: true,
          safetyCap: { maxDeletes: 2, maxFraction: 1, override: false },
        },
      );

      expect(result.entities[0]).toMatchObject({ deleted: 0, skippedBySafetyCap: true });
      expect(deletes).toEqual([]);
    });
  });

  it('is idempotent: a re-run with no orphans issues no delete', async () => {
    const ids = makePromotedIds({ products: ['p1', 'p2'], vendors: ['v1'], integrations: ['i1'] });
    const { client: browse } = makeBrowse({
      staging_products: ['p1', 'p2'],
      staging_vendors: ['v1'],
      staging_integrations: ['i1'],
    });
    const { client: remove, deletes } = makeRemover();

    const result = await sweepAlgoliaOrphans(
      { ids, browse, remove, log: silentLog },
      { env: 'staging', apply: true },
    );

    expect(result.totalOrphans).toBe(0);
    expect(result.totalDeleted).toBe(0);
    expect(deletes).toEqual([]);
  });

  it('isolates a browse throw to its entity; others still sweep, none deleted for the failed one', async () => {
    const ids = makePromotedIds({ products: ['p1'], vendors: ['v1'], integrations: ['i1'] });
    const { client: browse } = makeBrowse({
      staging_products: new Error('browse 500'),
      staging_vendors: ['v1', ORPHAN_VENDOR],
      staging_integrations: ['i1'],
    });
    const { client: remove, deletes } = makeRemover();

    const result = await sweepAlgoliaOrphans(
      { ids, browse, remove, log: silentLog },
      { env: 'staging', apply: true, safetyCap: PERMISSIVE_CAP },
    );

    expect(result.entities[0]).toMatchObject({ ok: false, deleted: 0, error: 'browse 500' });
    expect(result.entities[1]).toMatchObject({ ok: true, deleted: 1 });
    // No delete call ever targeted the failed products index.
    expect(deletes.some((d) => d.index === 'staging_products')).toBe(false);
  });

  it('short-circuits an empty index (0 objects) without a divide-by-zero or delete', async () => {
    const ids = makePromotedIds({ products: ['p1'], vendors: ['v1'], integrations: ['i1'] });
    const { client: browse } = makeBrowse({
      staging_products: [],
      staging_vendors: [],
      staging_integrations: [],
    });
    const { client: remove, deletes } = makeRemover();

    const result = await sweepAlgoliaOrphans(
      { ids, browse, remove, log: silentLog },
      {
        env: 'staging',
        apply: true,
        safetyCap: { maxDeletes: 0, maxFraction: 0, override: false },
      },
    );

    expect(result.entities.every((e) => e.ok && e.indexCount === 0 && e.deleted === 0)).toBe(true);
    expect(deletes).toEqual([]);
  });
});

// ── createAlgoliaObjectIdClient ───────────────────────────────────────────────

describe('createAlgoliaObjectIdClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('browses with cursor pagination and returns every objectID', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ hits: [{ objectID: 'a' }, { objectID: 'b' }], cursor: 'CUR1' }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ hits: [{ objectID: 'c' }] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = createAlgoliaObjectIdClient('APPID', 'admin-key');
    const ids = await client.enumerateObjectIDs('staging_products');

    expect(ids).toEqual(['a', 'b', 'c']);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://APPID-dsn.algolia.net/1/indexes/staging_products/browse');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers['X-Algolia-Application-Id']).toBe('APPID');
    expect(headers['X-Algolia-API-Key']).toBe('admin-key');
    // First request carries the browse params; the second sends ONLY the cursor.
    expect(JSON.parse(String(init?.body))).toEqual({
      attributesToRetrieve: ['objectID'],
      hitsPerPage: 1000,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({ cursor: 'CUR1' });
  });

  it('throws with the index name and status on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    const client = createAlgoliaObjectIdClient('APPID', 'admin-key');
    await expect(client.enumerateObjectIDs('staging_missing')).rejects.toThrow(
      /staging_missing.*403/,
    );
  });
});

// ── createAlgoliaDeleteClient ─────────────────────────────────────────────────

describe('createAlgoliaDeleteClient', () => {
  it('sends deleteObject batch requests, chunked to 500', async () => {
    const bodies: Array<{ requests: Array<{ action: string; body: { objectID: string } }> }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ taskID: 1 }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createAlgoliaDeleteClient({ appId: 'APPID', apiKey: 'admin-key' }, fetchImpl);
    const ids = Array.from({ length: 600 }, (_, i) => `id-${i}`);
    const outcome = await client.deleteObjects('staging_products', ids);

    expect(outcome.ok).toBe(true);
    // 600 ids → two chunks (500 + 100).
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.requests).toHaveLength(500);
    expect(bodies[1]!.requests).toHaveLength(100);
    expect(bodies[0]!.requests[0]).toEqual({ action: 'deleteObject', body: { objectID: 'id-0' } });
  });

  it('stops at the first failed chunk and returns its outcome', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ message: 'kaboom' }), { status: 500 }),
    ) as unknown as typeof fetch;
    const client = createAlgoliaDeleteClient({ appId: 'APPID', apiKey: 'admin-key' }, fetchImpl);

    const outcome = await client.deleteObjects('staging_products', ['x']);

    expect(outcome).toMatchObject({ ok: false, status: 500, message: 'kaboom' });
  });
});
