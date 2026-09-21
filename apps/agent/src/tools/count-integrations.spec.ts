import { describe, expect, it } from 'vitest';

import {
  CONNECTOR_EVIDENCED_BUCKET,
  countIntegrations,
  UNKNOWN_MECHANISM_BUCKET,
} from './count-integrations';
import { addEvidencedPair, addIntegration, IDS, seedCatalog } from '../test/catalog-fixture';

describe('count_integrations', () => {
  it('groups direct edges by mechanism kind', async () => {
    const t = await seedCatalog();
    addIntegration(t, 'i1', IDS.zoho, IDS.esub, 'api');
    addIntegration(t, 'i2', IDS.isqft, IDS.zoho, 'api');
    addIntegration(t, 'i3', IDS.zoho, IDS.openbim, 'webhook');

    const result = await countIntegrations(t.db, { productSlug: 'zoho' });
    expect(result.found).toBe(true);
    expect(result.total).toBe(3);
    expect(result.by_mechanism).toEqual([
      { mechanism: 'api', count: 2 },
      { mechanism: 'webhook', count: 1 },
    ]);
    t.dispose();
  });

  it('counts BOTH tables — AECI-721, and a live defect class if it does not', async () => {
    // Guards: the delivered tier is split across `integrations` and
    // `connector_evidenced_pairs` (STAGE_1_5_SPEC.md §13.1). A single-table
    // version passes every other test in this file; it only goes wrong once rows
    // exist on the other side, and production has carried them since AECI-764.
    const t = await seedCatalog();
    addIntegration(t, 'i1', IDS.zoho, IDS.esub, 'native');
    addEvidencedPair(t, 'e1', IDS.zoho, IDS.isqft);
    addEvidencedPair(t, 'e2', IDS.zoho, IDS.openbim);

    const result = await countIntegrations(t.db, { productSlug: 'zoho' });
    expect(result.total).toBe(3);
    expect(result.by_mechanism).toEqual([
      { mechanism: CONNECTOR_EVIDENCED_BUCKET, count: 2 },
      { mechanism: 'native', count: 1 },
    ]);
    t.dispose();
  });

  it('counts an evidenced pair for both of its endpoints', async () => {
    // Guards: the second arm's predicate must cover `product_a_id` AND
    // `product_b_id`, not just the one the fixture happened to sort first.
    const t = await seedCatalog();
    addEvidencedPair(t, 'e1', IDS.zoho, IDS.isqft);
    expect((await countIntegrations(t.db, { productSlug: 'zoho' })).total).toBe(1);
    expect((await countIntegrations(t.db, { productSlug: 'isqft' })).total).toBe(1);
    t.dispose();
  });

  it('counts a direct edge from either endpoint', async () => {
    const t = await seedCatalog();
    addIntegration(t, 'i1', IDS.zoho, IDS.esub, 'api');
    expect((await countIntegrations(t.db, { productSlug: 'zoho' })).total).toBe(1);
    expect((await countIntegrations(t.db, { productSlug: 'esub' })).total).toBe(1);
    t.dispose();
  });

  it('requires BOTH endpoints promoted', async () => {
    // Guards: the membership rule copied from `algolia-drift-deps.ts`. An edge
    // onto an unpromoted product is not on the public site and must not count.
    const t = await seedCatalog();
    addIntegration(t, 'i1', IDS.zoho, IDS.unpromoted, 'api');
    const result = await countIntegrations(t.db, { productSlug: 'zoho' });
    expect(result.total).toBe(0);
    expect(result.by_mechanism).toEqual([]);
    t.dispose();
  });

  it('buckets a NULL mechanism kind rather than dropping the edge', async () => {
    // Guards: `GROUP BY` on a NULL column would report a `null` mechanism to the
    // model; COALESCE names it instead.
    const t = await seedCatalog();
    addIntegration(t, 'i1', IDS.zoho, IDS.esub, null);
    const result = await countIntegrations(t.db, { productSlug: 'zoho' });
    expect(result.by_mechanism).toEqual([{ mechanism: UNKNOWN_MECHANISM_BUCKET, count: 1 }]);
    t.dispose();
  });

  it('returns an empty result for a product with no edges', async () => {
    const t = await seedCatalog();
    expect(await countIntegrations(t.db, { productSlug: 'zoho' })).toEqual({
      product_slug: 'zoho',
      found: true,
      total: 0,
      by_mechanism: [],
    });
    t.dispose();
  });

  it('reports found: false for an unknown or unpromoted slug', async () => {
    const t = await seedCatalog();
    expect((await countIntegrations(t.db, { productSlug: 'no-such-thing' })).found).toBe(false);
    expect((await countIntegrations(t.db, { productSlug: 'hidden-product' })).found).toBe(false);
    t.dispose();
  });

  it('never emits SELECT *', async () => {
    const { readSourceWithoutComments } = await import('../test/source-scan');
    const src = readSourceWithoutComments(new URL('./count-integrations.ts', import.meta.url));
    expect(src).not.toMatch(/SELECT\s+\*/i);
  });
});
