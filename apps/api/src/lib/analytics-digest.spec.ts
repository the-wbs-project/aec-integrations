/**
 * Unit tests for the daily operator analytics digest (AECI-526):
 *   - `dailyWindows` — the prior-complete-UTC-day windowing (+ delta baseline).
 *   - `collectAnalyticsMetrics` — the D1 aggregation, exercised against the in-memory
 *     D1 harness so the real Drizzle SQL (window range, product join, top-N) runs.
 *   - `buildAnalyticsDigest` — the pure formatter (subject / deltas / top-product list).
 *
 * AECI-1460 removed the residual, the automation exclusion and the PostHog lines.
 * The tables now filter by the classification record, which the D1 block below
 * exercises against real `page_view_classifications` rows.
 */

import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews, products, profiles, reviews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { automationClassFilterForDay } from './admin-classification';
import {
  arrivalTelemetryDegraded,
  buildAnalyticsDigest,
  collectAnalyticsMetrics,
  computeDelta,
  dailyWindows,
  PAIR_ATTRIBUTION_NOTE,
  PAIR_ATTRIBUTION_STARTS_ON,
  TABLES_UNCLASSIFIED_NOTE,
  trafficDaysNotComparable,
  windowsForDay,
  type AnalyticsMetrics,
} from './analytics-digest';
import type { ArrivalCfCoverage } from './arrival-coverage';

/** A day whose arrival network telemetry arrived intact — the state every
 *  formatter fixture below assumes unless it is testing the other one. */
const HEALTHY_COVERAGE: ArrivalCfCoverage = { arrivals: 900, arrivalsWithAsn: 900, coverage: 1 };

/** The AECI-868 shape: arrivals landed, none of them carried a network. */
const BLIND_COVERAGE: ArrivalCfCoverage = { arrivals: 2736, arrivalsWithAsn: 0, coverage: 0 };

describe('windowsForDay (AECI-574 — the arbitrary-day window the panel shares)', () => {
  it('produces the same window `dailyWindows` does for the day it reports', () => {
    const now = new Date('2026-07-24T12:00:00.000Z');
    // The panel reports any UTC day through this function; if it ever diverged
    // from the cron's own arithmetic, the digest-parity criterion would silently
    // hold for yesterday and fail for every other day.
    expect(windowsForDay(dailyWindows(now).dayLabel)).toEqual(dailyWindows(now));
  });

  it('crosses a month boundary correctly', () => {
    expect(windowsForDay('2026-07-01')).toEqual({
      startIso: '2026-07-01T00:00:00.000Z',
      endIso: '2026-07-02T00:00:00.000Z',
      priorStartIso: '2026-06-30T00:00:00.000Z',
      dayLabel: '2026-07-01',
    });
  });
});

