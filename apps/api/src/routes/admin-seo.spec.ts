/**
 * `GET /api/admin/seo/queue` and `GET /api/admin/seo/trend` (AECI-818), and
 * `GET /api/admin/seo/funnel` (AECI-823), against
 * the in-memory D1 harness. The derivations are pinned in
 * `lib/seo-queue.spec.ts`. This file pins the wire: validation, the envelope and
 * its notes, paging, absolute URLs, the stored-lane reads, and the real
 * `requireAdmin()` guard (401 and 403).
 */
import {
  SeoFunnelResponseSchema,
  SeoQueueResponseSchema,
  SeoTrendResponseSchema,
} from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  gscRecrawlQueue,
  integrations,
  metricsDaily,
  pageViews,
  products,
  profiles,
  recrawlSubmissions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  createAdminSeoFunnelHandler,
  createAdminSeoQueueHandler,
  createAdminSeoTrendHandler,
  isoWeekMonday,
} from './admin-seo';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const USER = u(901);
const BASE = 'https://www.aecintegrations.com';
// A Tuesday, so the current ISO week starts Monday 2026-11-23.
const NOW = new Date('2026-11-24T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const ENV = { ENV: 'staging', PUBLIC_SITE_URL: `${BASE}/` } as Env;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  const clock = () => NOW;
  a.get('/api/admin/seo/queue', createAdminSeoQueueHandler(t.factory, clock));
  a.get('/api/admin/seo/trend', createAdminSeoTrendHandler(t.factory, clock));
  a.get('/api/admin/seo/funnel', createAdminSeoFunnelHandler(t.factory, clock));
  return a;
}

const get = (path: string, env: Env = ENV) =>
  app().request(path, { method: 'GET' }, env, fakeExecutionContext());

async function seedProducts(n: number) {
  await t.db.insert(products).values(
    Array.from({ length: n }, (_, i) => ({
      id: u(100 + i),
      slug: `p${String(i).padStart(2, '0')}`,
      name: `P${i}`,
      createdAt: daysAgo(60 - i),
    })),
  );
}

