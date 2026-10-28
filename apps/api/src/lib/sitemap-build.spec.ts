/**
 * AECI-1505 — the catalog half of `sitemap.xml`, against the real migrated schema.
 *
 * These cases moved here from `apps/web/src/server/sitemap.spec.ts` along with the
 * logic: the pair dedupe (AECI-294), the evidenced arm (AECI-1091), retired rows
 * (AECI-1010), the retired-slug filter (AECI-978) and the trade gate (AECI-546).
 */
import { TRADE_PUBLISH_MIN_PRODUCTS, buildSitemapXml } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  connectorEvidencedPairs,
  integrations,
  productTrades,
  products,
  slugRedirects,
  taxonomyCategories,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { type TestDb, makeTestDb } from '../test/d1';
import { buildCatalogSitemap } from './sitemap-build';

const BASE = 'https://www.aecintegrations.com';
const OLD = '2026-01-01T00:00:00.000Z';
const NEW = '2026-02-02T00:00:00.000Z';

const locsOf = (xml: string) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: 'v1', slug: 'autodesk', companyName: 'Autodesk' });
  await t.db.insert(products).values([
    { id: 'p1', slug: 'revit', name: 'Revit' },
    { id: 'p2', slug: 'procore', name: 'Procore' },
    { id: 'p3', slug: 'zapier', name: 'Zapier' },
    { id: 'p4', slug: 'bluebeam', name: 'Bluebeam' },
  ]);
});

afterEach(() => t.dispose());

