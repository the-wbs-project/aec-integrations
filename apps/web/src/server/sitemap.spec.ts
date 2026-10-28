import { describe, expect, it, vi } from 'vitest';

import { createApp, type Bindings, type SsrRenderer } from '../server-runtime';
import { LEGAL_ARCHIVE_PATHS } from '../app/legal/legal-manifest';
import {
  buildSitemapXml,
  staticSitemapEntries,
  streamSitemapXml,
  type SitemapEntry,
} from './sitemap';

// The docs manifest imports `.md` files, which only the Angular build can load.
// Stand in for it with a sample of the paths it yields today (AECI-1248,
// AECI-1253): help pages and the vendor guide, which is indexable since
// AECI-1253. The real derivation is pinned in
// `app/docs/docs-content.component.spec.ts`.
vi.mock('../app/docs/docs-content', () => ({
  indexableDocsPaths: () => [
    '/docs',
    '/docs/reviewers',
    '/docs/reviewers/requests-and-corrections',
    '/docs/vendors',
    '/docs/vendors/overview',
  ],
}));

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

// ─── staticSitemapEntries (the half this Worker owns) ────────────────────────
//
// AECI-1505 moved the catalog half (pagination, the pair dedupe, the AECI-978
// retired-slug filter, the AECI-546 trade gate, entity lastmods) to the API.
// Those cases live in `apps/api/src/lib/sitemap-build.spec.ts` now.

const BASE = 'https://aecintegrations.com';
const ISO = '2026-03-04T05:06:07.000Z';