describe('GET /api/admin/seo/queue', () => {
  it('lists every lane in order and one page of absolute URLs, oldest first', async () => {
    await seedProducts(3);
    await t.db.insert(gscRecrawlQueue).values({
      url: `${BASE}/products/p00`,
      priority: 2,
      reason: 'product.updated',
      source: 'promote',
      queuedAt: daysAgo(2.5),
    });
    await t.db.insert(pageViews).values({
      path: '/products/:slug',
      concretePath: '/products/p01',
      isBot: true,
      botName: 'Googlebot',
      cfVerifiedBotCategory: 'Search Engine Crawler',
      createdAt: daysAgo(40),
    });

    const res = await get('/api/admin/seo/queue');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = SeoQueueResponseSchema.parse(await res.json());

    expect(body.generated_at).toBe(NOW.toISOString());
    expect(body.window).toEqual({
      from: daysAgo(28),
      to: NOW.toISOString(),
      timezone: 'UTC',
      days: 28,
    });
    expect(body.lanes).toEqual([
      {
        lane: 'reindex',
        engine: 'google',
        count: 1,
        oldest_tier12_age_days: 2.5,
        href: '/admin/reindex',
      },
      { lane: 'uncrawled', engine: 'google', count: 3, oldest_tier12_age_days: null, href: null },
      { lane: 'uncrawled', engine: 'bing', count: 3, oldest_tier12_age_days: null, href: null },
    ]);
    expect(body.items).toMatchObject({
      lane: 'uncrawled',
      engine: 'google',
      page: 1,
      perPage: 25,
      total: 3,
    });
    expect(body.items.data).toEqual([
      {
        url: `${BASE}/products/p00`,
        page_type: 'product',
        published_at: daysAgo(60),
        age_days: 60,
        last_fetch_at: null,
      },
      // A stale crawl: fetched, but before the window.
      {
        url: `${BASE}/products/p01`,
        page_type: 'product',
        published_at: daysAgo(59),
        age_days: 59,
        last_fetch_at: daysAgo(40),
      },
      {
        url: `${BASE}/products/p02`,
        page_type: 'product',
        published_at: daysAgo(58),
        age_days: 58,
        last_fetch_at: null,
      },
    ]);
    expect(body.notes.map((n) => n.code)).toEqual([
      'crawl_coverage_is_gateway_arrivals',
      'crawler_label_includes_inspection_tool',
    ]);
  });

  it('pages the selected lane', async () => {
    await seedProducts(3);
    const body = SeoQueueResponseSchema.parse(
      await (await get('/api/admin/seo/queue?engine=bing&page=2&perPage=2')).json(),
    );
    expect(body.items).toMatchObject({ engine: 'bing', page: 2, perPage: 2, total: 3 });
    expect(body.items.data.map((d) => d.url)).toEqual([`${BASE}/products/p02`]);
  });

  it('lists no pair lane: pairs with no reviews are a Panel 2 count only', async () => {
    // Chris, 2026-11-24: a pair row clears only when a reviewer writes a review,
    // so it is a trend, not a work list.
    await seedProducts(2);
    await t.db.insert(integrations).values({
      id: 'i1',
      sourceProductId: u(100),
      targetProductId: u(101),
      createdAt: daysAgo(10),
    });
    const body = SeoQueueResponseSchema.parse(await (await get('/api/admin/seo/queue')).json());
    expect(body.lanes.map((l) => l.lane)).toEqual(['reindex', 'uncrawled', 'uncrawled']);
    expect((await get('/api/admin/seo/queue?lane=pairs_without_reviews')).status).toBe(400);
  });

  it.each([
    '/api/admin/seo/queue?lane=reindex',
    '/api/admin/seo/queue?lane=nope',
    '/api/admin/seo/queue?engine=yandex',
    '/api/admin/seo/queue?perPage=101',
  ])('400s %s', async (path) => {
    const res = await get(path);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('answers 200 with no lanes and the public_site_url_unset note when the URL is unset', async () => {
    await seedProducts(1);
    const res = await get('/api/admin/seo/queue', { ENV: 'staging' } as Env);
    expect(res.status).toBe(200);
    const body = SeoQueueResponseSchema.parse(await res.json());
    expect(body.lanes).toEqual([]);
    expect(body.items).toMatchObject({ data: [], total: 0 });
    expect(body.notes.map((n) => [n.code, n.severity])).toEqual([
      ['public_site_url_unset', 'warn'],
    ]);
  });
});

describe('isoWeekMonday', () => {
  it('maps every day of a week to its Monday', () => {
    expect(isoWeekMonday(new Date('2026-11-23T00:00:00.000Z'))).toBe('2026-11-23');
    expect(isoWeekMonday(new Date('2026-11-24T12:00:00.000Z'))).toBe('2026-11-23');
    expect(isoWeekMonday(new Date('2026-11-29T23:59:59.000Z'))).toBe('2026-11-23');
  });
});

describe('GET /api/admin/seo/trend', () => {
  it('reads stored lanes per key, Sunday first, and null where nothing was recorded', async () => {
    const row = (day: string, metric: string, value: number) => ({
      day,
      metric,
      value,
      source: 'measured',
      computedAt: `${day}T23:59:00.000Z`,
    });
    await t.db.insert(metricsDaily).values([
      // Week of 2026-11-16: Sunday and an earlier day. Sunday wins.
      row('2026-11-18', 'seo.uncrawled_urls_google', 50),
      row('2026-11-22', 'seo.uncrawled_urls_google', 40),
      // No Sunday row for this key: the latest day in the week is read.
      row('2026-11-19', 'queue.reindex_pending', 7),
      // The pair count is a Panel 2 row, never a Panel 1 lane (Chris, 2026-11-24).
      row('2026-11-22', 'seo.pairs_without_reviews', 880),
      // The current week is excluded.
      row('2026-11-23', 'seo.uncrawled_urls_google', 1),
    ]);

    const res = await get('/api/admin/seo/trend?weeks=2');
    expect(res.status).toBe(200);
    const body = SeoTrendResponseSchema.parse(await res.json());
    expect(body.weeks.map((w) => w.week_start)).toEqual(['2026-11-16', '2026-11-09']);
    expect(body.weeks[0]?.lanes).toEqual({
      reindex_pending: 7,
      // The depth was sampled on 2026-11-19 with no age row: "none", not null.
      reindex_oldest_tier12_age_days: 'none',
      uncrawled_google: 40,
      uncrawled_bing: null,
      pairs_without_reviews: 880,
    });
    expect(Object.values(body.weeks[1]!.lanes).every((v) => v === null)).toBe(true);
  });

  it('never carries the oldest re-index age forward from an earlier day in the week', async () => {
    const row = (day: string, metric: string, value: number) => ({
      day,
      metric,
      value,
      source: 'measured',
      computedAt: `${day}T23:59:00.000Z`,
    });
    await t.db.insert(metricsDaily).values([
      // Week of 2026-11-16: a tier-1 row on Wednesday, the queue empty by Friday.
      row('2026-11-18', 'queue.reindex_pending', 3),
      row('2026-11-18', 'queue.reindex_oldest_tier12_age_days', 4.5),
      row('2026-11-20', 'queue.reindex_pending', 0),
      // Week of 2026-11-09: the age is read on the last sampled day.
      row('2026-11-15', 'queue.reindex_pending', 2),
      row('2026-11-15', 'queue.reindex_oldest_tier12_age_days', 1.2),
    ]);
    const body = SeoTrendResponseSchema.parse(
      await (await get('/api/admin/seo/trend?weeks=3')).json(),
    );
    expect(body.weeks.map((w) => w.lanes.reindex_oldest_tier12_age_days)).toEqual([
      'none',
      1.2,
      // Week of 2026-11-02: nothing sampled, so not recorded.
      null,
    ]);
  });

  it('reads an age row left by an earlier run of the same day as "none"', async () => {
    const at = (day: string, metric: string, value: number, computedAt: string) => ({
      day,
      metric,
      value,
      source: 'measured',
      computedAt,
    });
    const first = '2026-11-23T00:15:00.000Z';
    const rerun = '2026-11-23T02:00:00.000Z';
    await t.db.insert(metricsDaily).values([
      // Week of 2026-11-16: re-run after the tier cleared. Stale age row: "none".
      at('2026-11-22', 'queue.reindex_pending', 0, rerun),
      at('2026-11-22', 'queue.reindex_oldest_tier12_age_days', 6.1, first),
      // Week of 2026-11-09: one run, equal stamps. The age is shown.
      at('2026-11-15', 'queue.reindex_pending', 2, '2026-11-16T00:15:00.000Z'),
      at('2026-11-15', 'queue.reindex_oldest_tier12_age_days', 1.2, '2026-11-16T00:15:00.000Z'),
      // Week of 2026-11-02: an age row with no pending row in the week. Not recorded.
      at('2026-11-08', 'queue.reindex_oldest_tier12_age_days', 3, '2026-11-09T00:15:00.000Z'),
    ]);
    const body = SeoTrendResponseSchema.parse(
      await (await get('/api/admin/seo/trend?weeks=3')).json(),
    );
    expect(body.weeks.map((w) => w.lanes.reindex_oldest_tier12_age_days)).toEqual([
      'none',
      1.2,
      null,
    ]);
    expect(body.weeks[0]?.lanes.reindex_pending).toBe(0);
  });

  it('computes the cohort and the self-reported requests per week', async () => {
    // Two products published in the week of 2026-11-09, one crawled within 7 days.
    await t.db.insert(products).values([
      { id: u(1), slug: 'one', name: 'One', createdAt: '2026-11-10T00:00:00.000Z' },
      { id: u(2), slug: 'two', name: 'Two', createdAt: '2026-11-11T00:00:00.000Z' },
    ]);
    await t.db.insert(pageViews).values({
      path: '/products/:slug',
      concretePath: '/products/one',
      productId: u(1),
      isBot: true,
      botName: 'Googlebot',
      cfVerifiedBotCategory: 'Search Engine Crawler',
      createdAt: '2026-11-12T00:00:00.000Z',
    });
    await t.db.insert(recrawlSubmissions).values([
      {
        url: `${BASE}/products/one`,
        channel: 'gsc_manual',
        outcome: 'requested',
        batchId: 'a',
        submittedAt: '2026-11-12T09:00:00.000Z',
      },
      {
        url: `${BASE}/products/two`,
        channel: 'gsc_manual',
        outcome: 'requested',
        batchId: 'b',
        submittedAt: '2026-11-17T09:00:00.000Z',
      },
    ]);

    const body = SeoTrendResponseSchema.parse(
      await (await get('/api/admin/seo/trend?weeks=2')).json(),
    );
    const [latest, earlier] = body.weeks;
    expect(earlier?.cohort).toEqual({
      published: 2,
      crawled_within_days: 7,
      open: false,
      google: { crawled: 1, rate: 0.5 },
      bing: { crawled: 0, rate: 0 },
    });
    expect(earlier?.requests_self_reported).toBe(1);
    expect(latest?.cohort).toMatchObject({
      published: 0,
      open: true,
      google: { crawled: 0, rate: null },
    });
    expect(latest?.requests_self_reported).toBe(1);
  });

  it('defaults to 12 weeks and rejects a count outside 1 to 26', async () => {
    const body = SeoTrendResponseSchema.parse(await (await get('/api/admin/seo/trend')).json());
    expect(body.weeks).toHaveLength(12);
    // Twelve weeks back from 2026-11-23 reaches before edge verification.
    expect(body.notes.map((n) => n.code)).toContain('crawler_label_unverified');
    for (const weeks of ['0', '27', 'x']) {
      expect((await get(`/api/admin/seo/trend?weeks=${weeks}`)).status).toBe(400);
    }
  });
});

describe('GET /api/admin/seo/funnel', () => {
  const row = (day: string, metric: string, value: number) => ({
    day,
    metric,
    value,
    source: 'measured',
    computedAt: `${day}T23:59:00.000Z`,
  });

  it('answers the envelope with both engines, never summed, and the baseline for Google', async () => {
    // The ingest's newest Pacific date, a week behind the last complete UTC day.
    const end = '2026-11-16';
    await t.db
      .insert(metricsDaily)
      .values([
        row('2026-11-23', 'seo.catalog_urls', 1532),
        row('2026-11-23', 'seo.crawled_urls_google', 410),
        row('2026-11-23', 'seo.crawled_urls_bing', 1010),
        row(end, 'search.google.www_page.clicks', 52),
        row(end, 'search.google.www_page.impressions', 16800),
        row(end, 'search.google.www_page.position_avg', 33.4),
        row(end, 'search.google.www_page.catalog_pages_with_impressions_28d', 380),
        row(end, 'search.google.property.clicks', 60),
        row(end, 'search.google.property.impressions', 20000),
        row(end, 'search.google.property.position_avg', 31),
      ]);

    const res = await get('/api/admin/seo/funnel');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = SeoFunnelResponseSchema.parse(await res.json());

    expect(body.generated_at).toBe(NOW.toISOString());
    expect(body.day).toBe('2026-11-23');
    const [google, bing] = body.engines;
    expect(google?.engine).toBe('google');
    expect(google?.scope).toBe('www_page');
    expect(google?.stages.map((s) => [s.stage, s.count, s.rate])).toEqual([
      ['catalog', 1532, null],
      ['crawled', 410, 0.2676],
      ['impressed', 380, 0.248],
      ['clicked', 52, 0.0031],
    ]);
    expect(google?.baseline?.current).toMatchObject({ clicks: 60, impressions: 20000, ctr: 0.003 });
    expect(google?.baseline?.reference).toMatchObject({ clicks: 41, position_avg: 31.9 });
    // Bing has no ingest rows: stage 1 stays, the rest is omitted, not zeroed.
    expect(bing?.stages.map((s) => s.stage)).toEqual(['catalog', 'crawled']);
    expect(bing?.baseline).toBeNull();
    expect(body.notes.map((n) => n.code)).toEqual([
      'crawl_coverage_is_gateway_arrivals',
      'crawler_label_includes_inspection_tool',
      'indexed_is_impression_lower_bound',
      // One daily date recorded of 28: the click totals cover one day.
      'search_window_incomplete',
      'search_ingest_absent',
    ]);
  });
});

describe('/api/admin/seo/* — authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'staging', SUPABASE_URL, PUBLIC_SITE_URL: BASE } as Env;

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guarded() {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    const guard = requireAdmin({ getKey: jwks.getKey, dbFor: t.factory });
    a.get('/api/admin/seo/queue', guard, createAdminSeoQueueHandler(t.factory));
    a.get('/api/admin/seo/trend', guard, createAdminSeoTrendHandler(t.factory));
    a.get('/api/admin/seo/funnel', guard, createAdminSeoFunnelHandler(t.factory));
    return a;
  }

  const call = (path: string, token?: string) =>
    guarded().request(
      path,
      { method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  it.each(['/api/admin/seo/queue', '/api/admin/seo/trend', '/api/admin/seo/funnel'])(
    '401s, 403s and admits on %s',
    async (path) => {
      expect((await call(path)).status).toBe(401);
      await t.db.insert(profiles).values({ id: USER, role: 'reviewer' }).onConflictDoNothing();
      const userToken = await jwks.mintToken({ sub: USER, supabaseUrl: SUPABASE_URL });
      expect((await call(path, userToken)).status).toBe(403);
      const adminToken = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
      expect((await call(path, adminToken)).status).toBe(200);
    },
  );
});