describe('buildCatalogSitemap', () => {
  it('lists every product and vendor with its updated_at as lastmod', async () => {
    await t.raw.prepare(`UPDATE products SET updated_at = ? WHERE id = 'p1'`).run(NEW);
    const { xml, urlCount, base } = await buildCatalogSitemap(t.db, `${BASE}/`);

    expect(base).toBe(BASE);
    const locs = locsOf(xml);
    expect(locs).toContain(`${BASE}/products/revit`);
    expect(locs).toContain(`${BASE}/products/bluebeam`);
    expect(locs).toContain(`${BASE}/vendors/autodesk`);
    expect(urlCount).toBe(locs.length);
    expect(xml).toContain(
      `<loc>${BASE}/products/revit</loc>\n    <lastmod>${NEW}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>`,
    );
    // A fragment, not a document: the SSR Worker adds the prolog and the urlset.
    expect(xml).not.toContain('<?xml');
    expect(xml).not.toContain('urlset');
  });

  it('emits one pair URL per unordered pair, context first, newest updated_at as lastmod', async () => {
    await t.db.insert(integrations).values([
      // Both orientations of revit/procore: one URL, context = procore (BINARY min).
      { id: 'i1', sourceProductId: 'p1', targetProductId: 'p2', updatedAt: OLD },
      { id: 'i2', sourceProductId: 'p2', targetProductId: 'p1', updatedAt: NEW },
    ]);
    // The same pair again from the evidenced arm, and a pair only it carries.
    await t.db.insert(connectorEvidencedPairs).values([
      { id: 'e1', connectorProductId: 'p3', productAId: 'p1', productBId: 'p2', updatedAt: OLD },
      { id: 'e2', connectorProductId: 'p3', productAId: 'p1', productBId: 'p4', updatedAt: OLD },
    ]);

    const { xml } = await buildCatalogSitemap(t.db, BASE);
    const pairs = locsOf(xml).filter((l) => l.includes('/integrations/'));
    expect(pairs).toEqual([
      `${BASE}/products/bluebeam/integrations/revit`,
      `${BASE}/products/procore/integrations/revit`,
    ]);
    expect(xml).toContain(
      `<loc>${BASE}/products/procore/integrations/revit</loc>\n    <lastmod>${NEW}</lastmod>`,
    );
    expect(xml).toContain(
      `<loc>${BASE}/products/procore/integrations/revit</loc>\n    <lastmod>${NEW}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>`,
    );
  });

  it('leaves out retired integrations and retired evidenced pairs', async () => {
    await t.db.insert(integrations).values({
      id: 'i1',
      sourceProductId: 'p1',
      targetProductId: 'p2',
      retiredAt: NEW,
    });
    await t.db.insert(connectorEvidencedPairs).values({
      id: 'e1',
      connectorProductId: 'p3',
      productAId: 'p1',
      productBId: 'p4',
      retiredAt: NEW,
    });
    const { xml } = await buildCatalogSitemap(t.db, BASE);
    expect(locsOf(xml).some((l) => l.includes('/integrations/'))).toBe(false);
  });

  describe('the retired-slug exclusion (AECI-978)', () => {
    it('withholds a product or vendor slug that now only redirects', async () => {
      await t.db.insert(slugRedirects).values([
        { entity: 'product', fromSlug: 'revit', toSlug: 'revit-2027' },
        { entity: 'vendor', fromSlug: 'autodesk', toSlug: 'autodesk-group' },
      ]);
      const locs = locsOf((await buildCatalogSitemap(t.db, BASE)).xml);
      expect(locs).not.toContain(`${BASE}/products/revit`);
      expect(locs).not.toContain(`${BASE}/vendors/autodesk`);
      expect(locs).toContain(`${BASE}/products/procore`);
    });

    it('does not cross entity kinds', async () => {
      await t.db
        .insert(slugRedirects)
        .values({ entity: 'vendor', fromSlug: 'revit', toSlug: 'somewhere' });
      const locs = locsOf((await buildCatalogSitemap(t.db, BASE)).xml);
      expect(locs).toContain(`${BASE}/products/revit`);
    });

    it("leaves the pair page alone — that is AECI-953's mechanism, not this one", async () => {
      await t.db
        .insert(integrations)
        .values({ id: 'i1', sourceProductId: 'p1', targetProductId: 'p2' });
      await t.db
        .insert(slugRedirects)
        .values({ entity: 'product', fromSlug: 'revit', toSlug: 'revit-2027' });
      const locs = locsOf((await buildCatalogSitemap(t.db, BASE)).xml);
      expect(locs).toContain(`${BASE}/products/procore/integrations/revit`);
    });
  });

  describe('taxonomy terms', () => {
    it('lists every category without a lastmod, whatever its count', async () => {
      await t.db.insert(taxonomyCategories).values({
        id: 'c-sitemap',
        slug: 'sitemap-test-category',
        name: 'Sitemap test',
        description: 'x',
      });
      const { xml } = await buildCatalogSitemap(t.db, BASE);
      expect(xml).toContain(
        `<loc>${BASE}/categories/sitemap-test-category</loc>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>`,
      );
    });

    it('lists a trade at the floor and withholds one below it (AECI-546)', async () => {
      await t.db.insert(taxonomyTrades).values([
        { id: 't-pub', slug: 'sitemap-published', name: 'Published', description: 'x' },
        { id: 't-sub', slug: 'sitemap-unpublished', name: 'Unpublished', description: 'x' },
      ]);
      const tagged = ['p1', 'p2', 'p3', 'p4'].slice(0, TRADE_PUBLISH_MIN_PRODUCTS);
      await t.db
        .insert(productTrades)
        .values(tagged.map((productId) => ({ productId, tradeId: 't-pub' })));
      const below = tagged.slice(0, TRADE_PUBLISH_MIN_PRODUCTS - 1);
      if (below.length > 0) {
        await t.db
          .insert(productTrades)
          .values(below.map((productId) => ({ productId, tradeId: 't-sub' })));
      }

      const locs = locsOf((await buildCatalogSitemap(t.db, BASE)).xml);
      expect(locs).toContain(`${BASE}/trades/sitemap-published`);
      expect(locs).not.toContain(`${BASE}/trades/sitemap-unpublished`);
    });
  });

  it('reads the catalog in ONE batch', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    await buildCatalogSitemap(t.db, BASE);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[0]).toHaveLength(5);
  });

  it('renders the same elements buildSitemapXml would for its entries', async () => {
    const { xml } = await buildCatalogSitemap(t.db, BASE);
    const doc = buildSitemapXml([]);
    // Spliced into an empty document, the fragment is a well-formed urlset.
    const full = doc.replace('</urlset>', `${xml}</urlset>`);
    expect(full.match(/<url>/g)?.length).toBe(full.match(/<\/url>/g)?.length);
  });
});
