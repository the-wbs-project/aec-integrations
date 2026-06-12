/**
 * AECI-63 / Phase 2.17 — sitemap.xml + robots.txt end-to-end coverage.
 *
 * Runs against the bound dev stack (`pnpm dev:bound`), so the sitemap is
 * generated from the live API rather than fixtures. Structural assertions
 * always run. Entity URL and <lastmod> assertions are conditional: they run
 * when the database has seeded products/vendors and are skipped gracefully
 * in a fresh CI environment that has no seed rows yet.
 */
import { expect, test } from '@playwright/test';

test.describe('GET /sitemap.xml', () => {
  test('is served as XML with the sitemap cache headers', async ({ request }) => {
    const res = await request.get('/sitemap.xml', { maxRedirects: 0 });

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/xml');
    expect(res.headers()['cache-control']).toBe('public, max-age=0, s-maxage=3600');
    expect(res.headers()['cache-tag']).toBe('sitemap,taxonomy');
  });

  test('parses, includes index pages, and lists a real product and vendor URL', async ({
    request,
  }) => {
    // Pull a real seeded slug from the API so entity URL assertions track live
    // data rather than hardcoded strings. Both are optional: the structural
    // assertions below always run; entity-specific and <lastmod> assertions
    // are skipped when the database has no seeds (e.g. a fresh CI environment).
    const products = await (await request.get('/api/products?perPage=1')).json();
    const vendors = await (await request.get('/api/vendors?perPage=1')).json();
    const productSlug = products.data?.[0]?.slug as string | undefined;
    const vendorSlug = vendors.data?.[0]?.slug as string | undefined;

    const xml = await (await request.get('/sitemap.xml')).text();

    // Well-formed protocol document — always checked.
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');

    // Index pages (AC) — always present regardless of seed data. All three
    // taxonomy indexes are listed since AECI-157.
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/products<\/loc>/);
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/categories<\/loc>/);
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/audiences<\/loc>/);
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/phases<\/loc>/);

    // Real seeded entity URLs — only asserted when the DB has seeds.
    if (productSlug) {
      expect(xml).toContain(`/products/${productSlug}</loc>`);
    }
    if (vendorSlug) {
      expect(xml).toContain(`/vendors/${vendorSlug}</loc>`);
    }

    // <lastmod> is only emitted for entities — only checked when seeds exist.
    if (productSlug || vendorSlug) {
      expect(xml).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });
});

test.describe('GET /robots.txt', () => {
  test('allows the public surface, matching the env crawler-indexing gate', async ({ request }) => {
    const res = await request.get('/robots.txt', { maxRedirects: 0 });

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/plain');

    const body = await res.text();
    // Crawling is permitted in BOTH gate states — the noindex is carried by the
    // X-Robots-Tag header, not by Disallow (see server/robots-policy.ts).
    expect(body).toContain('Allow: /');

    // The crawler-indexing gate (server/robots-policy.ts) is fail-closed: every
    // pre-launch env (preview/staging/production) sets ALLOW_INDEXING="false",
    // which stamps `X-Robots-Tag: noindex` and emits a sitemap-less robots.txt.
    // The E2E stack boots the preview env, so this run is normally the blocked
    // shape — but assert against the env's actual gate so the test stays correct
    // if ALLOW_INDEXING flips to "true" at launch. (Pre-AECI-303 this always
    // expected the Sitemap line, which is why this failed after the gate landed.)
    const indexingBlocked = (res.headers()['x-robots-tag'] ?? '').includes('noindex');
    if (indexingBlocked) {
      // Fail-closed: crawl allowed (so the noindex header is seen), no sitemap,
      // and no Disallow that would hide the noindex from compliant crawlers.
      expect(body).not.toContain('Sitemap:');
      expect(body).not.toContain('Disallow: /');
    } else {
      // Indexable: advertises the per-env sitemap and disallows private routes.
      expect(body).toMatch(/^Sitemap: https?:\/\/[^\s]+\/sitemap\.xml$/m);
      expect(body).toContain('Disallow: /api/');
    }
  });
});
