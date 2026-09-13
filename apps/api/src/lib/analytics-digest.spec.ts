/**
 * Unit tests for the daily operator analytics digest (AECI-526):
 *   - `dailyWindows` — the prior-complete-UTC-day windowing (+ delta baseline).
 *   - `collectAnalyticsMetrics` — the D1 aggregation, exercised against the in-memory
 *     D1 harness so the real Drizzle SQL (window range, product join, top-N) runs.
 *   - `buildAnalyticsDigest` — the pure formatter (subject / deltas / top-product list).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pageViews, products, profiles, reviews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  arrivalTelemetryDegraded,
  buildAnalyticsDigest,
  collectAnalyticsMetrics,
  computeDelta,
  dailyWindows,
  trafficDaysNotComparable,
  unresolvedRequests,
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
      { source: 'Google', views: 1 },
      { source: 'Direct', views: 1 },
    ]);
  });

  it('recovers the rows a LAPSED operator session left unflagged (AECI-683)', async () => {
    // A replay of production 2026-08-26. The operator's second browser hash on
    // AS23700 was `is_operator = 1` early, went dark for 105 minutes while the
    // access token sat expired, then came back flagged. `isOperatorRequest`
    // resolves an expired token to `false` by design, so the middle burst is
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

  it('counts corroborated views and the visitors behind them (AECI-683)', async () => {
    // `Direct` and `Other` are both excluded, and for different reasons: Direct is
    // where every stripped referral lands, and Other is an open bucket a forger
    // controls. Only a NAMED external source corroborates.
    const row = (
      referrerSource: string | null,
      userAgentHash: string,
      cfAsn: number,
      createdAt: string,
    ) => ({ path: '/', isBot: false, referrerSource, userAgentHash, cfAsn, createdAt });
    await t.db.insert(pageViews).values([
      row('Google', 'ua-a', 7922, '2026-07-23T01:00:00.000Z'),
      row('Google', 'ua-a', 7922, '2026-07-23T02:00:00.000Z'), // same visitor, 2nd view
      row('Bing', 'ua-b', 701, '2026-07-23T03:00:00.000Z'),
      row('LinkedIn', 'ua-a', 701, '2026-07-23T04:00:00.000Z'), // same UA, new network
      row('Direct', 'ua-c', 1234, '2026-07-23T05:00:00.000Z'), // not corroborated
      row('Other', 'ua-d', 1234, '2026-07-23T06:00:00.000Z'), // not corroborated
      row(null, 'ua-e', 1234, '2026-07-23T07:00:00.000Z'), // pre-classifier row
      row('Google', 'ua-f', 4321, '2026-07-22T01:00:00.000Z'), // prior day
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.pageViews.day).toBe(7);
    expect(m.corroboratedViews).toEqual({ day: 4, prior: 1 });
    // Three visitors: (ua-a,7922), (ua-b,701), (ua-a,701) — the pair, not the hash.
    expect(m.corroboratedVisitors).toBe(3);
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

/**
 * Regression guard for a limit this harness CANNOT reproduce.
 *
 * D1 caps bound parameters per statement far below stock SQLite, and
 * better-sqlite3 ships the stock value — so a predicate whose parameter count
 * grows with the DATA passes every assertion in this file and then fails on the
 * first busy day in production (`TESTING_STRATEGY.md` §6.3).
 *
 * The obvious implementation of the operator retro-join is exactly that shape:
 * resolve the operator's `(user_agent_hash, cf_asn)` pairs in JavaScript, then
 * emit `NOT (hash = ? AND asn = ?)` per pair. It binds two parameters per pair,
 * and the operator acquires pairs over time as their browser and network change
 * — six of them already, in production, by 2026-08-19.
 *
 * The correlated `NOT EXISTS` binds two parameters TOTAL (the two `strftime`
 * modifiers) no matter how many pairs exist. Assert the shape, because the
 * result is exactly what this engine cannot get wrong.
 */
