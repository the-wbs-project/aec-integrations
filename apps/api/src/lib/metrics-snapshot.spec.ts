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

import {
  ADMIN_SNAPSHOT_METRIC_KEYS,
  ARRIVAL_COVERAGE_METRIC,
  ADMIN_SNAPSHOT_STOCK_METRIC_KEYS,
  PAGE_VIEWS_RETENTION_DAYS,
} from '@aeci/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { enumerateDays, metricSeries, shiftDay, utcDayWindow } from './admin-analytics';
import {
  SNAPSHOT_RECHECK_MAX_CORRECTED_DAYS,
  SNAPSHOT_RECHECK_SLACK_DAYS,
  automationTriggerDays,
  diffCorrections,
  emitMetricsRecheckMetrics,
  emitMetricsSnapshotMetrics,
  recheckWindow,
  runMetricsSnapshot,
  runMetricsSnapshotRecheck,
  summarizeRecheck,
  RECHECK_DETAIL_MAX_ENTRIES,
} from './metrics-snapshot';
import { DETAIL_MAX_BYTES } from './job-runs';
import { OPERATOR_PAIR_LOOKBACK_DAYS } from './page-view-predicates';
import { SWARM_PRIOR_LOOKBACK_DAYS } from './swarm-detection';

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
    const counts = [...rows.entries()].filter(([k]) => k !== ARRIVAL_COVERAGE_METRIC);
    expect(counts.every(([, v]) => v === 0)).toBe(true);
    // The one key that is NOT zero on an empty day, and must not be (AECI-869):
    // it is a RATIO, and 0 is its worst value rather than its empty one. A day
    // with no arrivals has full coverage of nothing, which is what
    // `readArrivalCfCoverage` returns and what the nightly check passes on. Zero
    // here would report a total telemetry outage on every quiet night.
    expect(rows.get(ARRIVAL_COVERAGE_METRIC)).toBe(1);
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
    // NOTE: `traffic.page_views_human_after_automation` is deliberately absent —
    // it has no live `metricSeries` form to agree with (that is what
    // `metricIsSnapshotOnly` means), so it is covered by its own test below.
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

  it('stores the post-automation count, net of what the detector flagged (AECI-745)', async () => {
    // Four views under one fingerprint across four networks — the shape the real
    // detector flags. The stored filtered figure must be the RAW human count less
    // those four, not the raw count and not zero.
    await t.db.insert(pageViews).values(
      Array.from({ length: 4 }, (_, i) => ({
        path: '/products/x',
        isBot: false,
        userAgentHash: 'rotating-proxy',
        cfAsn: 5000 + i,
        cfCountry: ['PL', 'BR', 'ID', 'VN'][i],
        createdAt: `2026-08-10T1${i}:00:00.000Z`,
      })),
    );

    await runMetricsSnapshot(t.db, DAY, NOW);
    const rows = await stored();

    expect(rows.get('traffic.page_views_human')).toBe(6);
    expect(rows.get('traffic.page_views_human_after_automation')).toBe(2);
  });

  it('SKIPS the filtered key rather than storing a raw count when the detector fails', async () => {
    // A stored row is never re-derived, so an unfiltered figure written under the
    // filtered key would be a permanent lie in the long memory — worse than a gap,
    // which the read path already reports honestly as "not measured".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    vi.doMock('./swarm-detection', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./swarm-detection')>()),
      detectSwarms: () => {
        throw new Error('detector exploded');
      },
    }));
    try {
      const mod = await import('./metrics-snapshot');
      await mod.runMetricsSnapshot(t.db, DAY, NOW);
      const rows = await stored();

      expect(rows.has('traffic.page_views_human_after_automation')).toBe(false);
      // …and the rest of the run is unaffected: failure isolation is per key.
      expect(rows.get('traffic.page_views_human')).toBe(2);
    } finally {
      vi.doUnmock('./swarm-detection');
      vi.resetModules();
      warn.mockRestore();
    }
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

// ---------------------------------------------------------------------------
// The trailing re-check (AECI-827 / ADR 0027)
// ---------------------------------------------------------------------------

