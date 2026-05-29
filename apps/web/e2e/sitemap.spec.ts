/**
 * AECI-63 / Phase 2.17 — sitemap.xml + robots.txt end-to-end coverage.
 *
 * Runs against the bound dev stack (`pnpm dev:bound`), so the sitemap is
 * generated from the *live* seeded API rather than fixtures. To stay decoupled
 * from any specific seed row, the tests first read a real product and vendor
 * slug from the API, then assert those exact URLs appear in the sitemap.
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
    // Pull a real seeded slug from the API so the assertion tracks the seed.
    const products = await (await request.get('/api/products?perPage=1')).json();
    const vendors = await (await request.get('/api/vendors?perPage=1')).json();
    const productSlug = products.data?.[0]?.slug as string | undefined;
    const vendorSlug = vendors.data?.[0]?.slug as string | undefined;
    expect(productSlug, 'expected at least one seeded product').toBeTruthy();
    expect(vendorSlug, 'expected at least one seeded vendor').toBeTruthy();

    const xml = await (await request.get('/sitemap.xml')).text();

    // Well-formed protocol document.
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');

    // Index pages (AC).
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/products<\/loc>/);
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/categories<\/loc>/);

    // Real seeded entity URLs.
    expect(xml).toContain(`/products/${productSlug}</loc>`);
    expect(xml).toContain(`/vendors/${vendorSlug}</loc>`);

    // At least one valid ISO-8601 lastmod.
    expect(xml).toMatch(/<lastmod>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});

test.describe('GET /robots.txt', () => {
  test('allows the public surface and points at the sitemap', async ({ request }) => {
    const res = await request.get('/robots.txt', { maxRedirects: 0 });

    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/plain');

    const body = await res.text();
    expect(body).toContain('Allow: /');
    expect(body).toMatch(/^Sitemap: https?:\/\/[^\s]+\/sitemap\.xml$/m);
  });
});
