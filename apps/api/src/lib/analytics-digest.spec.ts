/**
 * Unit tests for the daily operator analytics digest (AECI-526):
 *   - `dailyWindows` — the prior-complete-UTC-day windowing (+ delta baseline).
 *   - `collectAnalyticsMetrics` — the D1 aggregation, exercised against the in-memory
 *     D1 harness so the real Drizzle SQL (window range, product join, top-N) runs.
 *   - `buildAnalyticsDigest` — the pure formatter (subject / deltas / top-product list).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews, products, profiles, reviews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  buildAnalyticsDigest,
  collectAnalyticsMetrics,
  dailyWindows,
  type AnalyticsMetrics,
} from './analytics-digest';

describe('dailyWindows', () => {
  it('reports the prior complete UTC day plus the day before it', () => {
    const w = dailyWindows(new Date('2026-07-24T12:00:00.000Z'));
    expect(w).toEqual({
      startIso: '2026-07-23T00:00:00.000Z',
      endIso: '2026-07-24T00:00:00.000Z',
      priorStartIso: '2026-07-22T00:00:00.000Z',
      dayLabel: '2026-07-23',
    });
  });

  it('crosses a month boundary correctly', () => {
    const w = dailyWindows(new Date('2026-08-01T12:00:00.000Z'));
    expect(w.dayLabel).toBe('2026-07-31');
    expect(w.startIso).toBe('2026-07-31T00:00:00.000Z');
    expect(w.endIso).toBe('2026-08-01T00:00:00.000Z');
    expect(w.priorStartIso).toBe('2026-07-30T00:00:00.000Z');
  });
});

describe('collectAnalyticsMetrics', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  // Reported day = 2026-07-23; prior day = 2026-07-22.
  const window = dailyWindows(new Date('2026-07-24T12:00:00.000Z'));

  it('aggregates page views, top products, sign-ins, and moderation depth over the window', async () => {
    await t.db.insert(products).values([
      { id: 'p1', slug: 'p1', name: 'P1' },
      { id: 'p2', slug: 'p2', name: 'P2' },
    ]);
    await t.db.insert(pageViews).values([
      // reported day (07-23): p1×2, p2×1, one non-product view → 4 views, top = p1(2), p2(1)
      { path: '/products/p1', productId: 'p1', createdAt: '2026-07-23T10:00:00.000Z' },
      { path: '/products/p1', productId: 'p1', createdAt: '2026-07-23T11:00:00.000Z' },
      { path: '/products/p2', productId: 'p2', createdAt: '2026-07-23T12:00:00.000Z' },
      { path: '/', createdAt: '2026-07-23T13:00:00.000Z' },
      // prior day (07-22): 2 views
      { path: '/products/p1', productId: 'p1', createdAt: '2026-07-22T10:00:00.000Z' },
      { path: '/', createdAt: '2026-07-22T11:00:00.000Z' },
      // outside both windows (today) — must not be counted
      { path: '/', createdAt: '2026-07-24T09:00:00.000Z' },
    ]);
    await t.db.insert(profiles).values([
      { id: 'u1', createdAt: '2026-07-23T09:00:00.000Z' }, // new today
      { id: 'u2', createdAt: '2026-07-23T18:00:00.000Z' }, // new today
      { id: 'u3', createdAt: '2026-07-22T09:00:00.000Z' }, // new prior day
      { id: 'u4', createdAt: '2026-07-01T09:00:00.000Z' }, // older
    ]);
    const review = (id: string, status: string) => ({
      id,
      productId: 'p1',
      ratingOverall: 5,
      ratingOnboarding: 5,
      title: 't',
      body: 'b',
      status,
      createdAt: '2026-07-23T10:00:00.000Z',
    });
    await t.db
      .insert(reviews)
      .values([review('r1', 'pending'), review('r2', 'pending'), review('r3', 'approved')]);

    const m = await collectAnalyticsMetrics(t.db, window);

    // Rows seeded without `is_bot` are NULL → count as human (`is_bot IS NOT 1`).
    expect(m.pageViews).toEqual({ day: 4, prior: 2 });
    expect(m.botPageViews).toEqual({ day: 0, prior: 0 });
    expect(m.botActivity).toEqual([]);
    // Rows seeded without `referrer_source` are NULL → excluded from the breakdown.
    expect(m.referrers).toEqual([]);
    expect(m.newUsers).toEqual({ day: 2, prior: 1 });
    expect(m.totalUsers).toBe(4);
    expect(m.pendingModeration).toBe(2);
    expect(m.topProducts).toEqual([
      { name: 'P1', slug: 'p1', views: 2 },
      { name: 'P2', slug: 'p2', views: 1 },
    ]);
  });

  it('splits human vs bot page views and groups crawler activity by bot_name', async () => {
    await t.db.insert(products).values([{ id: 'p1', slug: 'p1', name: 'P1' }]);
    await t.db.insert(pageViews).values([
      // reported day (07-23): 2 human views (one on p1), 3 bot views (two Googlebot on p1, one Bingbot)
      {
        path: '/products/p1',
        productId: 'p1',
        isBot: false,
        createdAt: '2026-07-23T10:00:00.000Z',
      },
      { path: '/', isBot: false, createdAt: '2026-07-23T11:00:00.000Z' },
      {
        path: '/products/p1',
        productId: 'p1',
        isBot: true,
        botName: 'Googlebot',
        createdAt: '2026-07-23T12:00:00.000Z',
      },
      {
        path: '/products/p1',
        productId: 'p1',
        isBot: true,
        botName: 'Googlebot',
        createdAt: '2026-07-23T12:05:00.000Z',
      },
      { path: '/', isBot: true, botName: 'Bingbot', createdAt: '2026-07-23T13:00:00.000Z' },
      // prior day (07-22): 1 human, 1 bot
      { path: '/', isBot: false, createdAt: '2026-07-22T10:00:00.000Z' },
      { path: '/', isBot: true, botName: 'Bingbot', createdAt: '2026-07-22T11:00:00.000Z' },
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    expect(m.pageViews).toEqual({ day: 2, prior: 1 });
    expect(m.botPageViews).toEqual({ day: 3, prior: 1 });
    // Bot views on p1 are excluded from "most viewed products" → p1 has 1 human view.
    expect(m.topProducts).toEqual([{ name: 'P1', slug: 'p1', views: 1 }]);
    expect(m.botActivity).toEqual([
      { name: 'Googlebot', crawls: 2 },
      { name: 'Bingbot', crawls: 1 },
    ]);
  });

  it('breaks down HUMAN traffic sources by referrer_source, excluding bots and nulls', async () => {
    await t.db.insert(pageViews).values([
      // reported day humans with a source
      {
        path: '/',
        isBot: false,
        referrerSource: 'LinkedIn',
        createdAt: '2026-07-23T10:00:00.000Z',
      },
      {
        path: '/',
        isBot: false,
        referrerSource: 'LinkedIn',
        createdAt: '2026-07-23T10:05:00.000Z',
      },
      { path: '/', isBot: false, referrerSource: 'Google', createdAt: '2026-07-23T11:00:00.000Z' },
      { path: '/', isBot: false, referrerSource: 'Direct', createdAt: '2026-07-23T12:00:00.000Z' },
      // a bot with a source — excluded from the human breakdown
      {
        path: '/',
        isBot: true,
        botName: 'Googlebot',
        referrerSource: 'Google',
        createdAt: '2026-07-23T12:30:00.000Z',
      },
      // a human without a source (pre-classifier row) — excluded (null)
      { path: '/', isBot: false, createdAt: '2026-07-23T13:00:00.000Z' },
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    expect(m.referrers).toEqual([
      { source: 'LinkedIn', views: 2 },
      { source: 'Google', views: 1 },
      { source: 'Direct', views: 1 },
    ]);
  });

  // AECI-575 / ADMIN_PANEL_SPEC §9.6 — the read-side half. The tracker no longer
  // writes these rows, but the ones already in the table must stop counting too,
  // or every pre-fix day stays inflated relative to every post-fix day.
  it('excludes operator-only paths (/admin/*, /account) from every page_views read', async () => {
    await t.db.insert(products).values([{ id: 'p1', slug: 'p1', name: 'P1' }]);
    await t.db.insert(pageViews).values([
      // Real traffic on the reported day: 2 human views, 1 of them on p1.
      {
        path: '/products/p1',
        productId: 'p1',
        isBot: false,
        referrerSource: 'Google',
        createdAt: '2026-07-23T10:00:00.000Z',
      },
      { path: '/', isBot: false, referrerSource: 'Direct', createdAt: '2026-07-23T11:00:00.000Z' },
      // Historical operator navigation — must not count anywhere.
      {
        path: '/admin',
        isBot: false,
        referrerSource: 'Direct',
        createdAt: '2026-07-23T12:00:00.000Z',
      },
      {
        path: '/admin/reviews',
        isBot: false,
        referrerSource: 'Direct',
        createdAt: '2026-07-23T12:05:00.000Z',
      },
      {
        path: '/admin/traffic/breakdown',
        isBot: false,
        referrerSource: 'Direct',
        createdAt: '2026-07-23T12:10:00.000Z',
      },
      {
        path: '/account',
        isBot: false,
        referrerSource: 'Direct',
        createdAt: '2026-07-23T12:15:00.000Z',
      },
      // An admin row that somehow carries a product id (a stale client) — still out.
      {
        path: '/admin/reviews',
        productId: 'p1',
        isBot: false,
        createdAt: '2026-07-23T12:20:00.000Z',
      },
      // A crawler that wandered onto an admin path — excluded from crawler activity too.
      {
        path: '/admin/reviews',
        isBot: true,
        botName: 'Googlebot',
        createdAt: '2026-07-23T12:25:00.000Z',
      },
      // Prior day: 1 real view + 1 admin view.
      { path: '/', isBot: false, createdAt: '2026-07-22T10:00:00.000Z' },
      { path: '/admin/requests', isBot: false, createdAt: '2026-07-22T11:00:00.000Z' },
      // Public paths that merely share a prefix must keep counting.
      {
        path: '/administrators',
        isBot: false,
        referrerSource: 'Google',
        createdAt: '2026-07-23T14:00:00.000Z',
      },
      { path: '/products/admin-tool', isBot: false, createdAt: '2026-07-23T14:05:00.000Z' },
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    // 2 real + 2 prefix look-alikes; the 5 human admin/account rows are gone.
    expect(m.pageViews).toEqual({ day: 4, prior: 1 });
    expect(m.botPageViews).toEqual({ day: 0, prior: 0 });
    expect(m.botActivity).toEqual([]);
    expect(m.topProducts).toEqual([{ name: 'P1', slug: 'p1', views: 1 }]);
    // Ranked, not tied — the 4 excluded `Direct` admin rows would have topped this.
    expect(m.referrers).toEqual([
      { source: 'Google', views: 2 },
      { source: 'Direct', views: 1 },
    ]);
  });

  it('returns zeroes and empty lists on an empty database', async () => {
    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.pageViews).toEqual({ day: 0, prior: 0 });
    expect(m.botPageViews).toEqual({ day: 0, prior: 0 });
    expect(m.newUsers).toEqual({ day: 0, prior: 0 });
    expect(m.totalUsers).toBe(0);
    expect(m.pendingModeration).toBe(0);
    expect(m.topProducts).toEqual([]);
    expect(m.referrers).toEqual([]);
    expect(m.botActivity).toEqual([]);
  });
});

describe('buildAnalyticsDigest', () => {
  const base: AnalyticsMetrics = {
    pageViews: { day: 512, prior: 400 },
    botPageViews: { day: 260, prior: 300 },
    newUsers: { day: 8, prior: 5 },
    totalUsers: 143,
    pendingModeration: 3,
    topProducts: [
      { name: 'Revit', slug: 'revit', views: 120 },
      { name: 'AutoCAD', slug: 'autocad', views: 90 },
    ],
    referrers: [
      { source: 'Direct', views: 300 },
      { source: 'Google', views: 120 },
      { source: 'LinkedIn', views: 60 },
      { source: 'Twitter/X', views: 32 },
    ],
    botActivity: [
      { name: 'Bingbot', crawls: 150 },
      { name: 'Googlebot', crawls: 80 },
      { name: 'Datacenter (AWS)', crawls: 30 },
    ],
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-07-23',
    generatedAt: new Date('2026-07-24T12:00:05.000Z'),
  };

  it('summarizes humans + top product + crawl count in the subject', () => {
    const d = buildAnalyticsDigest(base, opts);
    expect(d.subject).toBe(
      'AECi daily digest (production) — 2026-07-23: 512 human views, 8 new users · top: Revit · 260 crawls',
    );
  });

  it('renders human counts, deltas, and the human top-product list in the text body', () => {
    const { text } = buildAnalyticsDigest(base, opts);
    expect(text).toContain('== Traffic (humans) ==');
    expect(text).toContain('Page views: 512 (+112 (+28%) vs 400 prior day)');
    expect(text).toContain('(260 bot/crawler views excluded — see Crawler activity)');
    expect(text).toContain('New sign-ins (new accounts): 8 (+3 (+60%) vs 5 prior day)');
    expect(text).toContain('Total sign-ins (registered users): 143');
    expect(text).toContain('1. Revit — 120 views (/revit)');
    expect(text).toContain('2. AutoCAD — 90 views (/autocad)');
    expect(text).toContain('Reviews awaiting moderation: 3 — see /admin/reviews');
  });

  it('lists human traffic sources in the Traffic sources section', () => {
    const { text, html } = buildAnalyticsDigest(base, opts);
    expect(text).toContain('== Traffic sources (humans) ==');
    expect(text).toContain('1. Direct — 300 views');
    expect(text).toContain('2. Google — 120 views');
    expect(text).toContain('3. LinkedIn — 60 views');
    expect(text).toContain('4. Twitter/X — 32 views');
    expect(html).toContain('Traffic sources (humans)');
    expect(html).toContain('LinkedIn');
    expect(html).toContain('Twitter/X');
  });

  it('lists every crawler and its crawl count in the Crawler activity section', () => {
    const { text } = buildAnalyticsDigest(base, opts);
    expect(text).toContain('== Crawler activity ==');
    expect(text).toContain(
      'Bot/crawler page views: 260 (-40 (-13%) vs 300 prior day) from 3 sources',
    );
    expect(text).toContain('1. Bingbot — 150 crawls');
    expect(text).toContain('2. Googlebot — 80 crawls');
    expect(text).toContain('3. Datacenter (AWS) — 30 crawls');
  });

  it('renders a full HTML document with the crawler section and named bots', () => {
    const { html } = buildAnalyticsDigest(base, opts);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('AECi daily analytics digest');
    expect(html).toContain('Traffic (humans)');
    expect(html).toContain('Crawler activity');
    expect(html).toContain('Bingbot');
    expect(html).toContain('Datacenter (AWS)');
  });

  it('handles a zero-prior day (omits the percentage) and a downward delta', () => {
    const { text } = buildAnalyticsDigest(
      { ...base, pageViews: { day: 5, prior: 0 }, newUsers: { day: 3, prior: 10 } },
      opts,
    );
    expect(text).toContain('Page views: 5 (+5 vs 0 prior day)');
    expect(text).toContain('New sign-ins (new accounts): 3 (-7 (-70%) vs 10 prior day)');
  });

  it('reports "no change" and the empty / clean states (no humans, no bots)', () => {
    const { subject, text, html } = buildAnalyticsDigest(
      {
        pageViews: { day: 40, prior: 40 },
        botPageViews: { day: 0, prior: 0 },
        newUsers: { day: 0, prior: 0 },
        totalUsers: 0,
        pendingModeration: 0,
        topProducts: [],
        referrers: [],
        botActivity: [],
      },
      opts,
    );
    expect(subject).toBe(
      'AECi daily digest (production) — 2026-07-23: 40 human views, 0 new users',
    );
    expect(text).toContain('Page views: 40 (no change vs prior day)');
    expect(text).not.toContain('bot/crawler views excluded');
    expect(text).toContain('Most viewed product: (no human product page views)');
    expect(text).toContain('(no referrer data yet)');
    expect(text).toContain('Reviews awaiting moderation: 0');
    expect(text).toContain('No bot/crawler activity.');
    expect(html).toContain('No referrer data yet.');
    expect(html).toContain('No bot/crawler activity.');
  });
});
