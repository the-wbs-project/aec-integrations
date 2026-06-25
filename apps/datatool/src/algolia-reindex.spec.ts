import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildIntegrationRecords,
  buildProductRecords,
  buildVendorRecords,
  reindexEnv,
} from './algolia-reindex';
import { makeShimDb, type ShimHandle } from './test/d1';
import { seedCatalog } from './test/seed-fixture';

const TS = '2026-01-01T00:00:00.000Z';

/** Records every Algolia HTTP call so we can assert clear + batch behavior. */
function fakeFetch() {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify({ taskID: 1 }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const CREDS = { appId: 'APP123', apiKey: 'admin-key' };

describe('algolia reindex — record builders', () => {
  let h: ShimHandle;
  beforeEach(() => {
    h = makeShimDb();
    seedCatalog(h.raw);
  });
  afterEach(() => h.dispose());

  it('builds product records (denormalized vendor + taxonomy names)', async () => {
    const records = await buildProductRecords(h.db);
    expect(records).toHaveLength(2); // both promoted
    const revit = records.find((r) => r.slug === 'revit')!;
    expect(revit.objectID).toBe('prod-1');
    expect(revit.vendor_name).toBe('Autodesk');
    expect(revit.categories).toEqual(['BIM Authoring']);
    expect(revit.has_api_docs).toBe(false); // 0 → boolean
    expect(revit.integration_count).toBe(1);
  });

  it('builds vendor records with product/integration counts', async () => {
    const records = await buildVendorRecords(h.db);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ objectID: 'ven-1', slug: 'autodesk', product_count: 1 });
  });

  it('builds integration records with a numeric mechanism_rank', async () => {
    const records = await buildIntegrationRecords(h.db);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      objectID: 'int-1',
      source_product_slug: 'revit',
      target_product_slug: 'autocad',
      mechanism_kind: 'native',
      mechanism_rank: 6, // native ranks highest
    });
  });

  it('excludes non-promoted entities (membership rule)', async () => {
    h.raw
      .prepare(
        "INSERT INTO products (id, slug, name, promotion_status, created_at, updated_at) VALUES ('prod-pending', 'pending', 'Pending', 'pending', ?, ?)",
      )
      .run(TS, TS);
    const records = await buildProductRecords(h.db);
    expect(records.map((r) => r.slug)).not.toContain('pending');
    expect(records).toHaveLength(2);
  });

  it('drops an integration when one endpoint is unpromoted', async () => {
    h.raw.prepare("UPDATE products SET promotion_status = 'pending' WHERE id = 'prod-2'").run();
    expect(await buildIntegrationRecords(h.db)).toHaveLength(0);
  });
});

describe('reindexEnv', () => {
  let h: ShimHandle;
  beforeEach(() => {
    h = makeShimDb();
    seedCatalog(h.raw);
  });
  afterEach(() => h.dispose());

  it('clears then repopulates each index for the target env', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const result = await reindexEnv(h.db, fetchImpl, CREDS, 'staging');
    expect(result.skipped).toBe(false);
    if (result.skipped) return;

    // one clear + one batch per entity (small data ⇒ single batch)
    const clears = calls.filter((c) => c.url.endsWith('/clear'));
    const batches = calls.filter((c) => c.url.endsWith('/batch'));
    expect(clears.map((c) => c.url)).toEqual([
      'https://APP123.algolia.net/1/indexes/staging_products/clear',
      'https://APP123.algolia.net/1/indexes/staging_vendors/clear',
      'https://APP123.algolia.net/1/indexes/staging_integrations/clear',
    ]);
    expect(batches).toHaveLength(3);
    // products batch carries 2 updateObject ops
    const productsBatch = batches.find((b) => b.url.includes('staging_products'))!;
    expect((productsBatch.body as { requests: unknown[] }).requests).toHaveLength(2);

    const products = result.entities.find((e) => e.entity === 'products')!;
    expect(products).toMatchObject({ cleared: true, added: true, records: 2 });
  });

  it('reindexes only the requested entities (seed → products)', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const result = await reindexEnv(h.db, fetchImpl, CREDS, 'staging', ['products']);
    if (result.skipped) throw new Error('unexpected skip');
    expect(result.entities.map((e) => e.entity)).toEqual(['products']);
    expect(calls.every((c) => c.url.includes('staging_products'))).toBe(true);
  });

  it('skips gracefully when the env Algolia key is absent', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const result = await reindexEnv(
      h.db,
      fetchImpl,
      { appId: 'APP123', apiKey: undefined },
      'preview',
    );
    expect(result.skipped).toBe(true);
    if (!result.skipped) return;
    expect(result.reason).toBe('algolia_credentials_missing');
    expect(calls).toHaveLength(0); // no HTTP at all
  });
});
