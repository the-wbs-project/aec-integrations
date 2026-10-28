/**
 * AECI-1505 — the dirty marker, the store, and the `sitemap-rebuild` job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { products } from '../db/schema';
import { type TestDb, makeTestDb } from '../test/d1';
import { memoryKv } from '../test/memory-kv';
import { runSitemapRebuild, sitemapBase } from './sitemap-rebuild';
import {
  SITEMAP_BUILT_AT_KEY,
  SITEMAP_DIRTY_KEY,
  SITEMAP_DIRTY_RETRY_MS,
  SITEMAP_XML_KEY,
  markSitemapDirty,
  sitemapNeedsRebuild,
  splitSitemapTag,
} from './sitemap-store';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(products).values({ id: 'p1', slug: 'revit', name: 'Revit' });
});

afterEach(() => {
  t.dispose();
  vi.restoreAllMocks();
});

describe('splitSitemapTag', () => {
  it('strips the sitemap tag and reports it', () => {
    expect(splitSitemapTag(['product:revit', 'sitemap', 'taxonomy'])).toEqual({
      tags: ['product:revit', 'taxonomy'],
      dirty: true,
    });
  });

  it('passes a set without it through', () => {
    expect(splitSitemapTag(['product:revit'])).toEqual({ tags: ['product:revit'], dirty: false });
  });
});

describe('markSitemapDirty', () => {
  it('writes the current time to sitemap:dirty', async () => {
    const m = memoryKv();
    await markSitemapDirty({ TAXONOMY_KV: m.kv });
    expect(m.store.get(SITEMAP_DIRTY_KEY)?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('retries a failed write once, after the per-key write window', async () => {
    const m = memoryKv();
    m.failPut(undefined, 1);
    const sleep = vi.fn(async () => undefined);
    await markSitemapDirty({ TAXONOMY_KV: m.kv }, { sleep });
    expect(sleep).toHaveBeenCalledWith(SITEMAP_DIRTY_RETRY_MS);
    expect(m.store.get(SITEMAP_DIRTY_KEY)?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('swallows a second failure, such as a per-key 429 in a promote burst', async () => {
    const m = memoryKv();
    m.failPut();
    const sleep = vi.fn(async () => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(markSitemapDirty({ TAXONOMY_KV: m.kv }, { sleep })).resolves.toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('is a no-op without the binding', async () => {
    await expect(markSitemapDirty({})).resolves.toBeUndefined();
  });
});

describe('sitemapNeedsRebuild', () => {
  it('is false when nothing was ever marked', async () => {
    expect(await sitemapNeedsRebuild(memoryKv().kv)).toBe(false);
  });

  it('is true when marked and never built, and when marked after the last build', async () => {
    const m = memoryKv();
    await m.kv.put(SITEMAP_DIRTY_KEY, '2026-10-28T10:00:00.000Z');
    expect(await sitemapNeedsRebuild(m.kv)).toBe(true);
    await m.kv.put(SITEMAP_BUILT_AT_KEY, '2026-10-28T09:00:00.000Z');
    expect(await sitemapNeedsRebuild(m.kv)).toBe(true);
  });

  it('is false when the last build started after the mark', async () => {
    const m = memoryKv();
    await m.kv.put(SITEMAP_DIRTY_KEY, '2026-10-28T10:00:00.000Z');
    await m.kv.put(SITEMAP_BUILT_AT_KEY, '2026-10-28T10:00:01.000Z');
    expect(await sitemapNeedsRebuild(m.kv)).toBe(false);
  });
});

describe('runSitemapRebuild', () => {
  const env = (kv: KVNamespace, send = vi.fn(async () => undefined)) => ({
    TAXONOMY_KV: kv,
    PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
    CACHE_PURGE_QUEUE: { send } as unknown as Queue,
  });

  it('skips with not_dirty, touching neither D1 nor the edge, when nothing changed', async () => {
    const m = memoryKv();
    const send = vi.fn(async () => undefined);
    const batch = vi.spyOn(t.db, 'batch');
    const report = await runSitemapRebuild(env(m.kv, send), { db: t.db });
    expect(report).toEqual({
      outcome: 'skipped',
      detail: { job: 'sitemap-rebuild', reason: 'not_dirty' },
    });
    expect(batch).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('builds, stores, then purges the sitemap tag once when dirty', async () => {
    const m = memoryKv();
    await m.kv.put(SITEMAP_DIRTY_KEY, '2026-10-28T10:00:00.000Z');
    const send = vi.fn(async () => undefined);
    const start = new Date('2026-10-28T10:07:00.000Z');
    let tick = 0;
    const now = () => new Date(start.getTime() + 1000 * tick++);

    const report = await runSitemapRebuild(env(m.kv, send), { db: t.db, now });

    expect(report.outcome).toBe('ok');
    expect(report.detail).toMatchObject({
      job: 'sitemap-rebuild',
      builtAt: start.toISOString(),
      urlCount: 1,
      base: 'https://www.aecintegrations.com',
      durationMs: 1000,
    });
    // `built_at` is the build's START, so a write during the build stays newer.
    expect(m.store.get(SITEMAP_BUILT_AT_KEY)?.value).toBe(start.toISOString());
    const stored = m.store.get(SITEMAP_XML_KEY);
    expect(stored?.value).toContain('<loc>https://www.aecintegrations.com/products/revit</loc>');
    expect(stored?.metadata).toEqual({
      base: 'https://www.aecintegrations.com',
      builtAt: start.toISOString(),
      urlCount: 1,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ tags: ['sitemap'], source: 'scheduled' });
    // The next tick has nothing to do.
    expect(await sitemapNeedsRebuild(m.kv)).toBe(false);
  });

  it('rebuilds again when a write lands during the build', async () => {
    const m = memoryKv();
    await m.kv.put(SITEMAP_DIRTY_KEY, '2026-10-28T10:00:00.000Z');
    await runSitemapRebuild(env(m.kv), {
      db: t.db,
      now: () => new Date('2026-10-28T10:07:00.000Z'),
    });
    // A promote committed while that build ran, after its start.
    await m.kv.put(SITEMAP_DIRTY_KEY, '2026-10-28T10:07:00.500Z');
    expect(await sitemapNeedsRebuild(m.kv)).toBe(true);
  });

  it('throws, storing and purging nothing, when the build fails', async () => {
    const m = memoryKv();
    await m.kv.put(SITEMAP_DIRTY_KEY, '2026-10-28T10:00:00.000Z');
    const send = vi.fn(async () => undefined);
    vi.spyOn(t.db, 'batch').mockRejectedValue(new Error('D1_ERROR'));
    await expect(runSitemapRebuild(env(m.kv, send), { db: t.db })).rejects.toThrow('D1_ERROR');
    expect(m.store.has(SITEMAP_XML_KEY)).toBe(false);
    expect(m.store.has(SITEMAP_BUILT_AT_KEY)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('still reports ok when only the edge purge enqueue fails', async () => {
    const m = memoryKv();
    await m.kv.put(SITEMAP_DIRTY_KEY, '2026-10-28T10:00:00.000Z');
    const send = vi.fn(async () => {
      throw new Error('queue down');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const report = await runSitemapRebuild(env(m.kv, send), { db: t.db });
    expect(report.outcome).toBe('ok');
    expect(m.store.has(SITEMAP_XML_KEY)).toBe(true);
  });

  it('skips with no_kv_binding when the namespace is not bound', async () => {
    const report = await runSitemapRebuild({ PUBLIC_SITE_URL: undefined }, { db: t.db });
    expect(report).toEqual({
      outcome: 'skipped',
      detail: { job: 'sitemap-rebuild', reason: 'no_kv_binding' },
    });
  });
});

describe('sitemapBase', () => {
  it('uses PUBLIC_SITE_URL without a trailing slash, else the local SSR port', () => {
    expect(sitemapBase({ PUBLIC_SITE_URL: 'https://staging.aecintegrations.com/' })).toBe(
      'https://staging.aecintegrations.com',
    );
    expect(sitemapBase({})).toBe('http://localhost:8788');
  });
});