/** 00:15 on this day; the primary pass captures 2026-09-14, the re-check spans
 *  2026-08-12 … 2026-09-13. */
const TODAY = '2026-09-15';
const RECHECK_NOW = new Date('2026-09-15T00:15:00.000Z');
/** A completed day comfortably inside the window. */
const TARGET = '2026-09-01';
const RETENTION = { retentionDays: PAGE_VIEWS_RETENTION_DAYS };

/** The operator's browser/network pair — the tuple §9.8 calls a visitor. */
const PAIR = { userAgentHash: 'op-browser', cfAsn: 1234 };

/** A `metrics_daily` row as the cron would have left it, without paying for a
 *  whole 20-key run. `computed_at` is deliberately old so a rewrite is visible. */
async function seedStored(day: string, metric: string, value: number): Promise<void> {
  await t.db
    .insert(metricsDaily)
    .values({ day, metric, value, source: 'measured', computedAt: `${day}T00:15:00.000Z` });
}

async function storedRow(day: string, metric: string) {
  const [row] = await t.db
    .select()
    .from(metricsDaily)
    .where(and(eq(metricsDaily.day, day), eq(metricsDaily.metric, metric)));
  return row;
}

describe('recheckWindow', () => {
  it('ends at D-2, because the primary pass just answered D-1', () => {
    const w = recheckWindow(TODAY, PAGE_VIEWS_RETENTION_DAYS);
    expect(w?.toDay).toBe('2026-09-13');
    expect(w?.fromDay).toBe('2026-08-12');
    expect(enumerateDays(w!)).not.toContain('2026-09-14');
  });

  it('reaches the oldest day a NEW anchor can still move, with slack', () => {
    // The arithmetic this constant rests on, as a test rather than a comment.
    // An anchor written during D-1 retro-excludes views back to (D-1) - 30d, so
    // the oldest day that can still move on this run is D-31. The window must
    // cover it, and SNAPSHOT_RECHECK_SLACK_DAYS is what keeps one missed night
    // from stranding it forever.
    const w = recheckWindow(TODAY, PAGE_VIEWS_RETENTION_DAYS);
    const days = enumerateDays(w!);
    expect(days).toContain(shiftDay(TODAY, -(OPERATOR_PAIR_LOOKBACK_DAYS + 1)));
    expect(w!.fromDay < shiftDay(TODAY, -(OPERATOR_PAIR_LOOKBACK_DAYS + 1))).toBe(true);
    expect(w!.days).toBe(OPERATOR_PAIR_LOOKBACK_DAYS + SNAPSHOT_RECHECK_SLACK_DAYS);
  });

  it('never reaches past what page_views still retains', () => {
    // The shipped window is 400 days so this clamp never binds — but the per-tier
    // env override's floor is 30, which is INSIDE the retro-join's reach. Without
    // the clamp, such a tier would recompute pruned days as zero.
    const w = recheckWindow(TODAY, 30);
    expect(w?.fromDay).toBe(shiftDay(TODAY, -30));
    expect(w!.fromDay > recheckWindow(TODAY, PAGE_VIEWS_RETENTION_DAYS)!.fromDay).toBe(true);
  });
});