describe('staticSitemapEntries', () => {
  it('lists the products index and the four taxonomy indexes, and no catalog entity', async () => {
    const locs = (await staticSitemapEntries(BASE)).map((e) => e.loc);
    expect(locs).toContain('https://aecintegrations.com/products');
    expect(locs).toContain('https://aecintegrations.com/categories');
    expect(locs).toContain('https://aecintegrations.com/audiences');
    expect(locs).toContain('https://aecintegrations.com/phases');
    // The floor gates TERMS, not the navigational index (AECI-546).
    expect(locs).toContain('https://aecintegrations.com/trades');
    // AECI-165 — the `/vendors` and `/integrations` INDEX pages 301 to `/products`.
    expect(locs).not.toContain('https://aecintegrations.com/vendors');
    expect(locs).not.toContain('https://aecintegrations.com/integrations');
    // Entity URLs come from the API fragment, never from here.
    const paths = locs.map((l) => l.slice(BASE.length));
    expect(
      paths.filter((p) => /^\/(products|vendors|trades|categories|audiences|phases)\/./.test(p)),
    ).toEqual([]);
  });

  it('includes the six static legal pages (AECI-237, AECI-1359/1360), without a lastmod', async () => {
    const entries = await staticSitemapEntries(BASE);
    const byLoc = (loc: string) => entries.find((e) => e.loc === loc);
    expect(entries.filter((e) => e.loc.includes('/legal/'))).toHaveLength(6);
    for (const slug of [
      'terms',
      'privacy',
      'review-guidelines',
      'listing-accuracy',
      'vendor-terms',
      'managed-plan-agreement',
    ]) {
      const entry = byLoc(`https://aecintegrations.com/legal/${slug}`);
      expect(entry, slug).toBeDefined();
      expect(entry?.changefreq).toBe('yearly');
      expect(entry?.lastmod).toBeUndefined();
    }
  });

  it('leaves out every archived legal version (AECI-1361)', async () => {
    const entries = await staticSitemapEntries(BASE);
    expect(LEGAL_ARCHIVE_PATHS.length).toBeGreaterThan(0);
    for (const path of LEGAL_ARCHIVE_PATHS) {
      expect(
        entries.some((e) => e.loc.endsWith(path)),
        path,
      ).toBe(false);
    }
    expect(entries.some((e) => /\/legal\/[^/]+\/v\d/.test(e.loc))).toBe(false);
  });

  it('includes /methodology (AECI-804), listed alongside the legal set and the docs', async () => {
    const entries = await staticSitemapEntries(BASE);
    const entry = entries.find((e) => e.loc === 'https://aecintegrations.com/methodology');
    expect(entry).toBeDefined();
    expect(entry?.changefreq).toBe('monthly');
    expect(entry?.priority).toBe(0.5);
    expect(entry?.lastmod).toBeUndefined();

    // The other static pages stay OUT, so a future "add every static page" edit
    // has to be a deliberate one. /roadmap in particular is noindex, and listing
    // a noindexed URL is a crawl-budget contradiction.
    for (const path of ['/', '/about', '/updates', '/roadmap']) {
      expect(
        entries.find((e) => e.loc === `https://aecintegrations.com${path}`),
        path,
      ).toBeUndefined();
    }
  });

  it('includes /vendor-program right after /methodology (AECI-1283)', async () => {
    const entries = await staticSitemapEntries(BASE);
    const locs = entries.map((e) => e.loc);
    const at = locs.indexOf('https://aecintegrations.com/vendor-program');
    expect(at).toBeGreaterThan(-1);
    expect(locs[at - 1]).toBe('https://aecintegrations.com/methodology');
    const entry = entries[at];
    expect(entry?.changefreq).toBe('monthly');
    expect(entry?.priority).toBe(0.5);
    expect(entry?.lastmod).toBeUndefined();
  });

  it('includes the listing request page right after /vendor-program (AECI-1474)', async () => {
    const entries = await staticSitemapEntries(BASE);
    const locs = entries.map((e) => e.loc);
    const at = locs.indexOf('https://aecintegrations.com/vendor-program/list-your-product');
    expect(at).toBeGreaterThan(-1);
    expect(locs[at - 1]).toBe('https://aecintegrations.com/vendor-program');
    const entry = entries[at];
    expect(entry?.changefreq).toBe('monthly');
    expect(entry?.priority).toBe(0.5);
    expect(entry?.lastmod).toBeUndefined();
  });

  it('lists the indexable docs from the manifest, vendor guide included, with no lastmod (AECI-1248, AECI-1253)', async () => {
    const entries = await staticSitemapEntries(BASE);
    const docs = entries.filter((e) => e.loc.startsWith('https://aecintegrations.com/docs'));
    expect(docs.map((e) => e.loc)).toEqual([
      'https://aecintegrations.com/docs',
      'https://aecintegrations.com/docs/reviewers',
      'https://aecintegrations.com/docs/reviewers/requests-and-corrections',
      'https://aecintegrations.com/docs/vendors',
      'https://aecintegrations.com/docs/vendors/overview',
    ]);
    for (const entry of docs) expect(entry.lastmod, entry.loc).toBeUndefined();
  });

  it('takes the docs paths from an injected loader', async () => {
    const entries = await staticSitemapEntries('https://aecintegrations.com/', async () => [
      '/docs',
      '/docs/faq',
    ]);
    const docs = entries.filter((e) => e.loc.includes('/docs'));
    expect(docs.map((e) => e.loc)).toEqual([
      'https://aecintegrations.com/docs',
      'https://aecintegrations.com/docs/faq',
    ]);
  });

  it('strips a trailing slash from the base URL', async () => {
    const entries = await staticSitemapEntries('https://aecintegrations.com/');
    expect(entries.every((e) => !e.loc.includes('.com//'))).toBe(true);
  });
});

// ─── streamSitemapXml (the join) ─────────────────────────────────────────────

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

/** Runs `streamSitemapXml` and returns the body plus the pipe's own promise. */
function join(own: SitemapEntry[], fragment: ReadableStream<Uint8Array>) {
  const pending: Promise<unknown>[] = [];
  const body = streamSitemapXml(own, fragment, (p) => pending.push(p));
  return { response: new Response(body), pending };
}

describe('streamSitemapXml', () => {
  const own: SitemapEntry[] = [{ loc: `${BASE}/products`, changefreq: 'daily', priority: 0.8 }];
  const catalog: SitemapEntry[] = [
    { loc: `${BASE}/products/procore`, lastmod: ISO, changefreq: 'weekly', priority: 0.7 },
    { loc: `${BASE}/vendors/autodesk`, lastmod: ISO, changefreq: 'weekly', priority: 0.7 },
  ];

  it('is byte-identical to one buildSitemapXml over both lists', async () => {
    const xml = buildSitemapXml(catalog);
    const fragment = xml.slice(xml.indexOf('  <url>'), xml.lastIndexOf('</urlset>'));
    // Split the fragment mid-element, the way a KV stream may chunk it.
    const { response } = join(own, streamOf(fragment.slice(0, 37), fragment.slice(37)));
    expect(await response.text()).toBe(buildSitemapXml([...own, ...catalog]));
  });

  it('yields a valid document for an empty catalog fragment', async () => {
    const { response } = join(own, streamOf());
    expect(await response.text()).toBe(buildSitemapXml(own));
  });

  it('errors the body when the fragment stream fails, rather than ending cleanly', async () => {
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('  <url>\n'));
        controller.error(new Error('KV read failed'));
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { response, pending } = join(own, failing);
    await expect(response.text()).rejects.toThrow();
    await Promise.all(pending);
    warn.mockRestore();
  });
});

