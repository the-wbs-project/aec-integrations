/**
 * AECI-1505 — `GET /api/sitemap.xml`, the stored catalog fragment.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { products } from '../db/schema';
import type { Env } from '../env';
import { SITEMAP_BUILT_AT_KEY, SITEMAP_XML_KEY } from '../lib/sitemap-store';
import { type TestDb, makeTestDb } from '../test/d1';
import { TEST_ENV, buildAppWithHandler, fakeExecutionContext } from '../test/helpers';
import { memoryKv } from '../test/memory-kv';
import { createSitemapFragmentHandler } from './sitemap';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(products).values({ id: 'p1', slug: 'revit', name: 'Revit' });
});

afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

function app() {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/sitemap.xml',
    handler: createSitemapFragmentHandler(t.factory),
  });
}

async function call(env: Env) {
  const ctx = fakeExecutionContext();
  const res = await app().fetch(new Request('https://api/api/sitemap.xml'), env, ctx);
  // Let the `waitUntil` store finish before the test inspects KV.
  await Promise.all(
    (ctx.waitUntil as ReturnType<typeof vi.fn>).mock.calls.map(([p]) => p as Promise<unknown>),
  );
  return res;
}

describe('GET /api/sitemap.xml', () => {
  it('streams a stored build with its metadata in the headers', async () => {
    const m = memoryKv();
    const fragment =
      '  <url>\n    <loc>https://www.aecintegrations.com/products/x</loc>\n  </url>\n';
    await m.kv.put(SITEMAP_XML_KEY, fragment, {
      metadata: {
        base: 'https://www.aecintegrations.com',
        builtAt: '2026-10-28T10:07:00.000Z',
        urlCount: 1,
      },
    });
    const batch = vi.spyOn(t.db, 'batch');

    const res = await call({ ...TEST_ENV, TAXONOMY_KV: m.kv });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-sitemap-base')).toBe('https://www.aecintegrations.com');
    expect(res.headers.get('x-sitemap-built-at')).toBe('2026-10-28T10:07:00.000Z');
    expect(res.headers.get('x-sitemap-url-count')).toBe('1');
    expect(await res.text()).toBe(fragment);
    // A hit never reads D1.
    expect(batch).not.toHaveBeenCalled();
  });

  it('builds inline on an empty namespace, returns it, and stores it', async () => {
    const m = memoryKv();
    const res = await call({
      ...TEST_ENV,
      TAXONOMY_KV: m.kv,
      PUBLIC_SITE_URL: 'https://staging.aecintegrations.com',
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-sitemap-base')).toBe('https://staging.aecintegrations.com');
    const body = await res.text();
    expect(body).toContain('<loc>https://staging.aecintegrations.com/products/revit</loc>');
    expect(m.store.get(SITEMAP_XML_KEY)?.value).toBe(body);
    expect(m.store.get(SITEMAP_BUILT_AT_KEY)?.value).toBe(res.headers.get('x-sitemap-built-at'));
  });

  it('builds inline without a binding, and stores nothing', async () => {
    const res = await call({ ...TEST_ENV });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-sitemap-base')).toBe('http://localhost:8788');
    expect(await res.text()).toContain('/products/revit</loc>');
  });

  it('answers 500 when the inline build fails', async () => {
    vi.spyOn(t.db, 'batch').mockRejectedValue(new Error('D1_ERROR'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await call({ ...TEST_ENV, TAXONOMY_KV: memoryKv().kv });
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});