describe('runMetricsSnapshotRecheck', () => {
  /** Five human views on TARGET: three on the operator's pair, two on a stranger's. */
  async function seedTargetDay(): Promise<void> {
    await t.db.insert(pageViews).values([
      ...Array.from({ length: 3 }, (_, i) => ({
        path: '/products/x',
        isBot: false,
        ...PAIR,
        createdAt: `${TARGET}T0${i + 1}:00:00.000Z`,
      })),
      {
        path: '/',
        isBot: false,
        userAgentHash: 'someone-else',
        cfAsn: 9999,
        createdAt: `${TARGET}T05:00:00.000Z`,
      },
      {
        path: '/',
        isBot: false,
        userAgentHash: 'someone-else',
        cfAsn: 9999,
        createdAt: `${TARGET}T06:00:00.000Z`,
      },
    ]);
  }

  /** The anchor that arrives LATE — the whole defect, in one row. */
  async function seedLateOperatorAnchor(): Promise<void> {
    await t.db.insert(pageViews).values([
      {
        path: '/',
        isBot: false,
        isOperator: true,
        ...PAIR,
        createdAt: '2026-09-10T09:00:00.000Z',
      },
    ]);
  }

  it('corrects a day that went stale after it was snapshotted', async () => {
    await seedTargetDay();
    await runMetricsSnapshot(t.db, TARGET, new Date(`${TARGET}T23:59:00.000Z`));
    expect((await storedRow(TARGET, 'traffic.page_views_human'))?.value).toBe(5);

    await seedLateOperatorAnchor();
    const result = await runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

    expect(result.status).toBe('ok');
    // The stored value now agrees with what the live endpoint would serve, which
    // is the property the whole snapshot-first read path depends on.
    const { perDay } = await metricSeries(
      t.db,
      'traffic.page_views_human',
      utcDayWindow(TARGET),
      UNFILTERED,
    );
    expect((await storedRow(TARGET, 'traffic.page_views_human'))?.value).toBe(perDay.get(TARGET));
    expect((await storedRow(TARGET, 'traffic.page_views_human'))?.value).toBe(2);
    expect(result.corrections).toContainEqual(
      expect.objectContaining({ day: TARGET, metric: 'traffic.page_views_human', value: 2 }),
    );
    // The distinct-visitor count moves for the same reason, on the same day.
    expect((await storedRow(TARGET, 'traffic.unique_visitors'))?.value).toBe(1);
  });

  it('keeps the filtered series at or below the raw one (AECI-745 pairing)', async () => {
    // Correcting the raw count alone would render "222 humans, 224 humans after
    // automation" on /admin/traffic — a defect produced BY the fix.
    await seedTargetDay();
    await runMetricsSnapshot(t.db, TARGET, new Date(`${TARGET}T23:59:00.000Z`));
    await seedLateOperatorAnchor();
    await runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

    const raw = await storedRow(TARGET, 'traffic.page_views_human');
    const filtered = await storedRow(TARGET, 'traffic.page_views_human_after_automation');
    expect(filtered?.value).toBeLessThanOrEqual(raw!.value);
    expect(filtered?.value).toBe(2);
  });

  it('writes NEITHER half of the pair when the detector cannot run', async () => {
    // A day left consistently stale beats one left inconsistently fresh.
    await seedTargetDay();
    await runMetricsSnapshot(t.db, TARGET, new Date(`${TARGET}T23:59:00.000Z`));
    await seedLateOperatorAnchor();

    vi.resetModules();
    vi.doMock('./swarm-detection', async (importOriginal) => ({
      ...(await importOriginal<typeof import('./swarm-detection')>()),
      detectSwarms: () => {
        throw new Error('detector exploded');
      },
    }));
    try {
      const mod = await import('./metrics-snapshot');
      const result = await mod.runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

      expect((await storedRow(TARGET, 'traffic.page_views_human'))?.value).toBe(5);
      expect((await storedRow(TARGET, 'traffic.page_views_human_after_automation'))?.value).toBe(5);
      expect(mod.recheckFailureCount(result)).toBeGreaterThan(0);
      // …and the keys that carry no pairing obligation still landed.
      expect((await storedRow(TARGET, 'traffic.unique_visitors'))?.value).toBe(1);
    } finally {
      vi.doUnmock('./swarm-detection');
      vi.resetModules();
    }
  });

  it('corrects a reconstructed row WITHOUT promoting it to measured', async () => {
    // A correction changes the value, never the provenance. Promoting the row
    // would drop the `reconstructed` flag the timeseries reports per point, and
    // would lock `metrics-backfill.ts` out of it for good — it may never
    // overwrite a `measured` row. Reachable on any tier whose metrics_daily was
    // gap-filled, or any night the cron missed inside the window.
    await seedTargetDay();
    await t.db.insert(metricsDaily).values({
      day: TARGET,
      metric: 'traffic.page_views_human',
      value: 5,
      source: 'reconstructed',
      computedAt: `${TARGET}T00:15:00.000Z`,
    });
    await seedLateOperatorAnchor();

    await runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

    expect(await storedRow(TARGET, 'traffic.page_views_human')).toMatchObject({
      value: 2,
      source: 'reconstructed',
    });
  });

  it('writes nothing when nothing moved, and leaves computed_at alone', async () => {
    // The "rare write" claim is the one that regresses silently, so it is
    // asserted on the column that would prove a rewrite happened.
    await seedTargetDay();
    await runMetricsSnapshot(t.db, TARGET, new Date(`${TARGET}T23:59:00.000Z`));
    const before = await t.db.select().from(metricsDaily);

    const result = await runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

    expect(result.status).toBe('ok');
    expect(result.corrections).toEqual([]);
    expect(await t.db.select().from(metricsDaily)).toEqual(before);
  });

  it('never INSERTS a day the primary pass did not cover', async () => {
    // Not a policy call. `findSnapshotGap` probes metrics_daily with no `metric`
    // predicate, so one row would tell the 03:00 prune this day is captured while
    // every stock — unrecoverable retroactively — is still missing, and the prune
    // would then delete its page_views permanently.
    await seedTargetDay();
    await seedLateOperatorAnchor();

    const result = await runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

    expect(await t.db.select().from(metricsDaily)).toEqual([]);
    expect(result.corrections).toEqual([]);
  });

  it('refuses a day whose raw page_views are gone, rather than zeroing it', async () => {
    // metricSeries' perDay map is not zero-filled, so `?? 0` would turn data loss
    // into a write of 0 over the only surviving record of the day.
    await seedStored(TARGET, 'traffic.page_views_human', 42);

    const result = await runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

    expect((await storedRow(TARGET, 'traffic.page_views_human'))?.value).toBe(42);
    expect(result.refusals).toContainEqual(
      expect.objectContaining({ day: TARGET, reason: 'raw_rows_absent' }),
    );
  });

  it('refuses an INCREASE: the retro-join can only remove rows', async () => {
    // An increase cannot be convergence. It means a predicate change, an is_bot
    // backfill, or restored rows — all of which are the audited backfill's job.
    await seedTargetDay();
    await seedStored(TARGET, 'traffic.page_views_human', 1);

    const result = await runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

    expect((await storedRow(TARGET, 'traffic.page_views_human'))?.value).toBe(1);
    expect(result.refusals).toContainEqual(
      expect.objectContaining({ day: TARGET, reason: 'increase', recomputed: 5 }),
    );
  });

  it('writes NOTHING when more days move than retro-join drift can explain', async () => {
    const days = Array.from({ length: SNAPSHOT_RECHECK_MAX_CORRECTED_DAYS + 1 }, (_, i) =>
      shiftDay('2026-08-20', i),
    );
    for (const day of days) {
      await t.db
        .insert(pageViews)
        .values([{ path: '/', isBot: false, ...PAIR, createdAt: `${day}T01:00:00.000Z` }]);
      await seedStored(day, 'traffic.page_views_human', 9);
    }
    await seedLateOperatorAnchor();

    const result = await runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/ops:backfill-metrics-daily/);
    // Reported, so the operator can see what a dry run would show — but not written.
    expect(result.corrections).toHaveLength(days.length);
    for (const day of days) {
      expect((await storedRow(day, 'traffic.page_views_human'))?.value).toBe(9);
    }
  });

  it('leaves every stock metric untouched, value and computed_at alike', async () => {
    // The type makes this unreachable; the assertion exists because the failure
    // it guards — today's totals stamped onto an August day — is silent and
    // permanent.
    await seedCatalog();
    await seedTargetDay();
    await runMetricsSnapshot(t.db, TARGET, new Date(`${TARGET}T23:59:00.000Z`));
    const before = await t.db.select().from(metricsDaily);
    await seedLateOperatorAnchor();

    await runMetricsSnapshotRecheck(t.db, TODAY, RECHECK_NOW, RETENTION);

    const after = await t.db.select().from(metricsDaily);
    for (const key of ADMIN_SNAPSHOT_STOCK_METRIC_KEYS) {
      const was = before.find((r) => r.metric === key);
      expect(after.find((r) => r.metric === key)).toEqual(was);
    }
  });
});

