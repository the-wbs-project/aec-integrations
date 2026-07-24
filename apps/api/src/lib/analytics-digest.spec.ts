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

    expect(m.pageViews).toEqual({ day: 4, prior: 2 });
    expect(m.newUsers).toEqual({ day: 2, prior: 1 });
    expect(m.totalUsers).toBe(4);
    expect(m.pendingModeration).toBe(2);
    expect(m.topProducts).toEqual([
      { name: 'P1', slug: 'p1', views: 2 },
      { name: 'P2', slug: 'p2', views: 1 },
    ]);
  });

  it('returns zeroes and an empty top-products list on an empty database', async () => {
    const m = await collectAnalyticsMetrics(t.db, window);
    expect(m.pageViews).toEqual({ day: 0, prior: 0 });
    expect(m.newUsers).toEqual({ day: 0, prior: 0 });
    expect(m.totalUsers).toBe(0);
    expect(m.pendingModeration).toBe(0);
    expect(m.topProducts).toEqual([]);
  });
});

describe('buildAnalyticsDigest', () => {
  const base: AnalyticsMetrics = {
    pageViews: { day: 512, prior: 400 },
    newUsers: { day: 8, prior: 5 },
    totalUsers: 143,
    pendingModeration: 3,
    topProducts: [
      { name: 'Revit', slug: 'revit', views: 120 },
      { name: 'AutoCAD', slug: 'autocad', views: 90 },
    ],
  };
  const opts = {
    env: 'production',
    dayLabel: '2026-07-23',
    generatedAt: new Date('2026-07-24T12:00:05.000Z'),
  };

  it('summarizes the day in the subject, including the top product', () => {
    const d = buildAnalyticsDigest(base, opts);
    expect(d.subject).toBe(
      'AECi daily digest (production) — 2026-07-23: 512 views, 8 new users · top: Revit',
    );
  });

  it('renders counts, day-over-day deltas, and the top-product list in the text body', () => {
    const { text } = buildAnalyticsDigest(base, opts);
    expect(text).toContain('Page views: 512 (+112 (+28%) vs 400 prior day)');
    expect(text).toContain('New sign-ins (new accounts): 8 (+3 (+60%) vs 5 prior day)');
    expect(text).toContain('Total sign-ins (registered users): 143');
    expect(text).toContain('1. Revit — 120 views (/revit)');
    expect(text).toContain('2. AutoCAD — 90 views (/autocad)');
    expect(text).toContain('Reviews awaiting moderation: 3 — see /admin/reviews');
  });

  it('handles a zero-prior day (omits the percentage) and a downward delta', () => {
    const { text } = buildAnalyticsDigest(
      { ...base, pageViews: { day: 5, prior: 0 }, newUsers: { day: 3, prior: 10 } },
      opts,
    );
    expect(text).toContain('Page views: 5 (+5 vs 0 prior day)');
    expect(text).toContain('New sign-ins (new accounts): 3 (-7 (-70%) vs 10 prior day)');
  });

  it('reports "no change" and the empty / clean states', () => {
    const { subject, text } = buildAnalyticsDigest(
      {
        pageViews: { day: 40, prior: 40 },
        newUsers: { day: 0, prior: 0 },
        totalUsers: 0,
        pendingModeration: 0,
        topProducts: [],
      },
      opts,
    );
    expect(subject).toBe('AECi daily digest (production) — 2026-07-23: 40 views, 0 new users');
    expect(text).toContain('Page views: 40 (no change vs prior day)');
    expect(text).toContain('Most viewed product: (no product page views)');
    expect(text).toContain('Reviews awaiting moderation: 0');
  });
});
