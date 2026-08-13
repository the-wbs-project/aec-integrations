/**
 * The daily `metrics_daily` snapshot (AECI-581 / §7.1) against the in-memory D1
 * harness.
 *
 * The load-bearing assertions here are the AC's, and each is observed rather
 * than assumed: running the job twice for one day leaves ONE row per
 * `(day, metric)` with the later `computed_at`; a failing producer does not take
 * the other metrics down with it; and a measured capture overwrites a
 * reconstructed backfill row but never the reverse.
 */

import { ADMIN_SNAPSHOT_METRIC_KEYS } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  feedback,
  mailingList,
  metricsDaily,
  pageViews,
  products,
  profiles,
  reviews,
  vendorRequests,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { metricSeries, utcDayWindow } from './admin-analytics';
import { emitMetricsSnapshotMetrics, runMetricsSnapshot } from './metrics-snapshot';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = '2026-08-10';
const NOW = new Date('2026-08-11T00:15:00.000Z');

const UNFILTERED = { available: false, applied: false, asns: [], predicate: undefined };

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/** Every `(metric → value)` stored for `day`. */
async function stored(day = DAY): Promise<Map<string, number>> {
  const rows = await t.db.select().from(metricsDaily).where(eq(metricsDaily.day, day));
  return new Map(rows.map((r) => [r.metric, r.value]));
}

/** Drop a table so exactly one producer's query throws. */
function dropTable(name: string): void {
  t.raw.prepare(`DROP TABLE ${name}`).run();
}

/** The catalog/audience/queue rows the stock metrics count. */
async function seedCatalog(): Promise<void> {
  await t.db.insert(vendors).values([
    { id: u(1), slug: 'v1', companyName: 'V1', promotionStatus: 'promoted' },
    { id: u(2), slug: 'v2', companyName: 'V2', promotionStatus: 'pending' },
  ]);
  await t.db.insert(products).values([
    { id: u(10), slug: 'p1', name: 'P1', promotionStatus: 'promoted' },
    { id: u(11), slug: 'p2', name: 'P2', promotionStatus: 'promoted' },
    { id: u(12), slug: 'p3', name: 'P3', promotionStatus: 'pending' },
  ]);
  await t.db.insert(profiles).values([
    { id: u(20), role: 'reviewer' },
    { id: u(21), role: 'admin' },
  ]);
  // One review per (product, reviewer) — the table enforces it.
  const review = (n: number, productId: string, reviewerId: string, status: string) => ({
    id: u(n),
    productId,
    reviewerId,
    status,
    ratingOverall: 4,
    ratingOnboarding: 4,
    title: `Review ${n}`,
    body: 'Body text for the review fixture.',
  });
  await t.db
    .insert(reviews)
    .values([
      review(30, u(10), u(20), 'approved'),
      review(31, u(10), u(21), 'pending'),
      review(32, u(11), u(20), 'rejected'),
    ]);
  const request = (n: number, status: string) => ({
    id: u(n),
    kind: 'claim',
    targetType: 'product',
    targetId: u(10),
    submitterEmail: `submitter-${n}@example.com`,
    body: 'Request body fixture.',
    status,
  });
  await t.db.insert(vendorRequests).values([request(40, 'open'), request(41, 'resolved')]);
  await t.db
    .insert(mailingList)
    .values([
      { email: 'live@x.com' },
      { email: 'gone@x.com', unsubscribedAt: '2026-08-01T00:00:00.000Z' },
    ]);
  await t.db.insert(feedback).values([{ features: 'more charts' }]);
}

