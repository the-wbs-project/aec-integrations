/**
 * POST /api/page-views on the Drizzle/D1 path (ADR 0016 / AECI-253), against the
 * in-memory D1 harness. The insert is deferred via waitUntil, so the test uses a
 * settling execution context.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, TEST_ENV } from '../test/helpers';
import { createPageViewsHandler } from './page-views';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/** Execution context that collects waitUntil promises so the deferred insert can
 *  be awaited before asserting. */
function settlingCtx() {
  const promises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => promises.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, settle: () => Promise.all(promises) };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  const app = buildAppWithHandler({
    method: 'post',
    path: '/api/page-views',
    handler: createPageViewsHandler(t.factory),
  });
  const { ctx, settle } = settlingCtx();
  return {
    res: app.request(
      '/api/page-views',
      {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...headers },
      },
      TEST_ENV,
      ctx,
    ),
    settle,
  };
}

describe('POST /api/page-views', () => {
  it('returns 204 and inserts a row resolving the product entity', async () => {
    await t.db
      .insert(products)
      .values({ id: u(1), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });

    const { res, settle } = post({
      route: '/products/revit',
      entity_type: 'product',
      entity_id: u(1),
    });
    expect((await res).status).toBe(204);
    await settle();

    const rows = await t.db.select().from(pageViews);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('/products/revit');
    expect(rows[0]!.productId).toBe(u(1));
  });

  it('stores null product_id for an unknown / non-UUID entity', async () => {
    const { res, settle } = post({
      route: '/products/ghost',
      entity_type: 'product',
      entity_id: u(999),
    });
    expect((await res).status).toBe(204);
    await settle();
    const rows = await t.db.select().from(pageViews);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.productId).toBeNull();
  });

  it('400s a malformed body and inserts nothing', async () => {
    const { res } = post('not json');
    expect((await res).status).toBe(400);
    expect(await t.db.select().from(pageViews)).toHaveLength(0);
  });
});
