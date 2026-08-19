/**
 * POST /api/page-views on the Drizzle/D1 path (ADR 0016 / AECI-253), against the
 * in-memory D1 harness. The insert is deferred via waitUntil, so the test uses a
 * settling execution context.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  pageViews,
  products,
  profiles,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
} from '../db/schema';
import { makeTestJwks } from '../test/auth';
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

/**
 * AECI-585 (`ADMIN_PANEL_SPEC.md` §7.3). Everything here is about what the row can
 * still say a month later — none of it is derivable after the fact, which is why
 * each case asserts the stored column rather than the response.
 */
describe('POST /api/page-views — AECI-585 ingest fixes', () => {
  describe('taxonomy entities (fix 1)', () => {
    /** All four facets, `trade` included — it is the fourth facet (§5.5a) and the
     *  one a product/vendor-shaped implementation forgets. */
    const FACETS = [
      { kind: 'category', segment: 'categories', seed: taxonomyCategories },
      { kind: 'audience', segment: 'audiences', seed: taxonomyAudiences },
      { kind: 'phase', segment: 'phases', seed: taxonomyPhases },
      { kind: 'trade', segment: 'trades', seed: taxonomyTrades },
    ] as const;

    it.each(FACETS)('records which $kind term was viewed', async ({ kind, segment, seed }) => {
      await t.db.insert(seed).values({
        id: u(10),
        slug: `${kind}-slug`,
        name: `A ${kind}`,
        // `taxonomy_trades.description` is NOT NULL (TRADES_VOCABULARY.md); the
        // other three accept it, so setting it unconditionally keeps one seed shape.
        description: `A ${kind} description`,
      });

      const { res, settle } = post({
        route: `/${segment}/:slug`,
        path: `/${segment}/${kind}-slug`,
        entity_type: kind,
        entity_id: u(10),
      });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.taxonomyKind).toBe(kind);
      expect(rows[0]!.taxonomyId).toBe(u(10));
      // The taxonomy columns are additive: the product/vendor FKs stay null.
      expect(rows[0]!.productId).toBeNull();
      expect(rows[0]!.vendorId).toBeNull();
    });

    it('stores neither kind nor id for a term that does not exist', async () => {
      const { res, settle } = post({
        route: '/categories/:slug',
        entity_type: 'category',
        entity_id: u(999),
      });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows).toHaveLength(1);
      // Not `{ kind: 'category', id: null }` — a dangling kind would read as "some
      // category was viewed" and inflate every per-facet count with unattributable rows.
      expect(rows[0]!.taxonomyKind).toBeNull();
      expect(rows[0]!.taxonomyId).toBeNull();
    });

    it('ignores a non-UUID taxonomy id without failing the write', async () => {
      const { res, settle } = post({
        route: '/trades/:slug',
        entity_type: 'trade',
        entity_id: 'not-a-uuid',
      });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.taxonomyKind).toBeNull();
      expect(rows[0]!.taxonomyId).toBeNull();
    });

    it('ignores an entity_type outside the known set', async () => {
      const { res, settle } = post({
        route: '/integrations/:slug',
        entity_type: 'integration',
        entity_id: u(10),
      });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows[0]!.taxonomyKind).toBeNull();
      expect(rows[0]!.taxonomyId).toBeNull();
      expect(rows[0]!.productId).toBeNull();
    });
  });

  describe('concrete path (fix 2)', () => {
    it('stores the concrete path alongside the route pattern', async () => {
      const { res, settle } = post({
        route: '/categories/:slug',
        path: '/categories/bim-coordination',
      });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      // Both, not one replacing the other: grouping "top pages" wants the pattern,
      // naming the row wants the concrete path.
      expect(rows[0]!.path).toBe('/categories/:slug');
      expect(rows[0]!.concretePath).toBe('/categories/bim-coordination');
    });

    it('falls back to `route` when the writer sends no explicit path', async () => {
      // The browser tracker's shape: `route` is already concrete, so the fallback is
      // the right answer rather than a degraded one.
      const { res, settle } = post({ route: '/products/revit' });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows[0]!.path).toBe('/products/revit');
      expect(rows[0]!.concretePath).toBe('/products/revit');
    });
  });

  describe('navigation flag (fix 3)', () => {
    it.each(['spa', 'arrival'] as const)('stores navigation=%s as sent', async (navigation) => {
      const { res, settle } = post({ route: '/products/revit', navigation });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows[0]!.navigation).toBe(navigation);
    });

    it('leaves navigation null when the writer does not say', async () => {
      const { res, settle } = post({ route: '/products/revit' });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      // Never inferred. Guessing would recreate the very conflation the column
      // exists to undo (a same-origin `Referer` classifies as `Direct`).
      expect(rows[0]!.navigation).toBeNull();
    });

    it('400s an unrecognized navigation value', async () => {
      const { res } = post({ route: '/', navigation: 'prefetch' });
      expect((await res).status).toBe(400);
      expect(await t.db.select().from(pageViews)).toHaveLength(0);
    });

    it('records an SPA hop as spa even though its same-origin Referer reads Direct', async () => {
      const { res, settle } = post(
        { route: '/products/revit', navigation: 'spa' },
        { referer: 'https://www.aecintegrations.com/products' },
      );
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      // This pair IS the fix: `Direct` was a mixed bucket precisely because these
      // two columns used to collapse into one.
      expect(rows[0]!.referrerSource).toBe('Direct');
      expect(rows[0]!.navigation).toBe('spa');
    });
  });

  describe('cf_as_organization (fix 5)', () => {
    it('stores the AS holder name from the trusted SSR header', async () => {
      const { res, settle } = post(
        { route: '/' },
        { 'x-aeci-cf-as-organization': 'Biznet Networks', 'x-aeci-cf-asn': '23700' },
      );
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows[0]!.cfAsOrganization).toBe('Biznet Networks');
      expect(rows[0]!.cfAsn).toBe(23700);
    });

    it('leaves cf_as_organization null when the header is absent', async () => {
      const { res, settle } = post({ route: '/' });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows[0]!.cfAsOrganization).toBeNull();
    });

    it('does not let the AS organization influence bot classification', async () => {
      // §13 D10 constraint 1: the holder name is a READ-side label. It must never
      // reach `is_bot`, which is written once and permanently.
      const { res, settle } = post(
        { route: '/' },
        {
          'x-aeci-cf-as-organization': 'Amazon.com, Inc.',
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        },
      );
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows[0]!.cfAsOrganization).toBe('Amazon.com, Inc.');
      expect(rows[0]!.isBot).toBe(false);
    });
  });

  describe('is_operator (§13 D13)', () => {
    const ADMIN_ID = '00000000-0000-4000-8000-00000000ad11';
    const SUPABASE_URL = 'https://test-project.supabase.co';

    let jwks: Awaited<ReturnType<typeof makeTestJwks>>;
    beforeAll(async () => {
      jwks = await makeTestJwks();
    });

    /** Same `post()` as above, plus the offline-JWKS seam and a `SUPABASE_URL`
     *  so the operator check can actually run. */
    function postAs(headers: Record<string, string>) {
      const app = buildAppWithHandler({
        method: 'post',
        path: '/api/page-views',
        handler: createPageViewsHandler(t.factory, { getKey: jwks.getKey }),
      });
      const { ctx, settle } = settlingCtx();
      return {
        res: app.request(
          '/api/page-views',
          {
            method: 'POST',
            body: JSON.stringify({ route: '/products/revit' }),
            headers: { 'content-type': 'application/json', ...headers },
          },
          { ...TEST_ENV, SUPABASE_URL },
          ctx,
        ),
        settle,
      };
    }

    it('flags a view made by a verified admin session', async () => {
      await t.db.insert(profiles).values({ id: ADMIN_ID, role: 'admin' });
      const token = await jwks.mintToken({ sub: ADMIN_ID, supabaseUrl: SUPABASE_URL });

      const { res, settle } = postAs({ Authorization: `Bearer ${token}` });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      // Recorded, not dropped — the read side excludes it (`NOT_INTERNAL`).
      expect(rows).toHaveLength(1);
      expect(rows[0]!.isOperator).toBe(true);
    });

    it('leaves is_operator false for a signed-in NON-admin', async () => {
      const userId = '00000000-0000-4000-8000-000000000042';
      await t.db.insert(profiles).values({ id: userId, role: 'reviewer' });
      const token = await jwks.mintToken({ sub: userId, supabaseUrl: SUPABASE_URL });

      const { res, settle } = postAs({ Authorization: `Bearer ${token}` });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows[0]!.isOperator).toBe(false);
    });

    it('leaves is_operator false for an anonymous view', async () => {
      const { res, settle } = postAs({});
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows[0]!.isOperator).toBe(false);
    });

    it('still writes the row when the session cannot be verified', async () => {
      // Fail-open: an auth hiccup must cost the flag, never the page view.
      const { res, settle } = postAs({ Authorization: 'Bearer not-a-jwt' });
      expect((await res).status).toBe(204);
      await settle();

      const rows = await t.db.select().from(pageViews);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.isOperator).toBe(false);
    });
  });
});