describe('runMetricsSnapshot — coverage and idempotence', () => {
  it('writes one row per metric in the vocabulary', async () => {
    const result = await runMetricsSnapshot(t.db, DAY, NOW);

    expect(result.day).toBe(DAY);
    expect(result.metrics).toHaveLength(ADMIN_SNAPSHOT_METRIC_KEYS.length);
    expect(result.metrics.every((m) => m.status === 'written')).toBe(true);

    const rows = await stored();
    expect(rows.size).toBe(ADMIN_SNAPSHOT_METRIC_KEYS.length);
    for (const key of ADMIN_SNAPSHOT_METRIC_KEYS) expect(rows.has(key)).toBe(true);
  });

  it('records an empty database as zeros, not as missing rows', async () => {
    // §7.4's pruning cron may not delete a `page_views` day the snapshot never
    // captured, so a quiet day must still produce a full row set.
    await runMetricsSnapshot(t.db, DAY, NOW);
    const rows = await stored();
    expect([...rows.values()].every((v) => v === 0)).toBe(true);
  });

  it('running twice for the same day leaves one row per (day, metric), with the later computed_at', async () => {
    await runMetricsSnapshot(t.db, DAY, NOW);
    const later = new Date('2026-08-11T06:00:00.000Z');
    await runMetricsSnapshot(t.db, DAY, later);

    const rows = await t.db.select().from(metricsDaily).where(eq(metricsDaily.day, DAY));
    expect(rows).toHaveLength(ADMIN_SNAPSHOT_METRIC_KEYS.length);
    expect(rows.every((r) => r.computedAt === later.toISOString())).toBe(true);
  });

  it('re-running a day after new rows land corrects the value rather than duplicating it', async () => {
    await runMetricsSnapshot(t.db, DAY, NOW);
    expect((await stored()).get('catalog.products_promoted')).toBe(0);

    await seedCatalog();
    await runMetricsSnapshot(t.db, DAY, NOW);

    const rows = await stored();
    expect(rows.size).toBe(ADMIN_SNAPSHOT_METRIC_KEYS.length);
    expect(rows.get('catalog.products_promoted')).toBe(2);
  });

  it('keeps days independent', async () => {
    await t.db
      .insert(pageViews)
      .values([{ path: '/', isBot: false, createdAt: '2026-08-10T01:00:00.000Z' }]);
    await runMetricsSnapshot(t.db, DAY, NOW);
    await runMetricsSnapshot(t.db, '2026-08-09', NOW);

    expect((await stored('2026-08-10')).get('traffic.page_views_human')).toBe(1);
    expect((await stored('2026-08-09')).get('traffic.page_views_human')).toBe(0);
  });
});

describe('runMetricsSnapshot — provenance and precedence', () => {
  it('writes everything as measured', async () => {
    await runMetricsSnapshot(t.db, DAY, NOW);
    const rows = await t.db.select().from(metricsDaily);
    expect(rows.every((r) => r.source === 'measured')).toBe(true);
  });

  it('upgrades a reconstructed backfill row to the measured capture', async () => {
    await t.db.insert(metricsDaily).values({
      day: DAY,
      metric: 'traffic.page_views_human',
      value: 99,
      source: 'reconstructed',
      computedAt: '2026-08-20T00:00:00.000Z',
    });
    await t.db
      .insert(pageViews)
      .values([{ path: '/', isBot: false, createdAt: '2026-08-10T01:00:00.000Z' }]);

    await runMetricsSnapshot(t.db, DAY, NOW);

    const [row] = await t.db
      .select()
      .from(metricsDaily)
      .where(eq(metricsDaily.metric, 'traffic.page_views_human'));
    expect(row).toMatchObject({ value: 1, source: 'measured' });
  });
});

describe('runMetricsSnapshot — the flow metrics agree with the live endpoint', () => {
  beforeEach(async () => {
    await t.db.insert(pageViews).values([
      { path: '/', isBot: false, createdAt: '2026-08-10T01:00:00.000Z' },
      { path: '/products/x', isBot: null, createdAt: '2026-08-10T02:00:00.000Z' },
      { path: '/', isBot: true, botName: 'Googlebot', createdAt: '2026-08-10T03:00:00.000Z' },
      // Operator-only routes are excluded from BOTH paths (§9.6 / AECI-575).
      { path: '/admin/traffic', isBot: false, createdAt: '2026-08-10T04:00:00.000Z' },
      { path: '/account', isBot: false, createdAt: '2026-08-10T05:00:00.000Z' },
      // A different day, to prove the window binds.
      { path: '/', isBot: false, createdAt: '2026-08-11T01:00:00.000Z' },
    ]);
    await t.db.insert(auditLog).values([
      { actorType: 'system', action: 'vendor.created', createdAt: '2026-08-10T01:00:00.000Z' },
      { actorType: 'system', action: 'integration.created', createdAt: '2026-08-10T02:00:00.000Z' },
      { actorType: 'system', action: 'integration.created', createdAt: '2026-08-10T03:00:00.000Z' },
      { actorType: 'system', action: 'claim.created', createdAt: '2026-08-11T01:00:00.000Z' },
    ]);
    await t.db.insert(profiles).values([{ id: u(20), role: 'reviewer' }]);
  });

  // The endpoint falls back to live aggregation for any day the cron has not
  // captured, so a second implementation here would make a chart change value at
  // the snapshot boundary. This is the assertion that keeps them one.
  const FLOW_KEYS = [
    'traffic.page_views_human',
    'traffic.page_views_bot',
    'traffic.unique_visitors',
    'catalog.products_created',
    'catalog.integrations_created',
    'catalog.vendors_created',
    'catalog.claims_created',
    'accounts.sign_ins_new',
  ] as const;

  it.each(FLOW_KEYS)('%s matches metricSeries for the same day', async (metric) => {
    await runMetricsSnapshot(t.db, DAY, NOW);
    const { perDay } = await metricSeries(t.db, metric, utcDayWindow(DAY), UNFILTERED);
    expect((await stored()).get(metric)).toBe(perDay.get(DAY) ?? 0);
  });

  it('excludes operator-only routes from the traffic count', async () => {
    await runMetricsSnapshot(t.db, DAY, NOW);
    // 3 rows on 2026-08-10 outside /admin + /account; 2 read human (NULL counts
    // as human, per the digest's NULL-safe predicate), 1 as bot.
    const rows = await stored();
    expect(rows.get('traffic.page_views_human')).toBe(2);
    expect(rows.get('traffic.page_views_bot')).toBe(1);
  });
});

