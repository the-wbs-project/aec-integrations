/**
 * GET /api/products/:slug/integrations/:otherSlug — the product-PAIR read
 * (Stage 1.5 §7 / AECI-294), against the in-memory D1 harness.
 */

import { ProductPairResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { integrations, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createProductPairHandler } from './integrations';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const app = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/products/:slug/integrations/:otherSlug',
    handler: createProductPairHandler(t.factory),
  });
const get = (url: string) => app().request(url, {}, TEST_ENV, fakeExecutionContext());

// Procore = u(1)/procore (endpoint A), Revit = u(2)/revit (endpoint B).
async function seedProducts() {
  await t.db.insert(products).values([
    { id: u(1), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: u(2), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
  ]);
}

async function integration(
  id: string,
  sourceProductId: string,
  targetProductId: string,
  extra: Partial<typeof integrations.$inferInsert> = {},
) {
  await t.db.insert(integrations).values({
    id,
    sourceProductId,
    targetProductId,
    mechanismKind: 'native',
    direction: 'one-way',
    ...extra,
  });
}

describe('GET /api/products/:slug/integrations/:otherSlug', () => {
  it('returns the pair with the context product on the left', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { name: 'Procore ⇄ Revit' });

    const res = await get('/api/products/procore/integrations/revit');
    expect(res.status).toBe(200);
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.context_product.slug).toBe('procore');
    expect(body.other_product.slug).toBe('revit');
    expect(body.mechanisms).toHaveLength(1);
    expect(body.sync_headline).toEqual({ total: 0, confirmed: 0 });
  });

  it('translates a one-way direction relative to the context product', async () => {
    await seedProducts();
    // Stored source = Procore (A), target = Revit (B), one-way (A → B).
    await integration(u(10), u(1), u(2));

    const fromA = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit')).json(),
    );
    expect(fromA.mechanisms[0]!.direction).toBe('outbound'); // data leaves Procore

    const fromB = ProductPairResponseSchema.parse(
      await (await get('/api/products/revit/integrations/procore')).json(),
    );
    expect(fromB.mechanisms[0]!.direction).toBe('inbound'); // Revit receives
    // Same underlying integration row, whichever way the pair is viewed.
    expect(fromB.mechanisms[0]!.id).toBe(fromA.mechanisms[0]!.id);
  });

  it('reports a bidirectional integration as "both" from either side', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { direction: 'bidirectional' });

    for (const url of [
      '/api/products/procore/integrations/revit',
      '/api/products/revit/integrations/procore',
    ]) {
      const body = ProductPairResponseSchema.parse(await (await get(url)).json());
      expect(body.mechanisms[0]!.direction).toBe('both');
    }
  });

  it('consolidates every integration between the pair, either orientation', async () => {
    await seedProducts();
    await integration(u(10), u(1), u(2), { name: 'A connector', mechanismKind: 'native' });
    // The second mechanism is stored in the opposite orientation (Revit → Procore).
    await integration(u(11), u(2), u(1), { name: 'B connector', mechanismKind: 'partner' });

    const body = ProductPairResponseSchema.parse(
      await (await get('/api/products/procore/integrations/revit')).json(),
    );
    expect(body.mechanisms.map((m) => m.id).sort()).toEqual([u(10), u(11)]);
    // Procore is source of #10 (outbound) and target of #11 (inbound).
    const byId = new Map(body.mechanisms.map((m) => [m.id, m.direction]));
    expect(byId.get(u(10))).toBe('outbound');
    expect(byId.get(u(11))).toBe('inbound');
  });

  it('returns 200 with an empty mechanisms list for an unconnected pair', async () => {
    await seedProducts();
    const res = await get('/api/products/procore/integrations/revit');
    expect(res.status).toBe(200);
    const body = ProductPairResponseSchema.parse(await res.json());
    expect(body.mechanisms).toEqual([]);
    expect(body.sync_headline).toEqual({ total: 0, confirmed: 0 });
  });

  it('404s when either slug is unknown', async () => {
    await seedProducts();
    expect((await get('/api/products/nope/integrations/revit')).status).toBe(404);
    expect((await get('/api/products/procore/integrations/nope')).status).toBe(404);
  });

  it('404s when the two slugs are equal', async () => {
    await seedProducts();
    expect((await get('/api/products/procore/integrations/procore')).status).toBe(404);
  });
});