describe('diffCorrections', () => {
  const days = ['2026-09-01', '2026-09-02', '2026-09-03'];
  const present = new Set(days);
  const point = (value: number) => ({ value, reconstructed: false });

  it('skips a day with no stored row and reports nothing for it', () => {
    const out = diffCorrections(
      'traffic.page_views_human',
      days,
      new Map([['2026-09-01', 3]]),
      new Map(),
      present,
    );
    expect(out).toEqual({ corrections: [], refusals: [] });
  });

  it('treats a day absent from the recompute as zero only when its rows exist', () => {
    const stored = new Map([['2026-09-01', point(4)]]);
    expect(
      diffCorrections('traffic.page_views_bot', days, new Map(), stored, present).corrections,
    ).toEqual([
      {
        day: '2026-09-01',
        metric: 'traffic.page_views_bot',
        stored: 4,
        value: 0,
        reconstructed: false,
      },
    ]);
    expect(
      diffCorrections('traffic.page_views_bot', days, new Map(), stored, new Set()).refusals,
    ).toEqual([
      {
        day: '2026-09-01',
        metric: 'traffic.page_views_bot',
        stored: 4,
        recomputed: 0,
        reason: 'raw_rows_absent',
      },
    ]);
  });

  it('carries the stored row’s provenance onto the correction', () => {
    // A correction changes the VALUE, never whether the day was captured or
    // reconstructed. Without this, the write relabels a backfilled row as
    // `measured` — dropping the flag the timeseries reports per point, and
    // locking `metrics-backfill.ts` out of the row for good.
    const stored = new Map([['2026-09-01', { value: 9, reconstructed: true }]]);
    expect(
      diffCorrections('traffic.page_views_human', days, new Map(), stored, present).corrections,
    ).toEqual([
      {
        day: '2026-09-01',
        metric: 'traffic.page_views_human',
        stored: 9,
        value: 0,
        reconstructed: true,
      },
    ]);
  });

  it('leaves a genuinely quiet day alone rather than calling it data loss', () => {
    // Stored 0, recomputes 0, no rows: no diff, so the raw-row guard is never
    // consulted and the day is not reported as a refusal.
    const out = diffCorrections(
      'traffic.page_views_human',
      days,
      new Map(),
      new Map([['2026-09-02', point(0)]]),
      new Set(),
    );
    expect(out).toEqual({ corrections: [], refusals: [] });
  });
});