describe('collectAnalyticsMetrics — automation exclusion on the tables (AECI-747)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  const window = dailyWindows(new Date('2026-07-24T12:00:00.000Z'));
  const AT = '2026-07-23T10:00:00.000Z';

  beforeEach(async () => {
    await t.db.insert(products).values([
      { id: 'p1', slug: 'p1', name: 'P1' },
      { id: 'p2', slug: 'p2', name: 'P2' },
    ]);
  });

  /**
   * Since AECI-745 the exclusion is no longer injected — `collectAnalyticsMetrics`
   * runs `detectSwarms` itself, so these seeds have to be shapes the REAL detector
   * flags rather than hashes an argument declared flagged.
   *
   * That is a strictly better test and it is also the only honest one now: an
   * injected list could assert the complement while the detector's own idea of
   * "flagged" drifted away underneath it, which is the two-definitions problem
   * this issue existed to remove. Here the headline and the tables are filtered by
   * one run of one detector, so a drift between them cannot hide.
   *
   * Four views under one hash across four networks clears `SWARM_MIN_VIEWS` (4) at
   * an ASN ratio of 1.0, well over `SWARM_MIN_ASN_RATIO` (0.8).
   */
  const swarmRow = (i: number, extra: Record<string, unknown> = {}) => ({
    path: '/products/p1',
    productId: 'p1',
    createdAt: AT,
    userAgentHash: 'swarm',
    cfAsn: 1000 + i,
    cfCountry: ['PL', 'BR', 'ID', 'VN'][i] ?? 'PL',
    referrerSource: 'Direct',
    ...extra,
  });

  it('drops flagged UA hashes from top products and traffic sources', async () => {
    await t.db.insert(pageViews).values([
      // The exact shape that put a bot-driven page at the top of the 2026-08-30
      // email: one fingerprint reading one page from four different networks.
      ...Array.from({ length: 4 }, (_, i) => swarmRow(i)),
      // One genuine reader of p2.
      {
        path: '/products/p2',
        productId: 'p2',
        createdAt: AT,
        userAgentHash: 'person',
        cfAsn: 7922,
        referrerSource: 'Google',
      },
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    expect(m.automation?.flagged.day).toBe(4);
    // p1 had 4 of the 5 views and would otherwise lead the table.
    expect(m.topProducts).toEqual([{ name: 'P2', slug: 'p2', views: 1 }]);
    expect(m.referrers).toEqual([{ source: 'Google', views: 1 }]);
  });

  it('KEEPS rows with a null hash, a null ASN AND a null verdict — the 3VL trap', async () => {
    // `NOT (ua IN (…) OR asn IN (…) OR verdict IN (…))` is NULL for this row, and
    // a NULL WHERE drops it — so the row would vanish from the tables while still
    // counting in the headline. It must survive. The verdict axis (AECI-744) has
    // the same trap: every row written before that column existed has a NULL.
    //
    // The four flagged rows are here so there IS an exclusion to be null-unsafe
    // about: with an empty candidate list `notFlagged` returns undefined and the
    // trap cannot fire, which would make this test pass for the wrong reason.
    await t.db
      .insert(pageViews)
      .values([
        ...Array.from({ length: 4 }, (_, i) => swarmRow(i)),
        { path: '/products/p2', productId: 'p2', createdAt: AT, referrerSource: 'Direct' },
      ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    expect(m.automation?.flagged.day).toBe(4);
    expect(m.topProducts).toEqual([{ name: 'P2', slug: 'p2', views: 1 }]);
    expect(m.referrers).toEqual([{ source: 'Direct', views: 1 }]);
  });

  it('excludes rows flagged by their own client_verdict, with no view floor', async () => {
    // AECI-744's half of the complement. A single `non-browser` view is subtracted
    // from the headline, so it must leave the tables too — otherwise the email
    // leads with a filtered number over unfiltered rows, which is the AECI-747
    // defect wearing a new cause.
    await t.db.insert(pageViews).values([
      {
        path: '/products/p1',
        productId: 'p1',
        createdAt: AT,
        userAgentHash: 'lone',
        cfAsn: 23724,
        clientVerdict: 'non-browser',
        referrerSource: 'Direct',
      },
      {
        path: '/products/p2',
        productId: 'p2',
        createdAt: AT,
        userAgentHash: 'person',
        cfAsn: 7922,
        clientVerdict: 'browser',
        referrerSource: 'Google',
      },
    ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    expect(m.automation?.flagged.day).toBe(1);
    expect(m.topProducts).toEqual([{ name: 'P2', slug: 'p2', views: 1 }]);
    expect(m.referrers).toEqual([{ source: 'Google', views: 1 }]);
  });

  it('the tables and the headline describe ONE population', async () => {
    await t.db
      .insert(pageViews)
      .values([
        ...Array.from({ length: 4 }, (_, i) => swarmRow(i)),
        { path: '/products/p2', productId: 'p2', createdAt: AT, userAgentHash: 'person' },
        { path: '/', createdAt: AT, userAgentHash: 'person' },
      ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    // Headline is `raw - flagged` (6 - 4 = 2); the table rows must sum to no more
    // than that. If the negation ever stops matching `countFlaggedViews`, this is
    // where it shows up.
    const net = unresolvedRequests(m);
    const tableViews = m.topProducts.reduce((n, p) => n + p.views, 0);
    expect(m.pageViews.day).toBe(6);
    expect(net.day).toBe(2);
    expect(tableViews).toBeLessThanOrEqual(net.day);
    expect(m.topProducts).toEqual([{ name: 'P2', slug: 'p2', views: 1 }]);
  });

  it("reports the prior day's flagged count too, so the delta is filtered on both sides", async () => {
    // AECI-741: a filtered day against an unfiltered prior day manufactures a
    // large fake drop. The detector therefore runs over both windows, and this is
    // the assertion that keeps the second run from being quietly dropped as an
    // optimization.
    const PRIOR = '2026-07-22T10:00:00.000Z';
    await t.db
      .insert(pageViews)
      .values([
        ...Array.from({ length: 4 }, (_, i) => swarmRow(i)),
        ...Array.from({ length: 4 }, (_, i) => swarmRow(i, { createdAt: PRIOR })),
      ]);

    const m = await collectAnalyticsMetrics(t.db, window);

    expect(m.automation).toEqual({ flagged: { day: 4, prior: 4 }, note: expect.any(String) });
    expect(unresolvedRequests(m)).toEqual({ day: 0, prior: 0 });
  });

  it('degrades to an UNFILTERED report when the detector throws, rather than failing', async () => {
    // A detector bug must not take down the 05:00 digest AND /admin/overview, both
    // of whose entire job is to keep reporting. `automation: null` is the state the
    // formatter and the panel already render as "this is the raw count, and we are
    // telling you it is raw" — so the degradation is visible rather than silent,
    // which is the only version of it worth having.
    await t.db
      .insert(pageViews)
      .values([
        ...Array.from({ length: 4 }, (_, i) => swarmRow(i)),
        { path: '/products/p2', productId: 'p2', createdAt: AT, userAgentHash: 'person' },
      ]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('./swarm-detection', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./swarm-detection')>()),
      detectSwarms: () => {
        throw new Error('detector exploded');
      },
    }));
    try {
      const digest = await import('./analytics-digest');
      const m = await digest.collectAnalyticsMetrics(t.db, window);

      expect(m.automation).toBeNull();
      expect(m.swarm).toBeNull();
      // The headline falls back to the raw count — NOT to zero, and not to a
      // partially-filtered figure.
      expect(m.pageViews.day).toBe(5);
      expect(digest.unresolvedRequests(m).day).toBe(5);
      // And the tables are unfiltered to match it: a filtered table under an
      // unfiltered headline is the AECI-747 defect, and it is just as wrong when
      // the cause is a failure as when the cause is a forgotten argument.
      expect(m.topProducts).toEqual([
        { name: 'P1', slug: 'p1', views: 4 },
        { name: 'P2', slug: 'p2', views: 1 },
      ]);
      expect(warn).toHaveBeenCalled();
    } finally {
      vi.doUnmock('./swarm-detection');
      vi.resetModules();
      warn.mockRestore();
    }
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
    corroboratedViews: { day: 12, prior: 9 },
    corroboratedVisitors: 7,
    operatorLeakViews: 0,
    // No detector result: the "did not run" rendering, which is what these
    // baseline cases have always exercised.
    automation: null,
    swarm: null,
    arrivalCoverage: HEALTHY_COVERAGE,
    priorArrivalCoverage: HEALTHY_COVERAGE,
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-07-23',
    generatedAt: new Date('2026-07-24T12:00:05.000Z'),
  };

  it('summarizes humans + top product + crawl count in the subject', () => {
    const d = buildAnalyticsDigest(base, opts);
    expect(d.subject).toBe(
      'AECi daily digest (production) — 2026-07-23: 512 requests of unresolved origin (UNFILTERED), 8 new users · top: Revit · 260 crawls',
    );
  });

  it('renders human counts, deltas, and the human top-product list in the text body', () => {
    const { text } = buildAnalyticsDigest(base, opts);
    expect(text).toContain('== Traffic (unresolved origin) ==');
    expect(text).toContain(
      'Requests of unresolved origin: 512 (+112 (+28%) vs 400 prior day)  [upper bound]',
    );
    expect(text).toContain('(260 bot/crawler views excluded — see Crawler activity)');
    expect(text).toContain('New sign-ins (new accounts): 8 (+3 (+60%) vs 5 prior day)');
    expect(text).toContain('Total sign-ins (registered users): 143');
    expect(text).toContain('1. Revit — 120 views (/revit)');
    expect(text).toContain('2. AutoCAD — 90 views (/autocad)');
    expect(text).toContain('Reviews awaiting moderation: 3 — see /admin/reviews');
  });

  it('lists human traffic sources in the Traffic sources section', () => {
    const { text, html } = buildAnalyticsDigest(base, opts);
    expect(text).toContain('== Traffic sources (unresolved) ==');
    expect(text).toContain('1. Direct — 300 views');
    expect(text).toContain('2. Google — 120 views');
    expect(text).toContain('3. LinkedIn — 60 views');
    expect(text).toContain('4. Twitter/X — 32 views');
    expect(html).toContain('Traffic sources (unresolved)');
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
    expect(html).toContain('Traffic (unresolved origin)');
    expect(html).toContain('Crawler activity');
    expect(html).toContain('Bingbot');
    expect(html).toContain('Datacenter (AWS)');
  });

  it('handles a zero-prior day (omits the percentage) and a downward delta', () => {
    const { text } = buildAnalyticsDigest(
      { ...base, pageViews: { day: 5, prior: 0 }, newUsers: { day: 3, prior: 10 } },
      opts,
    );
    expect(text).toContain('Requests of unresolved origin: 5 (+5 vs 0 prior day)');
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
        corroboratedViews: { day: 0, prior: 0 },
        corroboratedVisitors: 0,
        operatorLeakViews: 0,
        automation: null,
        swarm: null,
        arrivalCoverage: HEALTHY_COVERAGE,
        priorArrivalCoverage: HEALTHY_COVERAGE,
      },
      opts,
    );
    expect(subject).toBe(
      'AECi daily digest (production) — 2026-07-23: 40 requests of unresolved origin (UNFILTERED), 0 new users',
    );
    expect(text).toContain('Requests of unresolved origin: 40 (no change vs prior day)');
    expect(text).not.toContain('bot/crawler views excluded');
    expect(text).toContain('Most viewed product: (no unresolved product page views)');
    expect(text).toContain('(no referrer data yet)');
    expect(text).toContain('Reviews awaiting moderation: 0');
    expect(text).toContain('No bot/crawler activity.');
    expect(html).toContain('No referrer data yet.');
    expect(html).toContain('No bot/crawler activity.');
  });
});

describe('buildAnalyticsDigest — the two bounds (AECI-658 / AECI-660)', () => {
  const metrics: AnalyticsMetrics = {
    pageViews: { day: 48, prior: 40 },
    botPageViews: { day: 734, prior: 700 },
    newUsers: { day: 0, prior: 0 },
    totalUsers: 3,
    pendingModeration: 0,
    topProducts: [{ name: 'Corpay', slug: 'corpay', views: 2 }],
    referrers: [{ source: 'Direct', views: 48 }],
    botActivity: [{ name: 'Bingbot', crawls: 173 }],
    corroboratedViews: { day: 3, prior: 2 },
    corroboratedVisitors: 2,
    operatorLeakViews: 0,
    automation: null,
    swarm: null,
    arrivalCoverage: HEALTHY_COVERAGE,
    priorArrivalCoverage: HEALTHY_COVERAGE,
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-08-23',
    generatedAt: new Date('2026-08-24T05:00:00.000Z'),
  };

  it('qualifies the headline number in the subject line', () => {
    // The subject is what the operator actually reads. For weeks it asserted a
    // figure that was an order of magnitude high with nothing to qualify it.
    //
    // AECI-869 replaced the AECI-658 "up to" hedge rather than adding to it. The
    // hedge existed to soften the word "human"; with the claim itself gone, the
    // subject names the class and the filter state, and never says "human".
    const { subject } = buildAnalyticsDigest(metrics, opts);
    expect(subject).toContain('48 requests of unresolved origin (UNFILTERED)');
    expect(subject).not.toContain('human');
  });

  it('labels the server-side count as an upper bound in both renderings', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('[upper bound]');
    // The upper-bound label belongs to the RAW server-side count, and says what
    // it bounds. The headline is a residual and is never described that way.
    expect(text).toContain('any crawler that does not run JavaScript is in the number');
    expect(html).toContain('upper bound');
  });

  it('reports the PostHog floor beside it when the join ran', () => {
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      posthog: { pageviews: 5, people: 1 },
    });
    // The real 2026-08-23 numbers: 48 server-side, 5 client-side from 1 identity
    // — and that identity WAS the operator, which is why AECI-869 stopped calling
    // it a bound on anything.
    expect(text).toContain('PostHog page views: 5 from 1 identity  [separate observation]');
    expect(text).toContain('That is a different population, not a floor under the headline');
    expect(html).toContain('separate observation');
    // No arithmetic between the two populations, in either rendering.
    expect(text).toContain('Do not add it to, or subtract it from, any figure above.');
    expect(text).not.toContain('LOWER bound');
    expect(html).not.toContain('lower bound');
  });

  it('pluralizes people correctly', () => {
    const { text } = buildAnalyticsDigest(metrics, {
      ...opts,
      posthog: { pageviews: 12, people: 4 },
    });
    expect(text).toContain('PostHog page views: 12 from 4 identities  [separate observation]');
    expect(text).not.toContain('persons');
  });

  it('says the floor is unavailable rather than printing a zero', () => {
    // A fabricated 0 beside a real 48 would read as a finding rather than as
    // missing data.
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      posthogUnavailable: 'posthog_credentials_missing',
    });
    expect(text).toContain('PostHog client-side figure unavailable (posthog_credentials_missing)');
    expect(text).not.toContain('PostHog page views: 0');
    expect(html).toContain('unavailable');
  });

  it("renders exactly today's email when neither read is supplied", () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).not.toContain('PostHog');
    expect(html).not.toContain('PostHog');
    expect(text).not.toContain('Automation signal');
  });

  it('carries the swarm note into both renderings when one is supplied', () => {
    const note = '31 of 48 may not be people: 7 clients each read nearly every page.';
    const { text, html } = buildAnalyticsDigest(
      { ...metrics, automation: { flagged: { day: 31, prior: 0 }, note } },
      opts,
    );
    expect(text).toContain(`Automation signal: ${note}`);
    expect(html).toContain('Automation signal');
    expect(html).toContain('31 of 48 may not be people');
  });

  it('stays quiet when nothing was flagged', () => {
    const { text, html } = buildAnalyticsDigest(
      { ...metrics, automation: { flagged: { day: 0, prior: 0 }, note: null } },
      opts,
    );
    expect(text).not.toContain('Automation signal');
    expect(html).not.toContain('Automation signal');
  });
});

