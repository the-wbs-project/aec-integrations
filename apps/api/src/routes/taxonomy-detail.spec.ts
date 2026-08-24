/**
 * GET /api/categories|audiences|phases|trades/:slug detail on the Drizzle/D1
 * path (ADR 0016 / AECI-253), against the in-memory D1 harness.
 */

import { AudienceDetailSchema, CategoryDetailSchema, TradeDetailSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  productAudiences,
  productCategories,
  products,
  productTrades,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyTrades,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createTaxonomyDetailHandler } from './taxonomy-detail';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const categoryApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/categories/:slug',
    handler: createTaxonomyDetailHandler(
      { resource: 'category', schema: CategoryDetailSchema },
      t.factory,
    ),
  });
const audienceApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/audiences/:slug',
    handler: createTaxonomyDetailHandler(
      { resource: 'audience', schema: AudienceDetailSchema },
      t.factory,
    ),
  });
const tradeApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/trades/:slug',
    handler: createTaxonomyDetailHandler(
      { resource: 'trade', schema: TradeDetailSchema },
      t.factory,
    ),
  });
const get = (app: ReturnType<typeof categoryApp>, url: string) =>
  app.request(url, {}, TEST_ENV, fakeExecutionContext());

describe('GET /api/categories/:slug', () => {
  it('hydrates the term, its product_count, and embedded products', async () => {
    await t.db
      .insert(taxonomyCategories)
      .values({ id: u(1), slug: 'bim', name: 'BIM', displayOrder: 10 });
    await t.db
      .insert(products)
      .values({ id: u(11), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await t.db.insert(productCategories).values({ productId: u(11), categoryId: u(1) });

    const res = await get(categoryApp(), '/api/categories/bim');
    expect(res.status).toBe(200);
    const body = CategoryDetailSchema.parse(await res.json());
    expect(body.slug).toBe('bim');
    expect(body.product_count).toBe(1);
    expect(body.products.map((p) => p.slug)).toEqual(['revit']);
  });

  it('404s an unknown slug', async () => {
    expect((await get(categoryApp(), '/api/categories/nope')).status).toBe(404);
  });
});

describe('GET /api/audiences/:slug', () => {
  it('reuses the factory for the audience facet', async () => {
    await t.db
      .insert(taxonomyAudiences)
      .values({ id: u(1), slug: 'arch', name: 'Architecture', displayOrder: 10 });
    await t.db
      .insert(products)
      .values({ id: u(11), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await t.db.insert(productAudiences).values({ productId: u(11), audienceId: u(1) });

    const body = AudienceDetailSchema.parse(
      await (await get(audienceApp(), '/api/audiences/arch')).json(),
    );
    expect(body.products.map((p) => p.slug)).toEqual(['revit']);
  });
});

// AECI-541 — §5.5a. `taxonomy_trades.description` is NOT NULL, so fixtures set it.
describe('GET /api/trades/:slug', () => {
  it('hydrates the term, its product_count, and embedded products', async () => {
    await t.db.insert(taxonomyTrades).values({
      id: u(1),
      slug: 'electrical',
      name: 'Electrical',
      description: 'Power distribution, lighting, and low-voltage systems.',
      displayOrder: 10,
    });
    await t.db
      .insert(products)
      .values({ id: u(11), slug: 'accubid', name: 'Accubid', promotionStatus: 'promoted' });
    await t.db.insert(productTrades).values({ productId: u(11), tradeId: u(1) });

    const res = await get(tradeApp(), '/api/trades/electrical');
    expect(res.status).toBe(200);
    const body = TradeDetailSchema.parse(await res.json());
    expect(body.slug).toBe('electrical');
    expect(body.product_count).toBe(1);
    expect(body.products.map((p) => p.slug)).toEqual(['accubid']);
  });

  it('resolves a sub-floor term with an empty product list (no publication gate)', async () => {
    await t.db.insert(taxonomyTrades).values({
      id: u(1),
      slug: 'paving-asphalt',
      name: 'Paving & Asphalt',
      description: 'Pavement construction, striping, and maintenance.',
      displayOrder: 10,
    });

    const res = await get(tradeApp(), '/api/trades/paving-asphalt');
    expect(res.status).toBe(200);
    const body = TradeDetailSchema.parse(await res.json());
    expect(body.product_count).toBe(0);
    expect(body.products).toEqual([]);
  });

  it('404s an unknown slug with resource "trade"', async () => {
    const res = await get(tradeApp(), '/api/trades/nope');
    expect(res.status).toBe(404);
    const payload = (await res.json()) as { error: { details: { resource: string } } };
    expect(payload.error.details.resource).toBe('trade');
  });
});
