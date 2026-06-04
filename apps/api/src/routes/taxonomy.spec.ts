import { TaxonomyResponseSchema, type TaxonomyResponse } from '@aeci/shared';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import { allCategoryRows, allAudienceRows, allPhaseRows } from '../test/fixtures/taxonomy';
import {
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createTaxonomyHandler } from './taxonomy';

function buildApp(prisma: MockAcceleratedPrisma) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  app.get(
    '/api/taxonomy',
    createTaxonomyHandler(() => prisma as never),
  );
  return app;
}

function fixtureSeed(): MockAcceleratedPrisma {
  return makeMockAcceleratedPrisma({
    taxonomyCategory: { findMany: allCategoryRows },
    taxonomyAudience: { findMany: allAudienceRows },
    taxonomyPhase: { findMany: allPhaseRows },
  });
}

/**
 * Minimal `KVNamespace` stand-in. Only the methods the handler touches
 * (`get`, `put`) are implemented. State is held in a `Map` so tests can
 * assert hit/miss behaviour.
 */
function makeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(
    Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]),
  );
  return {
    store,
    get: vi.fn(async (key: string, type: 'json' | 'text' = 'text') => {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    }),
    put: vi.fn(async (key: string, value: string, _opts?: { expirationTtl?: number }) => {
      store.set(key, value);
    }),
  };
}

describe('GET /api/taxonomy', () => {
  it('falls back to Prisma when TAXONOMY_KV is not bound', async () => {
    const prisma = fixtureSeed();
    const res = await buildApp(prisma).request(
      '/api/taxonomy',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = TaxonomyResponseSchema.parse(body);
    expect(parsed.categories.map((c) => c.slug)).toContain('project-management');
    expect(parsed.audiences.map((d) => d.slug)).toContain('construction');
    expect(parsed.phases.map((p) => p.slug)).toContain('construction-phase');
    expect(prisma.taxonomyCategory.findMany).toHaveBeenCalledOnce();
  });

  it('on a cache miss, fetches from Prisma and writes the response into KV with a 5-minute TTL', async () => {
    const prisma = fixtureSeed();
    const kv = makeKv();
    const ctx = fakeExecutionContext();
    const env: Env = { ...TEST_ENV, TAXONOMY_KV: kv as unknown as KVNamespace };

    const res = await buildApp(prisma).request('/api/taxonomy', {}, env, ctx);

    expect(res.status).toBe(200);
    expect(kv.get).toHaveBeenCalledWith('taxonomy:v1', 'json');
    expect(prisma.taxonomyCategory.findMany).toHaveBeenCalledOnce();

    // Put is fire-and-forget via ctx.waitUntil — make sure waitUntil was passed a Promise.
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    const waitPromise = (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls[0][0];
    await waitPromise;
    expect(kv.put).toHaveBeenCalledWith('taxonomy:v1', expect.any(String), {
      expirationTtl: 300,
    });
  });

  it('on a cache hit, returns the KV body without hitting Prisma', async () => {
    const prisma = fixtureSeed();
    const cachedBody: TaxonomyResponse = {
      categories: [
        {
          id: '00000000-0000-4000-8000-000000030099',
          name: 'Cached',
          slug: 'cached',
          description: null,
          display_order: 0,
          product_count: 99,
        },
      ],
      audiences: [],
      phases: [],
    };
    const kv = makeKv({ 'taxonomy:v1': cachedBody });
    const env: Env = { ...TEST_ENV, TAXONOMY_KV: kv as unknown as KVNamespace };

    const res = await buildApp(prisma).request('/api/taxonomy', {}, env, fakeExecutionContext());

    expect(res.status).toBe(200);
    const body = (await res.json()) as TaxonomyResponse;
    expect(body.categories[0].slug).toBe('cached');
    expect(prisma.taxonomyCategory.findMany).not.toHaveBeenCalled();
  });

  it('falls through to Prisma when the cached value fails schema validation', async () => {
    const prisma = fixtureSeed();
    const kv = makeKv({ 'taxonomy:v1': { malformed: true } });
    const env: Env = { ...TEST_ENV, TAXONOMY_KV: kv as unknown as KVNamespace };

    const res = await buildApp(prisma).request('/api/taxonomy', {}, env, fakeExecutionContext());

    expect(res.status).toBe(200);
    expect(prisma.taxonomyCategory.findMany).toHaveBeenCalledOnce();
  });

  it('emits Cache-Control: private, no-store', async () => {
    const prisma = fixtureSeed();
    const res = await buildApp(prisma).request(
      '/api/taxonomy',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