describe('buildAnalyticsDigest — the browser-starts line (AECI-870)', () => {
  /**
   * `app_started` is the Tier 2 beacon: it fires for every visitor with no
   * consent gate, so it is a different population from the consented `$pageview`
   * figure printed beside it and from the D1 residual printed above both. The
   * three states this block pins are present / zero / unavailable, and the rule
   * they all serve is that nothing is ever summed.
   */
  const metrics: AnalyticsMetrics = {
    pageViews: { day: 48, prior: 40 },
    botPageViews: { day: 734, prior: 700 },
    newUsers: { day: 0, prior: 0 },
    totalUsers: 3,
    pendingModeration: 0,
    topProducts: [{ name: 'Corpay', slug: 'corpay', views: 2 }],
    referrers: [{ source: 'Direct', views: 48 }],
    botActivity: [{ name: 'Bingbot', crawls: 173 }],
    corroboratedViews: { day: 3, prior: 2 },
    corroboratedVisitors: 2,
    operatorLeakViews: 0,
    automation: { flagged: { day: 8, prior: 6 }, note: null },
    swarm: null,
    arrivalCoverage: HEALTHY_COVERAGE,
    priorArrivalCoverage: HEALTHY_COVERAGE,
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-09-08',
    generatedAt: new Date('2026-09-09T05:00:00.000Z'),
  };

  it('prints starts and the search-referred subset in both renderings', () => {
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      browserStarts: { startsAll: 34, starts: 21, searchReferred: 9 },
    });
    expect(text).toContain('Browser starts: 21 (9 search-referred)  [separate observation]');
    expect(html).toContain('>21</strong> browser starts');
    expect(html).toContain('>9</strong> search-referred');
  });

  it('names both exclusions, on both renderings', () => {
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      browserStarts: { startsAll: 34, starts: 21, searchReferred: 9 },
    });
    expect(text).toContain('Operator and PostHog-detected bots excluded');
    expect(html).toContain('operator and PostHog-detected bots excluded');
  });

  it('states the two things the figure is not', () => {
    // It counts bundle executions, not people — memory persistence mints a fresh
    // anonymous id per page load, so persons approximately equal starts. And a
    // tracker blocker silences it entirely: the client posts straight to
    // us.i.posthog.com with no reverse proxy.
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      browserStarts: { startsAll: 34, starts: 21, searchReferred: 9 },
    });
    expect(text).toContain('Counts bundle executions, not people');
    expect(text).toContain('browsers with tracker blockers never report');
    expect(html).toContain('bundle executions, not people');
    expect(html).toContain('tracker blockers never report');
  });

  it('forbids the arithmetic rather than merely omitting it', () => {
    const { text } = buildAnalyticsDigest(metrics, {
      ...opts,
      browserStarts: { startsAll: 34, starts: 21, searchReferred: 9 },
    });
    expect(text).toContain('Do not add it to, or subtract it from, any figure above.');
    expect(text).toContain('not a floor under the headline and not an addend to it');
  });

  it('renders a zero as a zero, because zero starts is a FINDING', () => {
    // A day with arrivals and no starts means a broken bundle or a blocked
    // collector. Suppressing the line there would hide the one reading that
    // matters most.
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      browserStarts: { startsAll: 0, starts: 0, searchReferred: 0 },
    });
    expect(text).toContain('Browser starts: 0 (0 search-referred)');
    expect(html).toContain('>0</strong> browser start');
    expect(text).not.toContain('unavailable');
  });

  it('says why when the read failed, and never substitutes a zero', () => {
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      browserStartsUnavailable: 'posthog_http_503',
    });
    expect(text).toContain('Browser starts: unavailable (posthog_http_503)');
    expect(html).toContain('Browser-start figure unavailable (posthog_http_503)');
    expect(text).not.toContain('Browser starts: 0');
  });

  it('omits the line entirely when the caller passed neither', () => {
    // The default `/admin/overview` load does not query PostHog at all, and the
    // digest must degrade the same way rather than claiming a zero.
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).not.toContain('Browser starts');
    expect(html).not.toContain('browser start');
  });

  it('leaves the PostHog $pageview line untouched and separate', () => {
    const { text } = buildAnalyticsDigest(metrics, {
      ...opts,
      posthog: { pageviews: 20, people: 2 },
      browserStarts: { startsAll: 34, starts: 21, searchReferred: 9 },
    });
    // Two lines, two populations, one vendor. Neither folds into the other.
    expect(text).toContain('PostHog page views: 20 from 2 identities  [separate observation]');
    expect(text).toContain('Browser starts: 21 (9 search-referred)  [separate observation]');
    expect(text).not.toContain('41'); // 20 + 21, the sum nobody may print
  });
});

