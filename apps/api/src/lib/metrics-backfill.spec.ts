/**
 * The `metrics_daily` historical backfill (AECI-581 / §7.1).
 *
 * The generated statements are executed against the in-memory D1 harness's raw
 * better-sqlite3 handle — the same engine and the same committed migrations D1
 * runs — so these are not string assertions about SQL, they are assertions about
 * what the SQL does.
 *
 * Two of them are the AC's: the backfill is re-runnable without duplicating or
 * corrupting real snapshots, and (the honesty check) the values it writes agree
 * with what the live endpoint would aggregate for the same days. The one
 * deliberate exception is `catalog.products_created`, which is backfilled from
 * `products.created_at` and is therefore *better* than the audit-log series the
 * live path reads — §4's correction, D6.
 */

import { ADMIN_METRIC_KEYS, ARRIVAL_COVERAGE_METRIC, type AdminMetricKey } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, metricsDaily, pageViews, products, profiles } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { metricSeries, utcDayWindow } from './admin-analytics';
import { readArrivalCfCoverage } from './arrival-coverage';
import {
  BACKFILL_SERIES,
  buildAggregateStatements,
  buildCoverageProbe,
  buildMetricsBackfillStatements,
  buildProductsCrossCheck,
  buildRangeProbe,
  buildUnclassifiedProbe,
  buildValueDiffProbes,
  buildZeroFillStatements,
  daysInRange,
  isoBounds,
  type BackfillRange,
  type BackfillSeries,
} from './metrics-backfill';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const UNFILTERED = { available: false, applied: false, asns: [], predicate: undefined };

/**
 * Series that get a placeholder `0` on a day with no source rows.
 *
 * All but one (AECI-869): `quality.arrival_cf_coverage` opts out, because 0 is
 * that ratio's WORST value rather than its empty one, and zero-filling would
 * write "totally blind" into permanent history for every day with no arrivals.
 * Derived from the flag rather than hardcoded, so a second opt-out is counted
 * automatically.
 */
const ZERO_FILLED = BACKFILL_SERIES.filter((s) => s.zeroFill !== false);

