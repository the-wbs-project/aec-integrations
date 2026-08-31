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
  computeDelta,
  dailyWindows,
  windowsForDay,
  type AnalyticsMetrics,
} from './analytics-digest';

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
describe('NOT_INTERNAL query shape (the D1 bound-parameter ceiling)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  it('binds a constant number of parameters however many operator pairs exist', async () => {
    // Measured on the prepared SQL text, at the driver, because that is what D1
    // counts. (An earlier version of this guard wrapped `db.all`, which Drizzle's
    // select path never calls — it recorded zero statements and passed
    // vacuously.)
    const widest = async (): Promise<number> => {
      let max = 0;
      const originalPrepare = t.raw.prepare.bind(t.raw);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- swapping the driver's prepare is the only place the bound SQL text exists.
      (t.raw as any).prepare = (sql: string) => {
        if (sql.includes('page_views')) max = Math.max(max, (sql.match(/\?/g) ?? []).length);
        return originalPrepare(sql);
      };
      try {
        await collectAnalyticsMetrics(t.db, dailyWindows(new Date('2026-07-24T12:00:00.000Z')));
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restoring the swap above.
        (t.raw as any).prepare = originalPrepare;
      }
      return max;
    };

    const withNoPairs = await widest();
    // The guard is only meaningful if it saw the queries at all.
    expect(withNoPairs).toBeGreaterThan(0);

    // Twenty-one operator pairs — every one of them a browser/network the naive
    // implementation would have to bind two parameters for.
    await t.db.insert(pageViews).values(
      Array.from({ length: 21 }, (_, i) => ({
        path: '/',
        isBot: false,
        userAgentHash: `ua-${i}`,
        cfAsn: 1000 + i,
        isOperator: true,
        createdAt: '2026-07-23T04:00:00.000Z',
      })),
    );

    expect(await widest()).toBe(withNoPairs);
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
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-07-23',
    generatedAt: new Date('2026-07-24T12:00:05.000Z'),
  };

  it('summarizes humans + top product + crawl count in the subject', () => {
    const d = buildAnalyticsDigest(base, opts);
    expect(d.subject).toBe(
      'AECi daily digest (production) — 2026-07-23: up to 512 human views, 8 new users · top: Revit · 260 crawls',
    );
  });

  it('renders human counts, deltas, and the human top-product list in the text body', () => {
    const { text } = buildAnalyticsDigest(base, opts);
    expect(text).toContain('== Traffic (humans) ==');
    expect(text).toContain('Page views: 512 (+112 (+28%) vs 400 prior day)  [upper bound]');
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
        corroboratedViews: { day: 0, prior: 0 },
        corroboratedVisitors: 0,
        operatorLeakViews: 0,
      },
      opts,
    );
    expect(subject).toBe(
      'AECi daily digest (production) — 2026-07-23: up to 40 human views, 0 new users',
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
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-08-23',
    generatedAt: new Date('2026-08-24T05:00:00.000Z'),
  };

  it('qualifies the headline number in the subject line', () => {
    // The subject is what the operator actually reads. For weeks it asserted a
    // figure that was an order of magnitude high with nothing to qualify it.
    const { subject } = buildAnalyticsDigest(metrics, opts);
    expect(subject).toContain('up to 48 human views');
  });

  it('labels the server-side count as an upper bound in both renderings', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('[upper bound]');
    expect(text).toContain('UPPER bound on humans');
    expect(html).toContain('upper bound');
  });

  it('reports the PostHog floor beside it when the join ran', () => {
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      posthog: { pageviews: 5, people: 1 },
    });
    // The real 2026-08-23 numbers: 48 server-side, 5 client-side from 1 person.
    expect(text).toContain('PostHog page views: 5 from 1 person  [lower bound]');
    expect(text).toContain('a LOWER bound');
    expect(html).toContain('lower bound');
    expect(html).toContain('PostHog page views from');
    expect(html).toContain('</strong> person (client-side, consented only)');
  });

  it('pluralizes people correctly', () => {
    const { text } = buildAnalyticsDigest(metrics, {
      ...opts,
      posthog: { pageviews: 12, people: 4 },
    });
    expect(text).toContain('PostHog page views: 12 from 4 people  [lower bound]');
    expect(text).not.toContain('persons');
  });

  it('says the floor is unavailable rather than printing a zero', () => {
    // A fabricated 0 beside a real 48 would read as a finding rather than as
    // missing data.
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      posthogUnavailable: 'posthog_credentials_missing',
    });
    expect(text).toContain('PostHog lower bound unavailable (posthog_credentials_missing)');
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
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      automation: { flagged: { day: 31, prior: 0 }, note },
    });
    expect(text).toContain(`Automation signal: ${note}`);
    expect(html).toContain('Automation signal');
    expect(html).toContain('31 of 48 may not be people');
  });

  it('stays quiet when nothing was flagged', () => {
    const { text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      automation: { flagged: { day: 0, prior: 0 }, note: null },
    });
    expect(text).not.toContain('Automation signal');
    expect(html).not.toContain('Automation signal');
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
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-08-30',
    generatedAt: new Date('2026-08-31T05:00:00.000Z'),
    automation: { flagged: { day: 56, prior: 64 }, note: '56 of 70 may not be people.' },
  };

  it('leads the subject with the filtered figure and keeps the raw one in parentheses', () => {
    const { subject } = buildAnalyticsDigest(metrics, opts);
    expect(subject).toContain('14 human views after automation (70 raw)');
    expect(subject).not.toContain('up to 70');
  });

  it('makes the filtered count the primary stat in both renderings', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('Human page views after automation: 14');
    expect(text).toContain('from 70 counted server-side');
    expect(text).toContain('less 56 views flagged as automation  [upper bound]');
    // The big number in the HTML tile is 14, not 70.
    expect(html).toContain('>14</span> <span style="font-size:14px;color:#71717a">');
    expect(html).toContain('human page views after automation');
  });

  it('computes the delta filtered-against-filtered, never filtered-against-raw', () => {
    // 14 vs 23 is -9 (-39%). Against the raw prior day of 87 it would read
    // -73 (-84%) — a fabricated collapse, every single morning.
    const { text } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('Human page views after automation: 14 (-9 (-39%) vs 23 prior day)');
    expect(text).not.toContain('vs 87 prior day)  [headline]');
  });

  it('still reports the raw day-over-day delta on the demoted line', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('from 70 counted server-side (-17 (-20%) vs 87 prior day)');
    expect(html).toContain('-17 (-20%) vs 87 prior day');
  });

  it('describes the raw figure as the upper bound and the headline as an estimate', () => {
    const { text, html } = buildAnalyticsDigest(metrics, opts);
    expect(text).toContain('The raw server-side figure is an');
    expect(text).toContain('headline is an estimate');
    expect(html).toContain('<strong>upper bound</strong>');
    expect(html).toContain('heuristic estimate, not a census');
  });

  it('falls back to the raw count and SAYS SO when the detector did not run', () => {
    // A failed detector must not be able to look like a clean day.
    const { subject, text, html } = buildAnalyticsDigest(metrics, {
      ...opts,
      automation: null,
    });
    expect(subject).toContain('up to 70 human views');
    expect(text).toContain('Page views: 70 (-17 (-20%) vs 87 prior day)  [upper bound]');
    expect(text).toContain('automation filter did not run this day');
    expect(text).toContain('this figure is UNFILTERED');
    expect(html).toContain('The automation filter did not run for this day');
  });

  it('distinguishes "ran, flagged nothing" from "did not run"', () => {
    const { text } = buildAnalyticsDigest(metrics, {
      ...opts,
      automation: { flagged: { day: 0, prior: 0 }, note: null },
    });
    // Ran and found nothing: headline equals raw, with no outage warning.
    expect(text).toContain('Human page views after automation: 70');
    expect(text).not.toContain('did not run');
  });

  it('clamps a headline that would go negative rather than printing one', () => {
    const { text } = buildAnalyticsDigest(metrics, {
      ...opts,
      automation: { flagged: { day: 999, prior: 999 }, note: null },
    });
    expect(text).toContain('Human page views after automation: 0');
    expect(text).not.toContain('-929');
  });
});