describe('buildAnalyticsDigest — the headline is the post-automation count (AECI-741)', () => {
  // The real production shape for 2026-08-30: 70 human views server-side, 56 of
  // them flagged as one rotating-proxy operation, against a prior day of 87 with
  // 64 flagged. The operator asked for 14 to be the number they see.
  const metrics: AnalyticsMetrics = {
    pageViews: { day: 70, prior: 87 },
    botPageViews: { day: 708, prior: 477 },
    newUsers: { day: 0, prior: 0 },
    totalUsers: 3,
    pendingModeration: 0,
    topProducts: [],
    referrers: [{ source: 'Direct', views: 70 }],
    botActivity: [{ name: 'SemrushBot', crawls: 294 }],
    corroboratedViews: { day: 0, prior: 2 },
    corroboratedVisitors: 0,
    operatorLeakViews: 0,
    // On the METRICS since AECI-745, not on the options: the collector runs the
    // detector, so the email and `/admin/overview` subtract the same figure by
    // construction instead of by both callers remembering to pass it.
    automation: { flagged: { day: 56, prior: 64 }, note: '56 of 70 may not be people.' },
    swarm: null,
    arrivalCoverage: HEALTHY_COVERAGE,
    priorArrivalCoverage: HEALTHY_COVERAGE,
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-08-30',
    generatedAt: new Date('2026-08-31T05:00:00.000Z'),
  };

  it('leads the subject with the filtered figure and keeps the raw one in parentheses', () => {
    const { subject } = buildAnalyticsDigest(metrics, opts);
    expect(subject).toContain('14 requests of unresolved origin (70 raw)');
    expect(subject).not.toContain('up to 70');
  });

  it('makes the filtered count the primary stat in both renderings', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('Requests of unresolved origin: 14');
    expect(text).toContain('from 70 counted server-side');
    expect(text).toContain('less 56 views flagged as automation  [upper bound]');
    // The big number in the HTML tile is 14, not 70.
    expect(html).toContain('>14</span> <span style="font-size:14px;color:#71717a">');
    expect(html).toContain('requests of unresolved origin');
    // AECI-869: the word appears on the corroborated line and nowhere else.
    expect(text).not.toContain('human page views');
  });

  it('computes the delta filtered-against-filtered, never filtered-against-raw', () => {
    // 14 vs 23 is -9 (-39%). Against the raw prior day of 87 it would read
    // -73 (-84%) — a fabricated collapse, every single morning.
    const { text } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('Requests of unresolved origin: 14 (-9 (-39%) vs 23 prior day)');
    expect(text).not.toContain('vs 87 prior day)  [headline]');
  });

  it('still reports the raw day-over-day delta on the demoted line', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('from 70 counted server-side (-17 (-20%) vs 87 prior day)');
    expect(html).toContain('-17 (-20%) vs 87 prior day');
  });

  it('describes the raw figure as the upper bound and the headline as an estimate', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('The raw');
    expect(text).toContain('server-side figure is an UPPER bound on humans');
    expect(text).toContain('Read it as a RESIDUAL, not as people');
    expect(html).toContain('<strong>upper bound</strong> on humans');
    expect(html).toContain('what no rule could exclude, which is not the same as a person');
  });

  it('falls back to the raw count and SAYS SO when the detector did not run', () => {
    // A failed detector must not be able to look like a clean day.
    const { subject, text, html } = buildAnalyticsDigest({ ...metrics, automation: null }, opts);
    expect(subject).toContain('70 requests of unresolved origin (UNFILTERED)');
    expect(text).toContain(
      'Requests of unresolved origin: 70 (-17 (-20%) vs 87 prior day)  [upper bound]',
    );
    expect(text).toContain('automation filter did not run this day');
    expect(text).toContain('this figure is UNFILTERED');
    expect(html).toContain('The automation filter did not run for this day');
  });

  it('distinguishes "ran, flagged nothing" from "did not run"', () => {
    const { text } = buildAnalyticsDigest(
      { ...metrics, automation: { flagged: { day: 0, prior: 0 }, note: null } },
      opts,
    );
    // Ran and found nothing: headline equals raw, with no outage warning.
    expect(text).toContain('Requests of unresolved origin: 70');
    expect(text).not.toContain('did not run');
  });

  it('clamps a headline that would go negative rather than printing one', () => {
    const { text } = buildAnalyticsDigest(
      { ...metrics, automation: { flagged: { day: 999, prior: 999 }, note: null } },
      opts,
    );
    expect(text).toContain('Requests of unresolved origin: 0');
    expect(text).not.toContain('-929');
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
    botActivity: [{ name: 'Googlebot', crawls: 1851 }],
    corroboratedViews: { day: 3, prior: 4 },
    corroboratedVisitors: 3,
    operatorLeakViews: 0,
    // 198 flagged by request shape alone — the only detector that still worked,
    // because `client_verdict` is read per row and needs no network.
    automation: {
      flagged: { day: 198, prior: 150 },
      note: '198 of 878 may not be people: 198 views arrived with request headers that do not look like a browser, from network unknown (198 requests), which is evidence about those requests themselves rather than an inference from how many of them there were.',
    },
    swarm: null,
    arrivalCoverage: BLIND_COVERAGE,
    priorArrivalCoverage: BLIND_COVERAGE,
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-09-10',
    generatedAt: new Date('2026-09-11T05:00:00.000Z'),
    posthog: { pageviews: 20, people: 2 },
    // AECI-870. The measured Sep 10 production figures: 21 raw `app_started`
    // rows, 13 after the operator and PostHog's own bot verdict are removed, 7 of
    // those carrying a search referrer. Beside a residual of 680 — the non-
    // operator bundle executions were 2% of the headline.
    browserStarts: { startsAll: 21, starts: 13, searchReferred: 7 },
  };

  it('reports 2026-09-10 honestly: unresolved, telemetry missing, no arithmetic', () => {
    const { subject, text, html } = buildAnalyticsDigest(SEP10, opts);

    // 1. The headline is the residual, under its own name, and the figure is the
    //    one the day actually produced.
    expect(subject).toContain('680 requests of unresolved origin (878 raw)');
    expect(text).toContain('Requests of unresolved origin: 680');
    expect(html).toContain('>680</span>');

    // 2. "Human" appears ONLY on the corroborated line, and that line says what
    //    corroborated it.
    expect(text).toContain('Corroborated as human by an external referrer: 3');
    expect(text).toContain('That referrer is what corroborates them as human');
    expect(text).not.toContain('human page views');
    expect(text).not.toContain('human views');
    expect(html).not.toContain('human page view');

    // 3. The exclusions that DID run are still listed beside the headline.
    expect(text).toContain('less 198 views flagged as automation');
    expect(text).toContain('Bot/crawler page views: 1851');

    // 4. The telemetry outage is unmissable: subject, body, and HTML.
    expect(subject).toContain('NO NETWORK TELEMETRY');
    expect(text).toContain(
      'Arrival network telemetry unavailable for this day; network-based exclusions did not run.',
    );
    expect(text).toContain('0 of 2736 arrivals carried a network (ASN)');
    expect(html).toContain('Arrival network telemetry unavailable for this day');

    // 5. PostHog is a separate observation with its own caveat, and the email
    //    forbids the arithmetic rather than merely omitting it.
    expect(text).toContain('PostHog page views: 20 from 2 identities  [separate observation]');
    expect(text).toContain('That is a different population, not a floor under the headline');
    expect(text).toContain('Do not add it to, or subtract it from, any figure above.');
    expect(text).not.toContain('lower bound');
    expect(text).not.toContain('The truth is between');

    // 6. The referrer line is supporting evidence and a SUBSET, never an addend.
    expect(text).toContain('supporting evidence, not a verified floor');
    expect(text).toContain('It is a SUBSET of the headline, never an addend to it.');

    // 7. And the NULL-ASN group is labelled rather than counted as a network.
    expect(text).toContain('network unknown (198 requests)');
    expect(text).not.toContain('from 1 network,');

    // 8. AECI-870. Browser starts are a FOURTH observation on the same day, and
    //    the email does no arithmetic between them and the 680. Explicitly: no
    //    subtraction (680 - 13 = 667), no ratio, no "of which", and no claim that
    //    13 bounds 680 from below.
    expect(text).toContain('Browser starts: 13 (7 search-referred)  [separate observation]');
    expect(html).toContain('browser starts');
    expect(text).toContain('Counts bundle executions, not people');
    expect(text).toContain('browsers with tracker blockers never report');
    for (const forbidden of ['667', '680 - 13', '13 of 680', '2%', '1.9%']) {
      expect(text).not.toContain(forbidden);
      expect(html).not.toContain(forbidden);
    }
  });

  it('suppresses the day-over-day arithmetic across a telemetry boundary', () => {
    // Both days blind here, but the rule is EITHER: a measured day beside a blind
    // one is the case that actually misleads, because the blind day over-reports.
    const { text } = buildAnalyticsDigest(SEP10, opts);
    expect(text).toContain(
      'not comparable with the prior day (arrival network telemetry was unavailable)',
    );
    // The number that would have been printed is absent, not merely hedged.
    expect(text).not.toContain('vs 900 prior day');
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