// ─── Route integration via createApp + mock API binding ──────────────────────

/** The API's stored catalog fragment, as `GET /api/sitemap.xml` returns it. */
const FRAGMENT =
  '  <url>\n    <loc>https://www.aecintegrations.com/products/procore</loc>\n' +
  `    <lastmod>${ISO}</lastmod>\n    <changefreq>weekly</changefreq>\n` +
  '    <priority>0.7</priority>\n  </url>\n' +
  '  <url>\n    <loc>https://www.aecintegrations.com/trades/electrical</loc>\n' +
  '    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n  </url>\n';

/** Mirrors the binding stub style in `server.spec.ts`: routes by pathname. */
function sitemapApiBinding(
  headers: Record<string, string> = {
    'X-Sitemap-Base': 'https://www.aecintegrations.com',
    'X-Sitemap-Url-Count': '2',
  },
): { API: Fetcher; ASSETS: Fetcher } {
  const fetcher = {
    fetch: vi.fn(async (input: Request) => {
      const url = new URL(input.url);
      if (url.pathname === '/api/sitemap.xml') {
        return new Response(FRAGMENT, {
          status: 200,
          headers: { 'content-type': 'application/xml; charset=utf-8', ...headers },
        });
      }
      return new Response('not found', { status: 404 });
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
  it('returns 200 XML with the sitemap cache headers, its own entries and the API fragment', async () => {
    const app = createApp({ ssrRenderer: throwingRenderer() });
    // A different request host proves every <loc> follows X-Sitemap-Base, not the
    // request origin (AECI-1505).
    const res = await app.fetch(
      new Request('https://aec-integrations.workers.dev/sitemap.xml'),
      sitemapApiBinding() as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=3600');
    expect(res.headers.get('cache-tag')).toBe('sitemap,taxonomy');

    const body = await res.text();
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(body).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(body.endsWith('</urlset>\n')).toBe(true);
    // This Worker's half, built on the API's base.
    expect(body).toContain('<loc>https://www.aecintegrations.com/trades</loc>');
    expect(body).toContain('<loc>https://www.aecintegrations.com/docs</loc>');
    // The API's half, passed through unchanged, after this Worker's half.
    expect(body).toContain(FRAGMENT);
    expect(body.indexOf('/docs</loc>')).toBeLessThan(body.indexOf('/products/procore</loc>'));
    expect(body).not.toContain('workers.dev');
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
      new Request('https://www.aecintegrations.com/sitemap.xml'),
      failing as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('returns a non-cacheable 500 when the fragment names no base', async () => {
    const app = createApp({ ssrRenderer: throwingRenderer() });
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/sitemap.xml'),
      sitemapApiBinding({}) as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('GET /robots.txt route', () => {
  it('returns 200 text/plain with allow rules and a Sitemap line when indexing is allowed', async () => {
    const app = createApp({ ssrRenderer: throwingRenderer() });
    const res = await app.fetch(
      new Request('https://www.aecintegrations.com/robots.txt'),
      { ...sitemapApiBinding(), ALLOW_INDEXING: 'true' } as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=86400, s-maxage=86400');

    const body = await res.text();
    expect(body).toContain('Allow: /');
    expect(body).toContain('Sitemap: https://www.aecintegrations.com/sitemap.xml');
  });

  it('returns a crawl-allowed, sitemap-less robots.txt when indexing is blocked (pre-launch default)', async () => {
    const app = createApp({ ssrRenderer: throwingRenderer() });
    const res = await app.fetch(
      new Request('https://demo.aecintegrations.com/robots.txt'),
      sitemapApiBinding() as unknown as Bindings,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.text();
    // Crawling stays allowed so the X-Robots-Tag noindex header is honored.
    expect(body).toContain('Allow: /');
    expect(body).not.toContain('Disallow: /');
    expect(body).not.toContain('Sitemap:');
  });
});
