import { describe, expect, it, vi } from 'vitest';

import { createApp, type Bindings, type SsrRenderer } from '../server-runtime';
import type { ServerApiClient } from '../server-api-client';
import { buildSitemapXml, resolveSitemapEntries, type SitemapEntry } from './sitemap';

// ─── buildSitemapXml (pure) ──────────────────────────────────────────────────

describe('buildSitemapXml', () => {
  const entries: SitemapEntry[] = [
    {
      loc: 'https://aecintegrations.com/products/procore',
      lastmod: '2026-01-02T03:04:05.000Z',
      changefreq: 'weekly',
      priority: 0.7,
    },
    { loc: 'https://aecintegrations.com/categories/cost', changefreq: 'weekly', priority: 0.5 },
  ];
  const xml = buildSitemapXml(entries);

  it('declares the XML prolog and the sitemap protocol namespace', () => {
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml.trimEnd().endsWith('</urlset>')).toBe(true);
  });

  it('emits one <url> per entry with <loc>, <changefreq>, <priority>', () => {
    expect((xml.match(/<url>/g) ?? []).length).toBe(2);
    expect((xml.match(/<loc>/g) ?? []).length).toBe(2);
    expect(xml).toContain('<loc>https://aecintegrations.com/products/procore</loc>');
    expect(xml).toContain('<changefreq>weekly</changefreq>');
    expect(xml).toContain('<priority>0.7</priority>');
  });

  it('emits <lastmod> only for entries that carry one', () => {
    // One entry has lastmod (product), the other (taxonomy) does not.
    expect((xml.match(/<lastmod>/g) ?? []).length).toBe(1);
    expect(xml).toContain('<lastmod>2026-01-02T03:04:05.000Z</lastmod>');
  });

  it('XML-escapes special characters in <loc>', () => {
    const escaped = buildSitemapXml([
      { loc: 'https://x.test/p?a=1&b=2', changefreq: 'weekly', priority: 0.5 },
    ]);
    expect(escaped).toContain('<loc>https://x.test/p?a=1&amp;b=2</loc>');
    expect(escaped).not.toContain('a=1&b=2');
  });

  it('produces a well-formed empty urlset for zero entries', () => {
    const empty = buildSitemapXml([]);
    expect(empty).toContain('<urlset');
    expect(empty).toContain('</urlset>');
    expect(empty.match(/<url>/g)).toBeNull();
  });
});

// ─── resolveSitemapEntries (pagination + mapping) ────────────────────────────

/** ISO timestamps used so the resolver tests can assert lastmod is wired. */
const ISO = '2026-03-04T05:06:07.000Z';

/**
 * Mock `ServerApiClient` that answers each list/taxonomy path. Products are
 * split across two pages (total 150) to exercise pagination to completion.
 */
function mockClient(): { client: ServerApiClient; paths: string[] } {
  const paths: string[] = [];
  const product = (i: number) => ({ id: `p${i}`, slug: `product-${i}`, updated_at: ISO });
  const page1 = Array.from({ length: 100 }, (_, i) => product(i));
  const page2 = Array.from({ length: 50 }, (_, i) => product(100 + i));

  const impl = async (path: string): Promise<unknown> => {
    paths.push(path);
    const url = new URL(`https://api${path}`);
    const p = url.pathname;
    const page = Number(url.searchParams.get('page') ?? '1');

    if (p === '/api/products') {
      return { data: page === 1 ? page1 : page2, page, perPage: 100, total: 150 };
    }
    if (p === '/api/vendors') {
      return {
        data: [{ id: 'v1', slug: 'autodesk', updated_at: ISO }],
        page: 1,
        perPage: 100,
        total: 1,
      };
    }
    if (p === '/api/integrations') {
      return { data: [{ id: 'int-uuid-1', updated_at: ISO }], page: 1, perPage: 100, total: 1 };
    }
    if (p === '/api/taxonomy') {
      return {
        categories: [{ slug: 'cost' }],
        audiences: [{ slug: 'structural' }],
        phases: [{ slug: 'design' }],
      };
    }
    throw new Error(`unexpected path ${path}`);
  };

  const client: ServerApiClient = { request: vi.fn(impl) as unknown as ServerApiClient['request'] };
  return { client, paths };
}

