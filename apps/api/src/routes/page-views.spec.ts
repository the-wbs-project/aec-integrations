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

  it('persists ref_source / ref_token campaign attribution (AECI-243)', async () => {
    const { res, settle } = post({
      route: '/',
      ref_source: 'waitlist',
      ref_token: 'tok-abc123',
    });
    expect((await res).status).toBe(204);
    await settle();

    const rows = await t.db.select().from(pageViews);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refSource).toBe('waitlist');
    expect(rows[0]!.refToken).toBe('tok-abc123');
  });

  it('leaves ref_source / ref_token null for an ordinary view', async () => {
    const { res, settle } = post({ route: '/products/revit' });
    expect((await res).status).toBe(204);
    await settle();

    const rows = await t.db.select().from(pageViews);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.refSource).toBeNull();
    expect(rows[0]!.refToken).toBeNull();
  });

  it('classifies a crawler User-Agent as a bot at ingest (AECI-526)', async () => {
    const { res, settle } = post(
      { route: '/' },
      { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
    );
    expect((await res).status).toBe(204);
    await settle();

    const rows = await t.db.select().from(pageViews);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isBot).toBe(true);
    expect(rows[0]!.botName).toBe('Googlebot');
  });

  it('classifies an ordinary browser view as human at ingest (AECI-526)', async () => {
    const { res, settle } = post(
      { route: '/' },
      {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      },
    );
    expect((await res).status).toBe(204);
    await settle();

    const rows = await t.db.select().from(pageViews);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.isBot).toBe(false);
    expect(rows[0]!.botName).toBeNull();
  });

  it('classifies the traffic source + stores the referrer host from the Referer header (AECI-526)', async () => {
    const { res, settle } = post({ route: '/' }, { referer: 'https://www.linkedin.com/feed/' });
    expect((await res).status).toBe(204);
    await settle();

    const rows = await t.db.select().from(pageViews);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.referrerSource).toBe('LinkedIn');
    expect(rows[0]!.referrer).toBe('www.linkedin.com');
  });

  it('classifies a same-origin Referer as Direct (AECI-526)', async () => {
    const { res, settle } = post(
      { route: '/products/revit' },
      { referer: 'https://www.aecintegrations.com/products' },
    );
    expect((await res).status).toBe(204);
    await settle();

    const rows = await t.db.select().from(pageViews);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.referrerSource).toBe('Direct');
    expect(rows[0]!.referrer).toBeNull();
  });

  it('400s a malformed body and inserts nothing', async () => {
    const { res } = post('not json');
    expect((await res).status).toBe(400);
    expect(await t.db.select().from(pageViews)).toHaveLength(0);
  });
});