const RANGE: BackfillRange = {
  fromDay: '2026-08-08',
  toDay: '2026-08-10',
  computedAt: '2026-08-20T00:00:00.000Z',
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/** Run the statements the way the ops script does — one at a time. */
function run(statements: string[]): void {
  for (const sql of statements) t.raw.prepare(sql).run();
}

function backfill(range: BackfillRange = RANGE): void {
  run(buildMetricsBackfillStatements(range));
}

function rows(): Array<{
  day: string;
  metric: string;
  value: number;
  source: string;
  computed_at: string;
}> {
  return t.raw
    .prepare(
      'SELECT day, metric, value, source, computed_at FROM metrics_daily ORDER BY day, metric',
    )
    .all() as never;
}

function valueOf(day: string, metric: string): number | undefined {
  return rows().find((r) => r.day === day && r.metric === metric)?.value;
}

async function seed(): Promise<void> {
  await t.db.insert(pageViews).values([
    { path: '/', isBot: false, createdAt: '2026-08-08T01:00:00.000Z' },
    { path: '/products/x', isBot: false, createdAt: '2026-08-08T02:00:00.000Z' },
    { path: '/', isBot: true, botName: 'Googlebot', createdAt: '2026-08-08T03:00:00.000Z' },
    // Operator-only routes: excluded from the backfill exactly as from the live path.
    { path: '/admin/traffic', isBot: false, createdAt: '2026-08-08T04:00:00.000Z' },
    { path: '/account', isBot: false, createdAt: '2026-08-08T05:00:00.000Z' },
    // 2026-08-09 is deliberately silent — it must still get rows.
    {
      path: '/',
      isBot: false,
      userAgentHash: 'a',
      cfAsn: 1,
      createdAt: '2026-08-10T01:00:00.000Z',
    },
    {
      path: '/',
      isBot: false,
      userAgentHash: 'b',
      cfAsn: 1,
      createdAt: '2026-08-10T02:00:00.000Z',
    },
    // Outside the range on both sides.
    { path: '/', isBot: false, createdAt: '2026-08-07T23:59:59.999Z' },
    { path: '/', isBot: false, createdAt: '2026-08-11T00:00:00.000Z' },
  ]);
  await t.db.insert(auditLog).values([
    { actorType: 'system', action: 'integration.created', createdAt: '2026-08-08T01:00:00.000Z' },
    { actorType: 'system', action: 'integration.created', createdAt: '2026-08-08T02:00:00.000Z' },
    { actorType: 'system', action: 'vendor.created', createdAt: '2026-08-10T01:00:00.000Z' },
    { actorType: 'system', action: 'claim.created', createdAt: '2026-08-10T02:00:00.000Z' },
    // Only 1 of the 2 products below has a `product.created` event — the exact
    // shape of the §4 shortfall the products series exists to correct.
    { actorType: 'system', action: 'product.created', createdAt: '2026-08-10T03:00:00.000Z' },
    { actorType: 'system', action: 'product.updated', createdAt: '2026-08-10T04:00:00.000Z' },
  ]);
  await t.db.insert(products).values([
    { id: u(10), slug: 'p1', name: 'P1', createdAt: '2026-08-10T03:00:00.000Z' },
    { id: u(11), slug: 'p2', name: 'P2', createdAt: '2026-08-10T05:00:00.000Z' },
  ]);
  await t.db
    .insert(profiles)
    .values([{ id: u(20), role: 'reviewer', createdAt: '2026-08-09T01:00:00.000Z' }]);
}

describe('range helpers', () => {
  it('enumerates the inclusive day range', () => {
    expect(daysInRange(RANGE)).toEqual(['2026-08-08', '2026-08-09', '2026-08-10']);
    expect(daysInRange({ ...RANGE, toDay: RANGE.fromDay })).toEqual(['2026-08-08']);
  });

  it('widens the inclusive range to half-open ISO bounds', () => {
    expect(isoBounds(RANGE)).toEqual({
      startIso: '2026-08-08T00:00:00.000Z',
      endIso: '2026-08-11T00:00:00.000Z',
    });
  });
});

describe('coverage', () => {
  it('writes a row for every (day, metric) in the range, including silent days', async () => {
    await seed();
    backfill();

    // §7.4: the pruning cron may not delete a page_views day the snapshot never
    // captured, so a gap here would deadlock pruning for that day forever.
    expect(rows()).toHaveLength(daysInRange(RANGE).length * ZERO_FILLED.length);
    expect(valueOf('2026-08-09', 'traffic.page_views_human')).toBe(0);
    // And the opt-out holds: the seeded rows carry no `navigation`, so there are
    // no arrivals to measure and the coverage key is ABSENT rather than 0. An
    // absent row reads as "not assessed"; a 0 would read as a total outage.
    expect(valueOf('2026-08-09', ARRIVAL_COVERAGE_METRIC)).toBeUndefined();
  });

  it('writes nothing outside the range', async () => {
    await seed();
    backfill();
    expect(rows().some((r) => r.day < RANGE.fromDay || r.day > RANGE.toDay)).toBe(false);
  });

  it('does not backfill stock metrics', async () => {
    // §4: a past total is unrecoverable, so reconstructing one would be wrong
    // rather than approximate. Stocks begin at the first cron run.
    await seed();
    backfill();
    expect(rows().some((r) => r.metric.endsWith('_total'))).toBe(false);
    expect(rows().some((r) => r.metric.startsWith('queue.'))).toBe(false);
    expect(rows().some((r) => r.metric === 'catalog.products_promoted')).toBe(false);
  });
});

describe('the values agree with the live endpoint', () => {
  // The endpoint serves backfilled days from `metrics_daily` and everything else
  // by live aggregation. If these disagreed, a chart would step at the boundary.
  //
  // `quality.arrival_cf_coverage` is excluded for a structural reason rather than
  // a behavioural one (AECI-869): it is not an `AdminMetricKey` at all, so there
  // is no live `metricSeries` to agree WITH — `/api/admin/metrics/timeseries`
  // deliberately does not serve a ratio. Its own agreement test is below, against
  // `readArrivalCfCoverage`.
  const AGREES = BACKFILL_SERIES.filter(
    (s): s is BackfillSeries & { metric: AdminMetricKey } =>
      s.metric !== 'catalog.products_created' &&
      (ADMIN_METRIC_KEYS as readonly string[]).includes(s.metric),
  );

  it.each(AGREES.map((s) => s.metric))('%s matches metricSeries day by day', async (metric) => {
    await seed();
    backfill();
    for (const day of daysInRange(RANGE)) {
      const { perDay } = await metricSeries(t.db, metric, utcDayWindow(day), UNFILTERED);
      expect({ day, value: valueOf(day, metric) }).toEqual({ day, value: perDay.get(day) ?? 0 });
    }
  });

  /**
   * The AECI-869 acceptance case, run against the AECI-868 shape.
   *
   * This is the test that says the outage is recoverable *as a marker*. The
   * `cf_asn` values themselves are gone forever, but the NULLs are still in the
   * table, so a later `ops:backfill-metrics-daily` over 2026-09-07..fix-day can
   * mark those days degraded **from the rows themselves** rather than from a
   * hand-written list of dates somebody has to remember to keep.
   */
  it('reconstructs arrival coverage per day, and agrees with the live tripwire', async () => {
    await t.db.insert(pageViews).values([
      // A healthy day: three arrivals, all carrying a network.
      ...[1, 2, 3].map((n) => ({
        path: '/',
        isBot: false,
        navigation: 'arrival',
        cfAsn: 13335,
        createdAt: `2026-08-08T0${n}:00:00.000Z`,
      })),
      // The AECI-868 day: four arrivals, one of which kept its ASN. 0.25, well
      // under the 0.95 bar, and NOT 0 — a partial outage has to be visible too.
      ...[1, 2, 3].map((n) => ({
        path: '/',
        isBot: false,
        navigation: 'arrival',
        createdAt: `2026-08-10T0${n}:00:00.000Z`,
      })),
      {
        path: '/',
        isBot: false,
        navigation: 'arrival',
        cfAsn: 13335,
        createdAt: '2026-08-10T04:00:00.000Z',
      },
      // An `spa` row on the blind day, deliberately: the browser tracker POSTs its
      // own request and was never affected, so counting it would dilute exactly
      // the signal this measures.
      {
        path: '/',
        isBot: false,
        navigation: 'spa',
        createdAt: '2026-08-10T05:00:00.000Z',
      },
    ]);
    backfill();

    expect(valueOf('2026-08-08', ARRIVAL_COVERAGE_METRIC)).toBe(1);
    expect(valueOf('2026-08-10', ARRIVAL_COVERAGE_METRIC)).toBe(0.25);
    // The silent day gets no row at all rather than a 0 — see ZERO_FILLED above.
    expect(valueOf('2026-08-09', ARRIVAL_COVERAGE_METRIC)).toBeUndefined();

    // And the generated SQL agrees with the module the live check and the digest
    // both read. Two definitions of "coverage" is the failure this rules out.
    for (const day of ['2026-08-08', '2026-08-10']) {
      const w = utcDayWindow(day);
      const live = await readArrivalCfCoverage(t.db, w.startIso, w.endIso);
      expect({ day, value: valueOf(day, ARRIVAL_COVERAGE_METRIC) }).toEqual({
        day,
        value: live.coverage,
      });
    }
  });

  it('catalog.products_created is backfilled from products.created_at, and is better than the audit log', async () => {
    await seed();
    backfill();

    // Both products were created on 2026-08-10; only one has a `product.created`
    // event. §4's correction: `created_at` IS the first-promote timestamp, so the
    // backfill is exact and the audit-log series undercounts.
    expect(valueOf('2026-08-10', 'catalog.products_created')).toBe(2);
    const { perDay } = await metricSeries(
      t.db,
      'catalog.products_created',
      utcDayWindow('2026-08-10'),
      UNFILTERED,
    );
    expect(perDay.get('2026-08-10')).toBe(1);
  });

  it('excludes operator-only routes, exactly as the live path does', async () => {
    await seed();
    backfill();
    // 2026-08-08 has 5 rows; 2 are /admin or /account, 1 is a bot.
    expect(valueOf('2026-08-08', 'traffic.page_views_human')).toBe(2);
    expect(valueOf('2026-08-08', 'traffic.page_views_bot')).toBe(1);
  });

  it('excludes operator SESSIONS and lapsed-session pairs, like NOT_INTERNAL (AECI-683)', async () => {
    // This is a REGRESSION test for a real divergence, not a hypothetical one.
    // `notInternalSql()` restated only the §9.6 path exclusion and carried no
    // `is_operator` clause at all, from the day §13 D13 shipped until AECI-683 —
    // so any range re-backfilled in that period wrote operator traffic into
    // `metrics_daily`, which is retained indefinitely and cannot recompute.
    await seed();
    await t.db.insert(pageViews).values([
      // A verified operator session.
      {
        path: '/products/x',
        isBot: false,
        userAgentHash: 'op-ua',
        cfAsn: 23700,
        isOperator: true,
        createdAt: '2026-08-09T01:00:00.000Z',
      },
      // The same browser and network after the token expired — unflagged, and
      // reachable only through the pair.
      {
        path: '/products/x',
        isBot: false,
        userAgentHash: 'op-ua',
        cfAsn: 23700,
        isOperator: false,
        createdAt: '2026-08-09T02:00:00.000Z',
      },
      // A real visitor the same day, who must survive both clauses.
      {
        path: '/',
        isBot: false,
        userAgentHash: 'visitor-ua',
        cfAsn: 7922,
        createdAt: '2026-08-09T03:00:00.000Z',
      },
    ]);
    backfill();

    expect(valueOf('2026-08-09', 'traffic.page_views_human')).toBe(1);
    // And it agrees with the Drizzle predicate, which is the property that
    // actually matters — a reconstructed day must be indistinguishable from a
    // measured one.
    const { perDay } = await metricSeries(
      t.db,
      'traffic.page_views_human',
      utcDayWindow('2026-08-09'),
      UNFILTERED,
    );
    expect(perDay.get('2026-08-09') ?? 0).toBe(1);
  });
});

describe('provenance', () => {
  it('labels the audit-log-derived catalog series reconstructed and everything else measured', async () => {
    await seed();
    backfill();

    const sources = new Map(rows().map((r) => [r.metric, r.source]));
    expect(sources.get('catalog.integrations_created')).toBe('reconstructed');
    expect(sources.get('catalog.vendors_created')).toBe('reconstructed');
    expect(sources.get('catalog.claims_created')).toBe('reconstructed');

    expect(sources.get('traffic.page_views_human')).toBe('measured');
    expect(sources.get('traffic.page_views_bot')).toBe('measured');
    expect(sources.get('traffic.unique_visitors')).toBe('measured');
    expect(sources.get('accounts.sign_ins_new')).toBe('measured');
    // §4's exception (D6) — the one catalog series that is exactly recoverable.
    expect(sources.get('catalog.products_created')).toBe('measured');
  });

  it('carries the same provenance on a zero-filled day as on a populated one', async () => {
    await seed();
    backfill();
    const silent = rows().filter((r) => r.day === '2026-08-09');
    expect(silent.find((r) => r.metric === 'catalog.claims_created')?.source).toBe('reconstructed');
    expect(silent.find((r) => r.metric === 'traffic.page_views_human')?.source).toBe('measured');
  });
});

describe('re-runnability and precedence', () => {
  it('is idempotent — a second run changes no value and adds no row', async () => {
    await seed();
    backfill();
    const first = rows();

    backfill({ ...RANGE, computedAt: '2026-08-21T00:00:00.000Z' });
    const second = rows();

    expect(second).toHaveLength(first.length);
    expect(second.map((r) => [r.day, r.metric, r.value, r.source])).toEqual(
      first.map((r) => [r.day, r.metric, r.value, r.source]),
    );
    // `computed_at` advances only on rows the second run actually wrote. A day
    // that aggregated to nothing keeps its original stamp, because the zero-fill
    // pass is DO NOTHING and the aggregate pass has no row for it — so the stamp
    // reads "when this value was last written", which is the honest answer.
    const stamp = (r: { value: number; computed_at: string }) =>
      r.value > 0 ? '2026-08-21T00:00:00.000Z' : '2026-08-20T00:00:00.000Z';
    expect(second.every((r) => r.computed_at === stamp(r))).toBe(true);
    expect(second.some((r) => r.computed_at === '2026-08-21T00:00:00.000Z')).toBe(true);
  });

  it('never overwrites a measured snapshot with a reconstructed value', async () => {
    await seed();
    // What the cron captured on the day, which the audit log can no longer prove.
    await t.db.insert(metricsDaily).values({
      day: '2026-08-08',
      metric: 'catalog.integrations_created',
      value: 99,
      source: 'measured',
      computedAt: '2026-08-09T00:15:00.000Z',
    });

    backfill();

    const row = rows().find(
      (r) => r.day === '2026-08-08' && r.metric === 'catalog.integrations_created',
    );
    expect(row).toMatchObject({ value: 99, source: 'measured' });
    expect(row?.computed_at).toBe('2026-08-09T00:15:00.000Z');
  });

  it('does not overwrite a measured snapshot with a measured backfill of a different value', async () => {
    await seed();
    // A traffic row the cron wrote from data since pruned: the backfill would now
    // compute 0, and a placeholder must never displace it.
    await t.db.insert(metricsDaily).values({
      day: '2026-08-09',
      metric: 'traffic.page_views_human',
      value: 17,
      source: 'measured',
      computedAt: '2026-08-10T00:15:00.000Z',
    });

    run(buildZeroFillStatements(RANGE));

    // The zero-fill pass is DO NOTHING, so the captured value survives it. (The
    // aggregate pass then legitimately recomputes it — that is the correcting
    // re-run, not the placeholder.)
    expect(valueOf('2026-08-09', 'traffic.page_views_human')).toBe(17);
  });

  it('upgrades a reconstructed row when re-run over the same day', async () => {
    await seed();
    await t.db.insert(metricsDaily).values({
      day: '2026-08-08',
      metric: 'catalog.integrations_created',
      value: 99,
      source: 'reconstructed',
      computedAt: '2026-08-09T00:00:00.000Z',
    });

    run(buildAggregateStatements(RANGE));

    expect(valueOf('2026-08-08', 'catalog.integrations_created')).toBe(2);
  });
});

describe('the operator probes', () => {
  it('counts unclassified page views inside the range only', async () => {
    await t.db.insert(pageViews).values([
      { path: '/', isBot: null, createdAt: '2026-08-08T01:00:00.000Z' },
      { path: '/', isBot: null, createdAt: '2026-08-10T01:00:00.000Z' },
      { path: '/', isBot: false, createdAt: '2026-08-10T02:00:00.000Z' },
      // Outside the range, and an operator-only route inside it: neither counts.
      { path: '/', isBot: null, createdAt: '2026-08-01T01:00:00.000Z' },
      { path: '/admin/traffic', isBot: null, createdAt: '2026-08-09T01:00:00.000Z' },
    ]);
    const probe = t.raw.prepare(buildUnclassifiedProbe(RANGE)).get() as { unclassified: number };
    expect(probe.unclassified).toBe(2);
  });

  it('reports the full reconstructible range across all four sources', async () => {
    await seed();
    const probe = t.raw.prepare(buildRangeProbe()).get() as {
      first_day: string;
      last_day: string;
    };
    expect(probe).toEqual({ first_day: '2026-08-07', last_day: '2026-08-11' });
  });

  it('reports coverage by counting rows, since D1 reports no changes for an upsert', async () => {
    await seed();
    backfill();
    const probe = t.raw.prepare(buildCoverageProbe(RANGE)).get() as {
      rows_total: number;
      days_covered: number;
      reconstructed: number;
    };
    expect(probe).toEqual({
      rows_total: daysInRange(RANGE).length * ZERO_FILLED.length,
      days_covered: daysInRange(RANGE).length,
      // The three audit_log-derived catalog series, on every day in the range.
      reconstructed: daysInRange(RANGE).length * 3,
    });
  });

  it('cross-checks products against the product.created events', async () => {
    await seed();
    const probe = t.raw.prepare(buildProductsCrossCheck()).get() as {
      products: number;
      product_created_events: number;
    };
    // The shortfall is the evidence for D6, not a defect.
    expect(probe).toEqual({ products: 2, product_created_events: 1 });
  });
});

describe('the dry run reports what it would change (AECI-688)', () => {
  // `metrics_daily` is retained indefinitely, so the operator has to be able to
  // see the rewrite before authorising it. These assert the report is neither
  // over-broad (a matching day must stay quiet, and a day the run cannot touch
  // must not be counted as a rewrite) nor under-broad (a series that collapses
  // to zero must still be surfaced, as `stale`).
  interface Diff {
    kind: 'rewrite' | 'stale';
    day: string;
    stored: number | null;
    recomputed: number;
  }

  function diff(metric: string, range: BackfillRange = RANGE): Diff[] {
    const probe = buildValueDiffProbes(range).find((p) => p.metric === metric);
    if (!probe) throw new Error(`no probe for ${metric}`);
    return t.raw.prepare(probe.sql).all() as never;
  }

  it('reports a stale stored value with both the old and the new number', async () => {
    await seed();
    // The AECI-688 shape: a row the cron wrote under the OLD definition, higher
    // than what the current predicate aggregates for the same day.
    await t.db.insert(metricsDaily).values({
      day: '2026-08-08',
      metric: 'traffic.page_views_human',
      value: 4,
      source: 'measured',
      computedAt: '2026-08-09T00:15:00.000Z',
    });

    expect(diff('traffic.page_views_human')).toEqual([
      { kind: 'rewrite', day: '2026-08-08', stored: 4, recomputed: 2 },
      // A day with no stored row at all is a change too — `(none)` in the
      // printed report — and must not be confused with a day that agrees.
      { kind: 'rewrite', day: '2026-08-10', stored: null, recomputed: 2 },
    ]);
  });

  it('stays silent on a day whose stored value already agrees', async () => {
    await seed();
    backfill();
    // Post-apply, every series must report nothing — this is how the run
    // verifies itself, and it is the mechanical form of "no step at the
    // boundary".
    for (const series of BACKFILL_SERIES) expect(diff(series.metric)).toEqual([]);
  });

  it('reports a day that fell out of the SELECT as `stale`, and the run leaves it alone', () => {
    // The asymmetric case: the aggregate SELECT emits no row for this day, so a
    // one-sided join from `src` would miss it entirely. But the run does not fix
    // it either — the aggregate writes nothing and zero-fill is DO NOTHING — so
    // it must NOT be reported as a rewrite. Collapsing it to 0 would be worse
    // than leaving it: §7.4 prunes raw page_views once the day is captured, so a
    // zeroing run would erase the long memory for every aged-out day.
    t.raw
      .prepare(
        `INSERT INTO metrics_daily (day, metric, value, source, computed_at) ` +
          `VALUES ('2026-08-09', 'traffic.page_views_human', 7, 'measured', '2026-08-10T00:15:00.000Z')`,
      )
      .run();

    expect(diff('traffic.page_views_human')).toEqual([
      { kind: 'stale', day: '2026-08-09', stored: 7, recomputed: 0 },
    ]);

    backfill();
    expect(valueOf('2026-08-09', 'traffic.page_views_human')).toBe(7);
  });

  it('does not report a reconstructed series over a measured row the run cannot touch', async () => {
    await seed();
    // A `measured` row for a `reconstructed` series: precedence forbids the
    // write, so reporting it would promise a change that never happens.
    await t.db.insert(metricsDaily).values({
      day: '2026-08-08',
      metric: 'catalog.integrations_created',
      value: 99,
      source: 'measured',
      computedAt: '2026-08-09T00:15:00.000Z',
    });

    expect(diff('catalog.integrations_created')).toEqual([]);
    // Same row, same disagreement, but a measured series — reported, because
    // that write DOES apply.
    await t.db.insert(metricsDaily).values({
      day: '2026-08-08',
      metric: 'traffic.page_views_bot',
      value: 99,
      source: 'measured',
      computedAt: '2026-08-09T00:15:00.000Z',
    });
    expect(diff('traffic.page_views_bot')).toEqual([
      { kind: 'rewrite', day: '2026-08-08', stored: 99, recomputed: 1 },
    ]);
  });

  it('agrees with the write about scope — every reported day actually changes', async () => {
    await seed();
    await t.db.insert(metricsDaily).values([
      {
        day: '2026-08-08',
        metric: 'traffic.page_views_human',
        value: 4,
        source: 'measured',
        computedAt: '2026-08-09T00:15:00.000Z',
      },
      {
        day: '2026-08-08',
        metric: 'catalog.integrations_created',
        value: 99,
        source: 'measured',
        computedAt: '2026-08-09T00:15:00.000Z',
      },
      // A day with no source rows left, on a series the run WILL touch
      // elsewhere. It must land in the `stale` half, not the rewrite half.
      {
        day: '2026-08-09',
        metric: 'traffic.page_views_bot',
        value: 12,
        source: 'measured',
        computedAt: '2026-08-10T00:15:00.000Z',
      },
    ]);
    const reported = BACKFILL_SERIES.flatMap((s) =>
      diff(s.metric).map((d) => ({ ...d, metric: s.metric })),
    );
    const predicted = new Map(
      reported
        .filter((d) => d.kind === 'rewrite')
        .map((d) => [`${d.day}|${d.metric}`, d.recomputed] as const),
    );
    const untouched = reported
      .filter((d) => d.kind === 'stale')
      .map((d) => [`${d.day}|${d.metric}`, d.stored] as const);
    expect(untouched).toEqual([['2026-08-09|traffic.page_views_bot', 12]]);

    backfill();

    // Nothing the probe promised was skipped, and nothing it stayed quiet about
    // moved. The second half is what catches the two clauses drifting apart.
    for (const [key, recomputed] of predicted) {
      const [day, metric] = key.split('|');
      expect({ key, value: valueOf(day, metric) }).toEqual({ key, value: recomputed });
    }
    expect(valueOf('2026-08-08', 'catalog.integrations_created')).toBe(99);
    // And a `stale` row is a promise too — that the run does NOT move it.
    for (const [key, stored] of untouched) {
      const [day, metric] = key.split('|');
      expect({ key, value: valueOf(day, metric) }).toEqual({ key, value: stored });
    }
  });
});
