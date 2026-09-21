import { describe, expect, it } from 'vitest';

import { findProducts, MAX_ROWS } from './find-products';
import { seedCatalog } from '../test/catalog-fixture';

describe('find_products', () => {
  it('returns the short row shape for every promoted product', async () => {
    // Guards: the documented output is slug/name/vendor_name/product_role and
    // nothing else — a `SELECT *` regression would widen this silently.
    const t = await seedCatalog();
    const rows = await findProducts(t.db, {});
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(rows[0]!).sort()).toEqual(['name', 'product_role', 'slug', 'vendor_name']);
    t.dispose();
  });

  it('excludes unpromoted products', async () => {
    // Guards: membership is the same rule the public site uses; an agent that
    // can read a pending row can answer from a record the site would not show.
    const t = await seedCatalog();
    const rows = await findProducts(t.db, {});
    expect(rows.map((r) => r.slug)).not.toContain('hidden-product');
    t.dispose();
  });

  it('orders case-insensitively with an id tiebreaker (AECI-825)', async () => {
    // Guards: under BINARY collation `ADP` beats `Access` on D vs c, and eSUB /
    // iSqFt / openBIM sort after Zoho. NOCASE also makes the two ADP rows EQUAL,
    // so the trailing `id ASC` is what stops a capped page dropping one.
    const t = await seedCatalog();
    const rows = await findProducts(t.db, {});
    expect(rows.map((r) => r.name)).toEqual([
      'Access Coins Evo',
      'ADP Workforce Now',
      'adp workforce now',
      'Agave ERP Sync',
      'eSUB',
      'iSqFt',
      'openBIM',
      'Zoho',
    ]);
    t.dispose();
  });

  it('keeps the NOCASE tie stable across a page boundary', async () => {
    // Guards: AECI-99. With `ADP Workforce Now` and `adp workforce now` EQUAL,
    // two successive limits must agree on which one comes first.
    const t = await seedCatalog();
    const first = await findProducts(t.db, { limit: 2 });
    const wider = await findProducts(t.db, { limit: 3 });
    expect(first.map((r) => r.slug)).toEqual(wider.slice(0, 2).map((r) => r.slug));
    expect(wider[1]!.slug).toBe('adp-workforce-now');
    expect(wider[2]!.slug).toBe('adp-workforce-now-eu');
    t.dispose();
  });

  it('filters by name substring, case-insensitively', async () => {
    const t = await seedCatalog();
    const rows = await findProducts(t.db, { name: 'coins' });
    expect(rows.map((r) => r.slug)).toEqual(['access-coins-evo']);
    t.dispose();
  });

  it('treats LIKE wildcards in the model-supplied name as literals', async () => {
    // Guards: an unescaped `%` from the model would match the whole catalog.
    const t = await seedCatalog();
    expect(await findProducts(t.db, { name: '%' })).toEqual([]);
    expect(await findProducts(t.db, { name: '_' })).toEqual([]);
    t.dispose();
  });

  it('filters by category slug, product role and API docs', async () => {
    const t = await seedCatalog();
    expect((await findProducts(t.db, { category: 'estimating' })).map((r) => r.slug)).toEqual([
      'isqft',
    ]);
    expect((await findProducts(t.db, { trade: 'roofing' })).map((r) => r.slug)).toEqual(['esub']);
    expect((await findProducts(t.db, { productRole: 'connector' })).map((r) => r.slug)).toEqual([
      'agave-erp-sync',
    ]);
    expect((await findProducts(t.db, { hasApiDocs: false })).map((r) => r.slug).sort()).toEqual([
      'adp-workforce-now-eu',
      'esub',
      'openbim',
    ]);
    t.dispose();
  });

  it('ANDs filters across dimensions', async () => {
    const t = await seedCatalog();
    expect(await findProducts(t.db, { category: 'estimating', hasApiDocs: false })).toEqual([]);
    t.dispose();
  });

  it('returns an empty array when nothing matches', async () => {
    const t = await seedCatalog();
    expect(await findProducts(t.db, { name: 'no-such-product' })).toEqual([]);
    t.dispose();
  });

  it('names only a PROMOTED primary vendor', async () => {
    // Guards: eSUB's vendor is `pending`, so its name must not ride out on a
    // promoted product. Zoho's vendor is promoted and must.
    const t = await seedCatalog();
    const rows = await findProducts(t.db, {});
    const bySlug = new Map(rows.map((r) => [r.slug, r.vendor_name]));
    expect(bySlug.get('zoho')).toBe('Acme Software');
    expect(bySlug.get('esub')).toBeNull();
    t.dispose();
  });

  it('caps rows at MAX_ROWS regardless of the requested limit', async () => {
    // Guards: rule 3 — the model can ask for fewer, never for more.
    const t = await seedCatalog();
    const rows = await findProducts(t.db, { limit: 1000 as number });
    expect(rows.length).toBeLessThanOrEqual(MAX_ROWS);
    t.dispose();
  });

  it('never emits SELECT * ', async () => {
    // Guards: rule 1, asserted against the source rather than the result, because
    // a `SELECT *` only widens the output once a column is added upstream.
    const { readSourceWithoutComments } = await import('../test/source-scan');
    const src = readSourceWithoutComments(new URL('./find-products.ts', import.meta.url));
    expect(src).not.toMatch(/SELECT\s+\*/i);
  });
});
