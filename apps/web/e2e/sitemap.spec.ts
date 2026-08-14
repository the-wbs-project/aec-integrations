/**
 * AECI-63 / Phase 2.17 — sitemap.xml + robots.txt end-to-end coverage.
 *
 * Runs against the bound dev stack (`pnpm dev:bound`), so the sitemap is
 * generated from the live API rather than fixtures. Structural assertions
 * always run. Entity URL and <lastmod> assertions are conditional: they run
 * when the database has seeded products/vendors and are skipped gracefully
 * in a fresh CI environment that has no seed rows yet.
 */
import { TRADE_PUBLISH_MIN_PRODUCTS } from '@aeci/shared';
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

    // Index pages (AC) — always present regardless of seed data. Three taxonomy
    // indexes since AECI-157; `/trades` joined them in AECI-546 and, unlike the
    // trade TERM pages, is listed unconditionally.
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/products<\/loc>/);
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/categories<\/loc>/);
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/audiences<\/loc>/);
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/phases<\/loc>/);
    expect(xml).toMatch(/<loc>https?:\/\/[^<]+\/trades<\/loc>/);

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

  // AECI-546 — the trade publication gate, asserted against live data rather
  // than fixtures: every trade the API reports is cross-checked against the
  // floor, so this stays honest as the catalog grows and terms cross it.
  test('lists exactly the published trades and no sub-floor ones', async ({ request }) => {
    const trades = await (await request.get('/api/trades')).json();
    const terms = (trades.data ?? []) as { slug: string; product_count: number }[];
    test.skip(terms.length === 0, 'no trades seeded in this environment');

    const xml = await (await request.get('/sitemap.xml')).text();

    for (const term of terms) {
      const listed = xml.includes(`/trades/${term.slug}</loc>`);
      expect(
        listed,
        `/trades/${term.slug} (product_count=${term.product_count}) listed=${listed}`,
      ).toBe(term.product_count >= TRADE_PUBLISH_MIN_PRODUCTS);
    }

    // The local seed straddles the floor on purpose (`apps/api/seed/catalog.sql`:
    // electrical = 3 and plumbing = 1 both clear the floor of 1, while the other
    // seeded trades carry zero products), so a run against it exercises both
    // branches. Guarded so a differently-seeded environment doesn't fail spuriously.
    const published = terms.filter((t) => t.product_count >= TRADE_PUBLISH_MIN_PRODUCTS);
    const unpublished = terms.filter((t) => t.product_count < TRADE_PUBLISH_MIN_PRODUCTS);
    if (published.length && unpublished.length) {
      expect(xml).toContain(`/trades/${published[0]!.slug}</loc>`);
      expect(xml).not.toContain(`/trades/${unpublished[0]!.slug}</loc>`);
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