describe('computeDelta (AECI-574 — the structured form of deltaText)', () => {
  it('reports the diff and a signed percentage', () => {
    expect(computeDelta({ day: 512, prior: 400 })).toEqual({
      current: 512,
      prior: 400,
      diff: 112,
      pct: 28,
    });
    expect(computeDelta({ day: 42, prior: 45 })).toEqual({
      current: 42,
      prior: 45,
      diff: -3,
      pct: -7,
    });
  });

  it('omits the percentage when the prior period was 0 — division would be meaningless', () => {
    expect(computeDelta({ day: 5, prior: 0 })).toEqual({
      current: 5,
      prior: 0,
      diff: 5,
      pct: null,
    });
  });

  it('reports no change as a real zero, never -0', () => {
    expect(computeDelta({ day: 7, prior: 7 })).toEqual({
      current: 7,
      prior: 7,
      diff: 0,
      pct: 0,
    });
    // A drop too small to round to a whole percent would otherwise produce `-0`,
    // which serializes as 0 but fails a strict equality assertion.
    expect(Object.is(computeDelta({ day: 999, prior: 1000 }).pct, 0)).toBe(true);
  });
});

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
      // A count tie reads A to Z (AECI-1243).
      { source: 'Direct', views: 1 },
      { source: 'Google', views: 1 },
    ]);
  });

  it('breaks a count tie A to Z on top products and bot activity (AECI-1243)', async () => {
    // Ids sort opposite to names, so a tie left to the group order fails this.
    await t.db.insert(products).values([
      { id: 'p1', slug: 'zoho', name: 'Zoho' },
      { id: 'p2', slug: 'acumatica', name: 'acumatica' },
      { id: 'p3', slug: 'buildertrend', name: 'Buildertrend' },
    ]);
    const human = (productId: string, minute: number) => ({
      path: `/products/${productId}`,
      productId,
      createdAt: `2026-07-23T10:${String(minute).padStart(2, '0')}:00.000Z`,
    });
    const bot = (botName: string, minute: number) => ({
      path: '/',
      isBot: true,
      botName,
      createdAt: `2026-07-23T11:${String(minute).padStart(2, '0')}:00.000Z`,
    });
    await t.db
      .insert(pageViews)
      .values([
        human('p1', 1),
        human('p2', 2),
        human('p3', 3),
        human('p3', 4),
        bot('bingbot', 1),
        bot('Applebot', 2),
        bot('Zbot', 3),
      ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    expect(m.topProducts.map((p) => p.slug)).toEqual(['buildertrend', 'acumatica', 'zoho']);
    expect(m.botActivity.map((b) => b.name)).toEqual(['Applebot', 'bingbot', 'Zbot']);
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

  it('excludes operator SESSIONS on public paths (§13 D13), keeping NULL as a visitor', async () => {
    // The half `/admin/*` cannot see: the operator checking their own work on the
    // public site. Nothing about the path, referrer, or network distinguishes
    // these rows — only `is_operator`.
    await t.db.insert(products).values([{ id: 'p1', slug: 'p1', name: 'P1' }]);
    await t.db.insert(pageViews).values([
      // Real visitor traffic on the reported day.
      {
        path: '/products/p1',
        productId: 'p1',
        isBot: false,
        referrerSource: 'Google',
        isOperator: false,
        createdAt: '2026-07-23T10:00:00.000Z',
      },
      // Pre-D13 rows: `is_operator` is NULL and must keep reading as a visitor, so
      // history does not shift under a column it never had.
      { path: '/', isBot: false, referrerSource: 'Direct', createdAt: '2026-07-23T10:30:00.000Z' },
      // The operator, on ordinary public pages, indistinguishable but for the flag.
      {
        path: '/products/p1',
        productId: 'p1',
        isBot: false,
        referrerSource: 'Direct',
        isOperator: true,
        createdAt: '2026-07-23T11:00:00.000Z',
      },
      {
        path: '/',
        isBot: false,
        referrerSource: 'Direct',
        isOperator: true,
        createdAt: '2026-07-23T11:05:00.000Z',
      },
      // Prior day: 1 visitor, 1 operator.
      { path: '/', isBot: false, isOperator: false, createdAt: '2026-07-22T10:00:00.000Z' },
      { path: '/', isBot: false, isOperator: true, createdAt: '2026-07-22T11:00:00.000Z' },
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    expect(m.pageViews).toEqual({ day: 2, prior: 1 });
    // The operator's product view would otherwise double P1's count.
    expect(m.topProducts).toEqual([{ name: 'P1', slug: 'p1', views: 1 }]);
    // `Direct` is the bucket operator traffic inflates hardest — both of the
    // operator's rows classified Direct, only the NULL-flagged visitor survives.
    expect(m.referrers).toEqual([
      { source: 'Direct', views: 1 },
      { source: 'Google', views: 1 },
    ]);
  });

  it('recovers the rows a LAPSED operator session left unflagged (AECI-683)', async () => {
    // A replay of production 2026-08-26. The operator's second browser hash on
    // AS23700 was `is_operator = 1` early, went dark for 105 minutes while the
    // access token sat expired, then came back flagged. `resolveVisitorSession`
    // treats a token expired past its grace window as not the operator, so the middle burst is
    // indistinguishable from a visitor on the row itself — only the pair
    // identifies it.
    await t.db.insert(products).values([{ id: 'p1', slug: 'p1', name: 'P1' }]);
    const operatorRow = (createdAt: string, isOperator: boolean | null) => ({
      path: '/products/p1',
      productId: 'p1',
      isBot: false,
      referrerSource: 'Direct',
      userAgentHash: 'd37ac4d2',
      cfAsn: 23700,
      isOperator,
      createdAt,
    });
    await t.db.insert(pageViews).values([
      operatorRow('2026-07-23T02:48:00.000Z', true), // anchor, before the lapse
      operatorRow('2026-07-23T05:46:00.000Z', false), // the leak
      operatorRow('2026-07-23T06:30:00.000Z', false), // the leak
      operatorRow('2026-07-23T07:28:00.000Z', false), // the leak (ended on /auth/login)
      operatorRow('2026-07-23T07:33:00.000Z', true), // anchor, after the lapse
      // A real visitor, same day, different browser and network.
      {
        path: '/products/p1',
        productId: 'p1',
        isBot: false,
        referrerSource: 'Google',
        userAgentHash: 'visitor-ua',
        cfAsn: 7922,
        isOperator: false,
        createdAt: '2026-07-23T09:00:00.000Z',
      },
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    // Before AECI-683 this read 4: the visitor plus three leaked operator views.
    expect(m.pageViews.day).toBe(1);
    expect(m.operatorLeakViews).toBe(3);
    // And the leak is what put the operator's own product at the top of the table.
    expect(m.topProducts).toEqual([{ name: 'P1', slug: 'p1', views: 1 }]);
  });

  it('narrows the pair by ASN: the same browser hash elsewhere is a real visitor', async () => {
    // The measured reason this is a PAIR and not a UA hash. Hash `d37ac4d2` spans
    // six ASNs across five countries in production — it is a browser BUILD, shared
    // with strangers. Flagging the hash outright deletes real people in four
    // countries (`operator-pairs.sql`).
    const row = (cfAsn: number, isOperator: boolean, createdAt: string) => ({
      path: '/',
      isBot: false,
      userAgentHash: 'd37ac4d2',
      cfAsn,
      isOperator,
      createdAt,
    });
    await t.db.insert(pageViews).values([
      row(23700, true, '2026-07-23T02:00:00.000Z'), // the operator's own network
      row(23700, false, '2026-07-23T03:00:00.000Z'), // their lapsed row → excluded
      row(3320, false, '2026-07-23T04:00:00.000Z'), // a stranger on the same build
      row(701, false, '2026-07-23T05:00:00.000Z'), // and another
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.pageViews.day).toBe(2);
    expect(m.operatorLeakViews).toBe(1);
  });

  it('keeps rows with a NULL hash or ASN, which a naive NOT(a=? AND b=?) would drop', async () => {
    // Three-valued logic is the trap here. `NOT (hash = 'x' AND asn = 23700)`
    // evaluates to NULL when `hash` is NULL and the ASN matches, and a WHERE
    // clause drops a NULL row. `NOT EXISTS` keeps it, which is the correct
    // reading: an unidentifiable row is not evidence of anything.
    await t.db.insert(pageViews).values([
      {
        path: '/',
        isBot: false,
        userAgentHash: 'd37ac4d2',
        cfAsn: 23700,
        isOperator: true,
        createdAt: '2026-07-23T02:00:00.000Z',
      },
      // No hash, matching ASN.
      { path: '/', isBot: false, cfAsn: 23700, createdAt: '2026-07-23T03:00:00.000Z' },
      // Matching hash, no ASN.
      { path: '/', isBot: false, userAgentHash: 'd37ac4d2', createdAt: '2026-07-23T04:00:00.000Z' },
      // Neither.
      { path: '/', isBot: false, createdAt: '2026-07-23T05:00:00.000Z' },
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.pageViews.day).toBe(3);
    expect(m.operatorLeakViews).toBe(0);
  });

  it('stops reaching at OPERATOR_PAIR_LOOKBACK_DAYS', async () => {
    // The bound exists because a pair is only the operator for as long as they
    // hold that browser build on that network. An anchor 31 days out is stale.
    const row = (isOperator: boolean, createdAt: string) => ({
      path: '/',
      isBot: false,
      userAgentHash: 'ua-1',
      cfAsn: 23700,
      isOperator,
      createdAt,
    });
    await t.db.insert(pageViews).values([
      // 2026-07-23T10:00Z minus 30 days is 2026-06-23T10:00Z — this clears it.
      row(true, '2026-06-23T11:00:00.000Z'),
      row(false, '2026-07-23T10:00:00.000Z'),
    ]);
    expect((await collectAnalyticsMetrics(t.db, window)).pageViews.day).toBe(0);

    await t.db.delete(pageViews);
    await t.db.insert(pageViews).values([
      row(true, '2026-06-22T10:00:00.000Z'), // one day too far back
      row(false, '2026-07-23T10:00:00.000Z'),
    ]);
    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.pageViews.day).toBe(1);
    expect(m.operatorLeakViews).toBe(0);
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
    // No classes at all, so the tables are unfiltered and say so.
    expect(m.tablesUnclassified).toBe(true);
  });
});

describe('collectAnalyticsMetrics — the tables filter by class (AECI-1460)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
    await t.db.insert(products).values([
      { id: 'p1', slug: 'p1', name: 'P1' },
      { id: 'p2', slug: 'p2', name: 'P2' },
      { id: 'p3', slug: 'p3', name: 'P3' },
    ]);
  });
  afterEach(() => t.dispose());

  const DAY = '2026-07-23';
  const window = windowsForDay(DAY);
  const AT = `${DAY}T10:00:00.000Z`;

  async function view(extra: Partial<typeof pageViews.$inferInsert> = {}): Promise<number> {
    const [row] = await t.db
      .insert(pageViews)
      .values({ path: '/products/x', createdAt: AT, ...extra })
      .returning({ id: pageViews.id });
    return row!.id;
  }

  /** One stored classification. `evaluatedAt` decides which version is the
   *  day's latest, exactly as `latestVersionPerDay` reads it. */
  function classify(
    id: number,
    cls: string,
    version = 'v1',
    day = DAY,
    evaluatedAt = `${day}T23:59:00.000Z`,
  ) {
    t.raw
      .prepare(
        `INSERT INTO page_view_classifications
           (page_view_id, class, reason_codes, classifier_version, evaluated_at,
            evidence_from, evidence_to, view_day, created_at)
         VALUES (?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        cls,
        version,
        evaluatedAt,
        `${day}T00:00:00.000Z`,
        `${day}T00:00:00.000Z`,
        day,
        evaluatedAt,
      );
  }

  const onProduct = (productId: string, referrerSource: string) => ({
    path: `/products/${productId}`,
    productId,
    referrerSource,
  });

  it('drops classed automation, keeps unresolved and not-yet-classified views', async () => {
    // p1 is all automation and would lead the table on raw counts.
    classify(await view(onProduct('p1', 'Direct')), 'identified_automation');
    classify(await view(onProduct('p1', 'Direct')), 'identified_automation');
    classify(await view(onProduct('p1', 'Direct')), 'suspected_automation');
    classify(await view(onProduct('p2', 'Google')), 'unresolved');
    classify(await view(onProduct('p3', 'Bing')), 'browser_with_human_evidence');
    // No classification row on a classified day, and NULL hash/ASN: kept. A join
    // or a NOT IN would be NULL for this row and drop it.
    await view({ ...onProduct('p3', 'Bing'), userAgentHash: null, cfAsn: null });

    const m = await collectAnalyticsMetrics(t.db, window);

    expect(m.tablesUnclassified).toBe(false);
    expect(m.topProducts).toEqual([
      { name: 'P3', slug: 'p3', views: 2 },
      { name: 'P2', slug: 'p2', views: 1 },
    ]);
    expect(m.referrers).toEqual([
      { source: 'Bing', views: 2 },
      { source: 'Google', views: 1 },
    ]);
    // The raw human count is untouched: the filter is the tables' only.
    expect(m.pageViews.day).toBe(6);
  });

  it("reads the day's latest version only", async () => {
    // Automation on v1, unresolved on v2 (evaluated later): kept.
    const a = await view(onProduct('p1', 'Direct'));
    classify(a, 'identified_automation', 'v1', DAY, `${DAY}T12:00:00.000Z`);
    classify(a, 'unresolved', 'v2', DAY, `${DAY}T23:00:00.000Z`);
    // Unresolved on v1, automation on v2: dropped.
    const b = await view(onProduct('p2', 'Direct'));
    classify(b, 'unresolved', 'v1', DAY, `${DAY}T12:00:00.000Z`);
    classify(b, 'suspected_automation', 'v2', DAY, `${DAY}T23:00:00.000Z`);

    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.topProducts).toEqual([{ name: 'P1', slug: 'p1', views: 1 }]);
  });

  it('drops a classed-automation pair-page view for BOTH endpoints (AECI-929)', async () => {
    const pair = {
      path: '/products/:contextSlug/integrations/:otherSlug',
      pairProductAId: 'p1',
      pairProductBId: 'p2',
    };
    classify(await view(pair), 'identified_automation');
    classify(await view(pair), 'identified_automation');
    classify(await view(pair), 'unresolved');
    classify(await view({ path: '/products/p2', productId: 'p2' }), 'unresolved');

    const m = await collectAnalyticsMetrics(t.db, window);
    // p2: its own view plus the kept pair view. p1: the kept pair view only.
    expect(m.topProducts).toEqual([
      { name: 'P2', slug: 'p2', views: 2 },
      { name: 'P1', slug: 'p1', views: 1 },
    ]);
  });

  it('leaves the tables unfiltered, and says so, on a day with no classes', async () => {
    // Classes exist for the PRIOR day only. They must not filter the reported day.
    const prior = '2026-07-22';
    classify(
      await view({ ...onProduct('p1', 'Direct'), createdAt: `${prior}T10:00:00.000Z` }),
      'identified_automation',
      'v1',
      prior,
    );
    await view(onProduct('p1', 'Direct'));
    await view(onProduct('p1', 'Direct'));

    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.tablesUnclassified).toBe(true);
    expect(m.topProducts).toEqual([{ name: 'P1', slug: 'p1', views: 2 }]);
    expect(m.referrers).toEqual([{ source: 'Direct', views: 2 }]);
  });

  it('compiles to a NOT EXISTS with three bound parameters and no compound SELECT', async () => {
    classify(await view(), 'unresolved', 'tc-2026.10.2');
    const f = await automationClassFilterForDay(t.db, DAY);
    expect(f).toMatchObject({ version: 'tc-2026.10.2', unclassified: false });
    const q = new SQLiteSyncDialect().sqlToQuery(f.predicate!);
    expect(q.sql).toMatch(/^not exists \(/);
    expect(q.sql).not.toMatch(/union/i);
    expect(q.params).toEqual(['tc-2026.10.2', 'identified_automation', 'suspected_automation']);
    // It correlates on the unaliased outer table.
    expect(q.sql).toContain('"page_views"."id"');
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
    tablesUnclassified: false,
    operatorLeakViews: 0,
    arrivalCoverage: HEALTHY_COVERAGE,
    priorArrivalCoverage: HEALTHY_COVERAGE,
    classification: null,
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-07-23',
    generatedAt: new Date('2026-07-24T12:00:05.000Z'),
  };

  it('summarizes the class state + top product + crawl count in the subject', () => {
    const d = buildAnalyticsDigest(base, opts);
    // No residual fallback (AECI-1460): an unread day names the reason, no count.
    expect(d.subject).toBe(
      'AECi daily digest (production) — 2026-07-23: CLASSES UNAVAILABLE, 8 new users · top: Revit · 260 crawls',
    );
  });

  it('renders deltas and the top-product list in the text body', () => {
    const { text } = buildAnalyticsDigest(base, opts);
    expect(text).not.toContain('unresolved origin');
    expect(text).toContain('== Most viewed products (excluding classed automation) ==');
    expect(text).toContain('New sign-ins (new accounts): 8 (+3 (+60%) vs 5 prior day)');
    expect(text).toContain('Total sign-ins (registered users): 143');
    expect(text).toContain('1. Revit — 120 views (/revit)');
    expect(text).toContain('2. AutoCAD — 90 views (/autocad)');
    expect(text).toContain('Reviews awaiting moderation: 3 — see /admin/reviews');
  });

  it('lists human traffic sources in the Traffic sources section', () => {
    const { text, html } = buildAnalyticsDigest(base, opts);
    expect(text).toContain('== Traffic sources (excluding classed automation) ==');
    expect(text).toContain('1. Direct — 300 views');
    expect(text).toContain('2. Google — 120 views');
    expect(text).toContain('3. LinkedIn — 60 views');
    expect(text).toContain('4. Twitter/X — 32 views');
    expect(html).toContain('Traffic sources (excluding classed automation)');
    expect(html).toContain('Most viewed products (excluding classed automation)');
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
    expect(html).not.toContain('unresolved origin');
    expect(html).toContain('Crawler activity');
    expect(html).toContain('Bingbot');
    expect(html).toContain('Datacenter (AWS)');
  });

  it('handles a zero-prior day (omits the percentage) and a downward delta', () => {
    const { text } = buildAnalyticsDigest(
      { ...base, botPageViews: { day: 5, prior: 0 }, newUsers: { day: 3, prior: 10 } },
      opts,
    );
    expect(text).toContain('Bot/crawler page views: 5 (+5 vs 0 prior day)');
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
        tablesUnclassified: false,
        botActivity: [],
        operatorLeakViews: 0,
        arrivalCoverage: HEALTHY_COVERAGE,
        priorArrivalCoverage: HEALTHY_COVERAGE,
        classification: null,
      },
      opts,
    );
    expect(subject).toBe(
      'AECi daily digest (production) — 2026-07-23: CLASSES UNAVAILABLE, 0 new users',
    );
    expect(text).toContain('New sign-ins (new accounts): 0 (no change vs prior day)');
    expect(text).toContain('(no product page views)');
    expect(html).toContain('No product page views.');
    expect(text).toContain('(no referrer data yet)');
    expect(text).toContain('Reviews awaiting moderation: 0');
    expect(text).toContain('No bot/crawler activity.');
    expect(html).toContain('No referrer data yet.');
    expect(html).toContain('No bot/crawler activity.');
  });
});

describe('buildAnalyticsDigest — the tables (AECI-929, AECI-1460)', () => {
  const metrics: AnalyticsMetrics = {
    pageViews: { day: 48, prior: 40 },
    botPageViews: { day: 734, prior: 700 },
    newUsers: { day: 0, prior: 0 },
    totalUsers: 3,
    pendingModeration: 0,
    topProducts: [{ name: 'Corpay', slug: 'corpay', views: 2 }],
    referrers: [{ source: 'Direct', views: 48 }],
    tablesUnclassified: false,
    botActivity: [{ name: 'Bingbot', crawls: 173 }],
    operatorLeakViews: 0,
    arrivalCoverage: HEALTHY_COVERAGE,
    priorArrivalCoverage: HEALTHY_COVERAGE,
    classification: null,
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-08-23',
    generatedAt: new Date('2026-08-24T05:00:00.000Z'),
  };

  it('says under the top-products table that pair views are included (AECI-929)', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(PAIR_ATTRIBUTION_NOTE).toContain(PAIR_ATTRIBUTION_STARTS_ON);
    expect(text).toContain(`(${PAIR_ATTRIBUTION_NOTE})`);
    expect(text.indexOf(PAIR_ATTRIBUTION_NOTE)).toBeGreaterThan(text.indexOf('Corpay'));
    expect(html).toContain(PAIR_ATTRIBUTION_NOTE);
    expect(html.indexOf(PAIR_ATTRIBUTION_NOTE)).toBeGreaterThan(html.indexOf('Corpay'));
    // No table, no caption: there is nothing for it to qualify.
    const empty = buildAnalyticsDigest({ ...metrics, topProducts: [] }, opts);
    expect(empty.text).not.toContain(PAIR_ATTRIBUTION_NOTE);
    expect(empty.html).not.toContain(PAIR_ATTRIBUTION_NOTE);
  });

  it('titles the tables "excluding classed automation" and prints no note on a classified day', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('== Most viewed products (excluding classed automation) ==');
    expect(text).toContain('== Traffic sources (excluding classed automation) ==');
    expect(text).not.toContain(TABLES_UNCLASSIFIED_NOTE);
    expect(html).not.toContain(TABLES_UNCLASSIFIED_NOTE);
    expect(text).not.toContain('after automation');
  });

  it('retitles the tables and prints the note once when they are unfiltered', () => {
    const { text, html } = buildAnalyticsDigest({ ...metrics, tablesUnclassified: true }, opts);
    expect(TABLES_UNCLASSIFIED_NOTE).toBe(
      'This day has no traffic classes, so the product and source tables are not filtered for automation.',
    );
    expect(text).toContain('== Most viewed products (not filtered by class) ==');
    expect(text).toContain('== Traffic sources (not filtered by class) ==');
    expect(text).not.toContain('excluding classed automation');
    expect(text.split(TABLES_UNCLASSIFIED_NOTE)).toHaveLength(2);
    expect(html.split(TABLES_UNCLASSIFIED_NOTE)).toHaveLength(2);
    // The note sits above the products table.
    expect(text.indexOf(TABLES_UNCLASSIFIED_NOTE)).toBeLessThan(text.indexOf('Corpay'));
  });
});

describe('buildAnalyticsDigest — the telemetry-health line (AECI-869)', () => {
  /**
   * **2026-09-10 as it actually was**, which is the whole point of this block.
   *
   * That morning's email led with "680 human page views after automation" and
   * gave the operator no way to know that every one of the day's 2,736
   * full-document arrivals had stored a NULL `cf_asn` (AECI-868). With no ASN,
   * `countDistinct(cf_asn)` is zero, so both swarm ratios and the ASN-rotator
   * grouping structurally cannot fire, and the AECI-683 operator-pair retro-join
   * cannot match. 1,851 crawls were still caught by name, which is exactly why
   * four blind days read as a good week rather than as an outage.
   *
   * The rest of this file tests the pieces; this one asserts the whole email a
   * reader would have received, so the honest version is reproducible rather than
   * asserted piecemeal.
   */
  const SEP10: AnalyticsMetrics = {
    pageViews: { day: 878, prior: 900 },
    botPageViews: { day: 1851, prior: 1700 },
    newUsers: { day: 0, prior: 0 },
    totalUsers: 143,
    pendingModeration: 0,
    topProducts: [{ name: 'Procore', slug: 'procore', views: 40 }],
    referrers: [{ source: 'Direct', views: 640 }],
    tablesUnclassified: true,
    botActivity: [{ name: 'Googlebot', crawls: 1851 }],
    operatorLeakViews: 0,
    arrivalCoverage: BLIND_COVERAGE,
    priorArrivalCoverage: BLIND_COVERAGE,
    classification: null,
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-09-10',
    generatedAt: new Date('2026-09-11T05:00:00.000Z'),
  };

  it('reports 2026-09-10 honestly: telemetry missing, no residual, no arithmetic', () => {
    const { subject, text, html } = buildAnalyticsDigest(SEP10, opts);

    // 1. No residual figure anywhere (AECI-1460). The day was not classified, so
    //    the subject names the reason and the outage, and carries no count.
    expect(subject).toBe(
      'AECi daily digest (production) — 2026-09-10: CLASSES UNAVAILABLE, 0 new users · top: Procore · 1851 crawls · NO NETWORK TELEMETRY',
    );
    expect(text).not.toContain('680');
    expect(text).not.toContain('878');
    expect(html).not.toContain('878');

    // 2. The telemetry outage is unmissable: subject, body, and HTML, above the tables.
    expect(text).toContain(
      '  ** Arrival network telemetry unavailable for this day; network-based exclusions did not run.',
    );
    expect(text).toContain('Only 0 of 2736 full-document arrivals carried a network (ASN)');
    expect(text.indexOf('Arrival network telemetry unavailable')).toBeLessThan(
      text.indexOf('== Most viewed products'),
    );
    expect(html).toContain('Arrival network telemetry unavailable for this day');

    // 3. The crawler line still reports what WAS caught by name.
    expect(text).toContain('Bot/crawler page views: 1851');
  });

  it('suppresses the day-over-day arithmetic across a telemetry boundary', () => {
    // Both days blind here, but the rule is EITHER: a measured day beside a blind
    // one is the case that actually misleads, because the blind day over-reports.
    const { text } = buildAnalyticsDigest(SEP10, opts);
    expect(text).toContain(
      'not comparable with the prior day (arrival network telemetry was unavailable)',
    );
    // The number that would have been printed is absent, not merely hedged.
    expect(text).not.toContain('vs 1700 prior day');
  });

  it('suppresses it when only the PRIOR day was blind', () => {
    const { text } = buildAnalyticsDigest({ ...SEP10, arrivalCoverage: HEALTHY_COVERAGE }, opts);
    expect(text).toContain('not comparable with the prior day');
    // …and the health line is gone, because the reported day itself is fine.
    expect(text).not.toContain('Arrival network telemetry unavailable for this day');
  });

  it('leaves the sign-in delta alone: it reads no network column', () => {
    const { text } = buildAnalyticsDigest({ ...SEP10, newUsers: { day: 8, prior: 5 } }, opts);
    expect(text).toContain('New sign-ins (new accounts): 8 (+3 (+60%) vs 5 prior day)');
  });

  it('says nothing at all when telemetry is healthy', () => {
    const { subject, text, html } = buildAnalyticsDigest(
      { ...SEP10, arrivalCoverage: HEALTHY_COVERAGE, priorArrivalCoverage: HEALTHY_COVERAGE },
      opts,
    );
    expect(subject).not.toContain('NO NETWORK TELEMETRY');
    expect(text).not.toContain('Arrival network telemetry unavailable');
    expect(html).not.toContain('Arrival network telemetry unavailable');
    // And the delta is a real comparison again.
    expect(text).not.toContain('not comparable with the prior day');
  });

  it('stays silent on a quiet day, where coverage is 1 over zero arrivals', () => {
    // `readArrivalCfCoverage` returns 1 for an empty window on purpose. Reporting
    // an outage every quiet night is how a warning stops being read.
    const { text } = buildAnalyticsDigest(
      {
        ...SEP10,
        arrivalCoverage: { arrivals: 0, arrivalsWithAsn: 0, coverage: 1 },
        priorArrivalCoverage: { arrivals: 0, arrivalsWithAsn: 0, coverage: 1 },
      },
      opts,
    );
    expect(text).not.toContain('Arrival network telemetry unavailable');
  });
});

describe('collectAnalyticsMetrics — arrival telemetry coverage (AECI-869)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  const window = dailyWindows(new Date('2026-09-11T05:00:00.000Z')); // reports 2026-09-10

  it('measures BOTH days, so the delta rule has a baseline to check', async () => {
    await t.db.insert(pageViews).values([
      // The reported day, blind: four arrivals, one kept its ASN → 0.25.
      ...[1, 2, 3].map((n) => ({
        path: '/',
        navigation: 'arrival',
        createdAt: `2026-09-10T0${n}:00:00.000Z`,
      })),
      { path: '/', navigation: 'arrival', cfAsn: 13335, createdAt: '2026-09-10T04:00:00.000Z' },
      // An `spa` row on the same day: never in scope, because the browser tracker
      // POSTs its own request and was unaffected by AECI-868.
      { path: '/', navigation: 'spa', createdAt: '2026-09-10T05:00:00.000Z' },
      // The prior day, healthy.
      { path: '/', navigation: 'arrival', cfAsn: 13335, createdAt: '2026-09-09T01:00:00.000Z' },
      { path: '/', navigation: 'arrival', cfAsn: 7922, createdAt: '2026-09-09T02:00:00.000Z' },
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.arrivalCoverage).toEqual({ arrivals: 4, arrivalsWithAsn: 1, coverage: 0.25 });
    expect(m.priorArrivalCoverage).toEqual({ arrivals: 2, arrivalsWithAsn: 2, coverage: 1 });
    expect(arrivalTelemetryDegraded(m.arrivalCoverage)).toBe(true);
    expect(arrivalTelemetryDegraded(m.priorArrivalCoverage)).toBe(false);
    // Either day degraded is enough — the mixed case is the one that misleads.
    expect(trafficDaysNotComparable(m)).toBe(true);
  });

  it('treats a day with no arrivals as healthy, not as blind', async () => {
    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.arrivalCoverage).toEqual({ arrivals: 0, arrivalsWithAsn: 0, coverage: 1 });
    expect(arrivalTelemetryDegraded(m.arrivalCoverage)).toBe(false);
    expect(trafficDaysNotComparable(m)).toBe(false);
  });
});