describe('automationTriggerDays', () => {
  it('reaches forward over the detector recurrence lookback, never backward', () => {
    // flagged(X) reads day X plus the 14 days BEFORE it, so a day that moved can
    // only change the filtered figure of days at or after it.
    const days = enumerateDays(recheckWindow(TODAY, PAGE_VIEWS_RETENTION_DAYS)!);
    const moved = '2026-08-20';
    const out = automationTriggerDays(days, new Set([moved]));
    expect(out[0]).toBe(moved);
    expect(out).toContain(shiftDay(moved, SWARM_PRIOR_LOOKBACK_DAYS));
    expect(out).not.toContain(shiftDay(moved, -1));
    expect(out).not.toContain(shiftDay(moved, SWARM_PRIOR_LOOKBACK_DAYS + 1));
  });

  it('clips to the window rather than naming days it did not examine', () => {
    const days = ['2026-09-12', '2026-09-13'];
    expect(automationTriggerDays(days, new Set(['2026-09-12']))).toEqual(days);
  });
});

describe('emitMetricsRecheckMetrics', () => {
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

  const moved = (day: string) => ({
    day,
    metric: 'traffic.page_views_human' as const,
    stored: 9,
    value: 8,
    reconstructed: false,
  });

  it('counts a correction per (day, metric) written, plus a run outcome', () => {
    const s = sink();
    emitMetricsRecheckMetrics(
      s,
      {
        status: 'ok',
        corrections: [moved('2026-09-01'), moved('2026-09-02')],
        refusals: [],
        uncoveredDays: [],
        metrics: [],
      },
      7,
    );

    expect(
      s.counts.filter((c) => c.metric === 'aeci.metrics_snapshot.recheck.correction'),
    ).toHaveLength(2);
    expect(s.counts.find((c) => c.metric === 'aeci.metrics_snapshot.recheck.run')?.tags).toEqual([
      'trigger:cron',
      'outcome:ok',
    ]);
    expect(s.distributions).toEqual([
      { metric: 'aeci.metrics_snapshot.recheck.run.duration_ms', value: 7 },
    ]);
  });

  it('counts NO corrections on a skipped run, which wrote nothing', () => {
    // The ceiling branch reports what WOULD have moved so the operator can decide
    // whether to run the backfill. Counting that as work done would overstate the
    // pass on the one night it deliberately did nothing — and OBSERVABILITY.md
    // documents this counter as "one per (day, metric) corrected".
    const s = sink();
    emitMetricsRecheckMetrics(
      s,
      {
        status: 'skipped',
        corrections: [moved('2026-09-01'), moved('2026-09-02')],
        refusals: [],
        uncoveredDays: [],
        metrics: [],
        reason: 'above the ceiling',
      },
      7,
    );

    expect(s.counts.filter((c) => c.metric === 'aeci.metrics_snapshot.recheck.correction')).toEqual(
      [],
    );
    expect(s.counts.find((c) => c.metric === 'aeci.metrics_snapshot.recheck.run')?.tags).toContain(
      'outcome:skipped',
    );
  });

  it('still counts refusals, which are reported whether or not anything was written', () => {
    const s = sink();
    emitMetricsRecheckMetrics(
      s,
      {
        status: 'skipped',
        corrections: [],
        refusals: [
          {
            day: '2026-09-01',
            metric: 'traffic.page_views_human',
            stored: 4,
            recomputed: 9,
            reason: 'increase',
          },
        ],
        uncoveredDays: [],
        metrics: [],
      },
      1,
    );

    expect(
      s.counts.find((c) => c.metric === 'aeci.metrics_snapshot.recheck.refused')?.tags,
    ).toEqual(['trigger:cron', 'metric:traffic.page_views_human', 'reason:increase']);
  });
});