describe('resolveSitemapEntries', () => {
  it('paginates products to completion (perPage=100)', async () => {
    const { client, paths } = mockClient();
    const entries = await resolveSitemapEntries(client, 'https://aecintegrations.com');

    // Two product pages were fetched.
    expect(paths).toContain('/api/products?page=1&perPage=100');
    expect(paths).toContain('/api/products?page=2&perPage=100');

    const productLocs = entries.filter((e) => /\/products\/product-\d+$/.test(e.loc));
    expect(productLocs).toHaveLength(150);
  });

  it('includes index pages, vendor/integration details, and all taxonomy types', () => {
    return resolveSitemapEntries(mockClient().client, 'https://aecintegrations.com').then(
      (entries) => {
        const locs = entries.map((e) => e.loc);
        // Index pages — the products index plus the three taxonomy indexes.
        expect(locs).toContain('https://aecintegrations.com/products');
        expect(locs).toContain('https://aecintegrations.com/categories');
        expect(locs).toContain('https://aecintegrations.com/audiences');
        expect(locs).toContain('https://aecintegrations.com/phases');
        // AECI-165 — the `/vendors` and `/integrations` INDEX pages were removed
        // (they 301-redirect to `/products`), so their bare index `<loc>`s are
        // gone from the sitemap. Their DETAIL URLs still appear (below).
        expect(locs).not.toContain('https://aecintegrations.com/vendors');
        expect(locs).not.toContain('https://aecintegrations.com/integrations');
        // Entities (detail pages stay)
        expect(locs).toContain('https://aecintegrations.com/vendors/autodesk');
        expect(locs).toContain('https://aecintegrations.com/integrations/int-uuid-1');
        expect(locs).toContain('https://aecintegrations.com/categories/cost');
        expect(locs).toContain('https://aecintegrations.com/audiences/structural');
        expect(locs).toContain('https://aecintegrations.com/phases/design');
      },
    );
  });

  it('sets lastmod from updated_at for products/vendors/integrations but not taxonomy', async () => {
    const entries = await resolveSitemapEntries(mockClient().client, 'https://aecintegrations.com');
    const byLoc = (loc: string) => entries.find((e) => e.loc === loc);

    expect(byLoc('https://aecintegrations.com/products/product-0')?.lastmod).toBe(ISO);
    expect(byLoc('https://aecintegrations.com/vendors/autodesk')?.lastmod).toBe(ISO);
    expect(byLoc('https://aecintegrations.com/integrations/int-uuid-1')?.lastmod).toBe(ISO);
    // Taxonomy entries carry no lastmod.
    expect(byLoc('https://aecintegrations.com/categories/cost')?.lastmod).toBeUndefined();
    expect(byLoc('https://aecintegrations.com/audiences/structural')?.lastmod).toBeUndefined();
  });

  it('strips a trailing slash from the base URL', async () => {
    const entries = await resolveSitemapEntries(
      mockClient().client,
      'https://aecintegrations.com/',
    );
    expect(entries.every((e) => !e.loc.includes('.com//'))).toBe(true);
  });
});

// ─── Route integration via createApp + mock API binding ──────────────────────

/** Mirrors the binding stub style in `server.spec.ts`: routes by pathname. */
function sitemapApiBinding(): { API: Fetcher; ASSETS: Fetcher } {
  const fetcher = {
    fetch: vi.fn(async (input: Request) => {
      const url = new URL(input.url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      switch (url.pathname) {
        case '/api/products':
          return json({
            data: [{ id: 'p1', slug: 'procore', updated_at: ISO }],
            page: 1,
            perPage: 100,
            total: 1,
          });
        case '/api/vendors':
          return json({
            data: [{ id: 'v1', slug: 'autodesk', updated_at: ISO }],
            page: 1,
            perPage: 100,
            total: 1,
          });
        case '/api/integrations':
          return json({ data: [], page: 1, perPage: 100, total: 0 });
        case '/api/taxonomy':
          return json({ categories: [{ slug: 'cost' }], audiences: [], phases: [] });
        default:
          return new Response('not found', { status: 404 });
      }
    }),
  } as unknown as Fetcher;
  return { API: fetcher, ASSETS: {} as Fetcher };
}

function throwingRenderer(): SsrRenderer {
  return async () => {
    throw new Error('SSR renderer must not run for /sitemap.xml or /robots.txt');
  };
}

function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    exports: {},
  } as unknown as ExecutionContext;
}

describe('GET /sitemap.xml route', () => {
  it('returns 200 XML with the sitemap cache headers and seeded URLs', async () => {
    const app = createApp({ ssrRenderer: throwingRenderer() });
    const res = await app.fetch(
      new Request('https://aecintegrations.com/sitemap.xml'),
      sitemapApiBinding() as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
    expect(res.headers.get('cache-tag')).toBe('sitemap,taxonomy');

    const body = await res.text();
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    // Built against the request origin.
    expect(body).toContain('<loc>https://aecintegrations.com/products/procore</loc>');
    expect(body).toContain('<loc>https://aecintegrations.com/vendors/autodesk</loc>');
    expect(body).toContain('<loc>https://aecintegrations.com/categories/cost</loc>');
    // lastmod present and ISO-8601.
    expect(body).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z<\/lastmod>/);
  });

  it('returns a non-cacheable 500 when the API fails', async () => {
    const failing = {
      API: {
        fetch: vi.fn(async () => new Response('boom', { status: 500 })),
      } as unknown as Fetcher,
      ASSETS: {} as Fetcher,
    };
    const app = createApp({ ssrRenderer: throwingRenderer() });
    const res = await app.fetch(
      new Request('https://aecintegrations.com/sitemap.xml'),
      failing as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('GET /robots.txt route', () => {
  it('returns 200 text/plain with allow rules and a Sitemap line', async () => {
    const app = createApp({ ssrRenderer: throwingRenderer() });
    const res = await app.fetch(
      new Request('https://aecintegrations.com/robots.txt'),
      sitemapApiBinding() as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, s-maxage=86400');

    const body = await res.text();
    expect(body).toContain('Allow: /');
    expect(body).toContain('Sitemap: https://aecintegrations.com/sitemap.xml');
  });
});