describe('runMetricsSnapshot — the stock metrics', () => {
  beforeEach(seedCatalog);

  it('counts each stock with the filter its key name promises', async () => {
    await runMetricsSnapshot(t.db, DAY, NOW);
    const rows = await stored();

    expect(rows.get('catalog.products_promoted')).toBe(2); // 3 rows, one pending
    expect(rows.get('catalog.vendors_promoted')).toBe(1);
    expect(rows.get('catalog.reviews_approved')).toBe(1); // approved only
    expect(rows.get('queue.reviews_pending')).toBe(1);
    expect(rows.get('queue.requests_open')).toBe(1); // 'open', not 'resolved'
    expect(rows.get('accounts.profiles_total')).toBe(2);
    expect(rows.get('audience.subscribers_active')).toBe(1);
    expect(rows.get('audience.subscribers_unsubscribed')).toBe(1);
    expect(rows.get('audience.feedback_total')).toBe(1);
  });

  it('samples as of the run, not as of the day label', async () => {
    // A stock has no window: the value is what exists when the cron runs, filed
    // under the day it closes out. Snapshotting an older day gives the same number.
    await runMetricsSnapshot(t.db, '2026-01-01', NOW);
    expect((await stored('2026-01-01')).get('catalog.products_promoted')).toBe(2);
  });
});

describe('runMetricsSnapshot — failure isolation', () => {
  it('records a failing metric and still writes the rest', async () => {
    // §7.1 requires per-key isolation precisely so one broken producer cannot
    // cascade. Dropping `feedback` breaks exactly one metric.
    dropTable('feedback');

    const result = await runMetricsSnapshot(t.db, DAY, NOW);

    const failed = result.metrics.filter((m) => m.status === 'failed');
    expect(failed.map((m) => m.metric)).toEqual(['audience.feedback_total']);
    expect(failed[0]?.error).toBeTruthy();
    expect((await stored()).size).toBe(ADMIN_SNAPSHOT_METRIC_KEYS.length - 1);
  });

  it('never throws', async () => {
    dropTable('page_views');
    await expect(runMetricsSnapshot(t.db, DAY, NOW)).resolves.toBeTruthy();
  });
});

describe('emitMetricsSnapshotMetrics', () => {
  function sink() {
    const counts: Array<{ metric: string; tags: string[] }> = [];
    const distributions: Array<{ metric: string; value: number }> = [];
    return {
      counts,
      distributions,
      count: (metric: string, _v: number, tags: string[]) => counts.push({ metric, tags }),
      distribution: (metric: string, value: number) => distributions.push({ metric, value }),
    };
  }

  it('emits one count per metric plus a run outcome and duration', async () => {
    const result = await runMetricsSnapshot(t.db, DAY, NOW);
    const s = sink();
    emitMetricsSnapshotMetrics(s, result, 1234);

    const perMetric = s.counts.filter((c) => c.metric === 'aeci.metrics_snapshot.metric');
    expect(perMetric).toHaveLength(ADMIN_SNAPSHOT_METRIC_KEYS.length);
    expect(perMetric[0]?.tags).toContain('outcome:written');

    const run = s.counts.find((c) => c.metric === 'aeci.metrics_snapshot.run');
    expect(run?.tags).toEqual(['trigger:cron', 'outcome:ok']);
    expect(s.distributions).toEqual([
      { metric: 'aeci.metrics_snapshot.run.duration_ms', value: 1234 },
    ]);
  });

  it('reports a partial run when some metrics failed but others wrote', async () => {
    dropTable('feedback');
    const result = await runMetricsSnapshot(t.db, DAY, NOW);
    const s = sink();
    emitMetricsSnapshotMetrics(s, result, 1);

    const run = s.counts.find((c) => c.metric === 'aeci.metrics_snapshot.run');
    expect(run?.tags).toContain('outcome:partial');
  });
});