describe('summarizeRecheck — bounded, because capDetail is all-or-nothing', () => {
  const bulk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      day: shiftDay('2026-08-01', i),
      metric: 'traffic.page_views_human' as const,
      stored: 100,
      value: 99,
      reconstructed: false,
    }));

  it('caps the listings while keeping the counts exact', () => {
    const summary = summarizeRecheck({
      status: 'ok',
      corrections: bulk(RECHECK_DETAIL_MAX_ENTRIES + 5),
      refusals: [],
      uncoveredDays: [],
      metrics: [],
    });
    expect(summary.corrected).toBe(RECHECK_DETAIL_MAX_ENTRIES + 5);
    expect(summary.corrections).toHaveLength(RECHECK_DETAIL_MAX_ENTRIES);
  });

  it('leaves room for the primary pass inside DETAIL_MAX_BYTES', () => {
    // `capDetail` replaces the ENTIRE detail with a sentinel when it overflows,
    // so an unbounded array here would delete the twenty per-metric outcomes of
    // the pass that actually captured the day.
    const detail = {
      job: 'metrics-snapshot' as const,
      day: TARGET,
      durationMs: 1,
      written: ADMIN_SNAPSHOT_METRIC_KEYS.length,
      failed: 0,
      metrics: ADMIN_SNAPSHOT_METRIC_KEYS.map((metric) => ({
        metric,
        status: 'written' as const,
        value: 1,
        durationMs: 1,
      })),
      recheck: summarizeRecheck({
        status: 'skipped',
        window: { fromDay: '2026-08-12', toDay: '2026-09-13', days: 33 },
        corrections: bulk(200),
        refusals: bulk(200).map((c) => ({
          day: c.day,
          metric: c.metric,
          stored: c.stored,
          recomputed: c.value,
          reason: 'increase' as const,
        })),
        uncoveredDays: [],
        metrics: [],
        reason: 'x'.repeat(500),
      }),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(detail)).length;
    expect(bytes).toBeLessThan(DETAIL_MAX_BYTES / 4);
  });
});
