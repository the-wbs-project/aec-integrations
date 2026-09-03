/**
 * `GET /api/admin/metrics/timeseries` (AECI-574) against the in-memory D1
 * harness. Covers the UTC window boundaries the AC names — a single-day range, an
 * empty (but valid) range, a reversed range, and rows sitting exactly on each
 * bound — plus the human/bot predicate, the metric vocabulary, and the
 * internal-ASN filter's both-numbers rule.
 *
 * P2.1 (AECI-581) adds the `metrics_daily` read path: snapshot per covered day,
 * live aggregation for the rest, and the per-point `reconstructed` flag. Those
 * specs deliberately seed a snapshot value that DISAGREES with the live rows, so
 * a passing assertion proves the storage actually switched rather than the two
 * happening to agree.
 *
 * AECI-686 adds `basis`. The `net` specs use the same disagree-on-purpose trick
 * in a second place: they seed audit events that do NOT match the surviving rows
 * (the production shape — 11,827 claim creations behind 1,691 live claims), so a
 * `net` assertion can only pass by actually reading the table.
 */

import { AdminTimeseriesResponseSchema, type AdminTimeseriesResponse } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  claims,
  integrations,
  metricsDaily,
  pageViews,
  products,
  profiles,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminTimeseriesHandler } from './admin-metrics';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-08-11T05:00:00.000Z');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function call(query: string, env: Env = TEST_ENV) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/admin/metrics/timeseries',
    handler: createAdminTimeseriesHandler(t.factory, { now: () => NOW }),
  }).request(`/api/admin/metrics/timeseries?${query}`, {}, env, fakeExecutionContext());
}

async function series(query: string, env?: Env): Promise<AdminTimeseriesResponse> {
  const res = await call(query, env);
  expect(res.status).toBe(200);
  return AdminTimeseriesResponseSchema.parse(await res.json());
}

describe('GET /api/admin/metrics/timeseries — UTC window boundaries', () => {
  beforeEach(async () => {
    await t.db.insert(pageViews).values([
      // Exactly the inclusive start of 2026-08-09.
      { path: '/', isBot: false, createdAt: '2026-08-09T00:00:00.000Z' },
      { path: '/', isBot: false, createdAt: '2026-08-09T23:59:59.999Z' },
      { path: '/', isBot: false, createdAt: '2026-08-10T12:00:00.000Z' },
      // Exactly the exclusive end of a window ending 2026-08-10.
      { path: '/', isBot: false, createdAt: '2026-08-11T00:00:00.000Z' },
      { path: '/', isBot: false, createdAt: '2026-08-08T23:59:59.999Z' },
    ]);
  });

  it('treats from/to as INCLUSIVE dates and reports the half-open instants', async () => {
    const body = await series('metric=traffic.page_views_human&from=2026-08-09&to=2026-08-10');
    expect(body.window).toEqual({
      from: '2026-08-09T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
      timezone: 'UTC',
      days: 2,
    });
    // Both boundary rows behave: midnight-start is IN, midnight-end is OUT.
    expect(body.total.total).toBe(3);
    expect(body.points).toEqual([
      { day: '2026-08-09', value: 2, value_excluding_internal: null, reconstructed: false },
      { day: '2026-08-10', value: 1, value_excluding_internal: null, reconstructed: false },
    ]);
  });

  it('accepts a single-day range (from === to)', async () => {
    const body = await series('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10');
    expect(body.window.days).toBe(1);
    expect(body.points).toEqual([
      { day: '2026-08-10', value: 1, value_excluding_internal: null, reconstructed: false },
    ]);
  });

  it('zero-fills an empty-but-valid range instead of returning no points', async () => {
    const body = await series('metric=traffic.page_views_human&from=2026-07-01&to=2026-07-03');
    expect(body.total.total).toBe(0);
    expect(body.points).toEqual([
      { day: '2026-07-01', value: 0, value_excluding_internal: null, reconstructed: false },
      { day: '2026-07-02', value: 0, value_excluding_internal: null, reconstructed: false },
      { day: '2026-07-03', value: 0, value_excluding_internal: null, reconstructed: false },
    ]);
  });

  it('400s a reversed range', async () => {
    const res = await call('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-01');
    expect(res.status).toBe(400);
  });

  it('400s a window longer than page_views retention (400 days)', async () => {
    const res = await call('metric=traffic.page_views_human&from=2025-01-01&to=2026-08-10');
    expect(res.status).toBe(400);
  });

  it('400s a date that matches the shape but does not exist', async () => {
    const res = await call('metric=traffic.page_views_human&from=2026-02-30&to=2026-03-01');
    expect(res.status).toBe(400);
  });

  it('400s an unknown metric', async () => {
    const res = await call('metric=traffic.nope&from=2026-08-10&to=2026-08-10');
    expect(res.status).toBe(400);
  });

  it('flags a window that runs into the current UTC day', async () => {
    const body = await series('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-11');
    expect(body.notes.map((n) => n.code)).toContain('partial_day');
  });
});

describe('GET /api/admin/metrics/timeseries — the metric vocabulary', () => {
  it('splits human and bot using the digest predicate (NULL is_bot reads as human)', async () => {
    await t.db.insert(pageViews).values([
      { path: '/', isBot: false, createdAt: '2026-08-10T01:00:00.000Z' },
      { path: '/', isBot: null, createdAt: '2026-08-10T02:00:00.000Z' },
      { path: '/', isBot: true, botName: 'Googlebot', createdAt: '2026-08-10T03:00:00.000Z' },
    ]);
    const human = await series('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10');
    const bot = await series('metric=traffic.page_views_bot&from=2026-08-10&to=2026-08-10');
    expect(human.total.total).toBe(2);
    expect(bot.total.total).toBe(1);
    expect(human.notes.map((n) => n.code)).toContain('bot_classification_incomplete');
  });

  it('buckets unique visitors per day (a visitor active on two days counts on both)', async () => {
    await t.db.insert(pageViews).values([
      {
        path: '/',
        isBot: false,
        userAgentHash: 'a',
        cfAsn: 1,
        createdAt: '2026-08-09T01:00:00.000Z',
      },
      {
        path: '/',
        isBot: false,
        userAgentHash: 'a',
        cfAsn: 1,
        createdAt: '2026-08-09T02:00:00.000Z',
      },
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
    ]);
    const body = await series('metric=traffic.unique_visitors&from=2026-08-09&to=2026-08-10');
    expect(body.points.map((p) => p.value)).toEqual([1, 2]);
    expect(body.notes.map((n) => n.code)).toContain('visitor_definition_approximate');
  });

  it('sources catalog series from audit_log *.created events and labels them additions', async () => {
    await t.db.insert(auditLog).values([
      { actorType: 'system', action: 'product.created', createdAt: '2026-08-09T01:00:00.000Z' },
      { actorType: 'system', action: 'product.created', createdAt: '2026-08-10T01:00:00.000Z' },
      { actorType: 'system', action: 'product.updated', createdAt: '2026-08-10T02:00:00.000Z' },
      { actorType: 'system', action: 'integration.created', createdAt: '2026-08-10T03:00:00.000Z' },
    ]);
    const body = await series('metric=catalog.products_created&from=2026-08-09&to=2026-08-10');
    expect(body.points.map((p) => p.value)).toEqual([1, 1]);
    // `product.updated` and `integration.created` must not leak into this series.
    expect(body.total.total).toBe(2);
    expect(body.notes.map((n) => n.code)).toContain('catalog_series_is_additions_only');
  });

  it('warns when a catalog window starts before the audit log itself does', async () => {
    await t.db
      .insert(auditLog)
      .values([
        { actorType: 'system', action: 'vendor.created', createdAt: '2026-08-10T01:00:00.000Z' },
      ]);
    const body = await series('metric=catalog.vendors_created&from=2026-08-01&to=2026-08-10');
    const flag = body.notes.find((n) => n.code === 'catalog_series_starts_at');
    expect(flag?.params?.earliest_day).toBe('2026-08-10');
  });

  it('sources new sign-ins from profiles.created_at', async () => {
    await t.db.insert(profiles).values([
      { id: u(1), role: 'reviewer', createdAt: '2026-08-10T01:00:00.000Z' },
      { id: u(2), role: 'reviewer', createdAt: '2026-08-10T02:00:00.000Z' },
      { id: u(3), role: 'reviewer', createdAt: '2026-08-01T02:00:00.000Z' },
    ]);
    const body = await series('metric=accounts.sign_ins_new&from=2026-08-10&to=2026-08-10');
    expect(body.total.total).toBe(2);
  });
});

describe('GET /api/admin/metrics/timeseries — the internal-ASN filter', () => {
  const withAsn: Env = { ...TEST_ENV, ANALYTICS_INTERNAL_ASNS: 'AS23700' };

  beforeEach(async () => {
    await t.db.insert(pageViews).values([
      { path: '/', isBot: false, cfAsn: 23700, createdAt: '2026-08-10T01:00:00.000Z' },
      { path: '/', isBot: false, cfAsn: 23700, createdAt: '2026-08-10T02:00:00.000Z' },
      { path: '/', isBot: false, cfAsn: 7922, createdAt: '2026-08-10T03:00:00.000Z' },
      { path: '/', isBot: false, cfAsn: null, createdAt: '2026-08-10T04:00:00.000Z' },
    ]);
  });

  it('is not applied unless asked for, even when configured', async () => {
    const body = await series(
      'metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10',
      withAsn,
    );
    expect(body.internal_filter).toEqual({ available: true, applied: false, asns: [23700] });
    expect(body.points[0]?.value_excluding_internal).toBeNull();
  });

  it('reports both figures when asked, keeping NULL-ASN rows in the filtered one', async () => {
    const body = await series(
      'metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10&exclude_internal=1',
      withAsn,
    );
    expect(body.internal_filter.applied).toBe(true);
    expect(body.total).toEqual({ total: 4, excluding_internal: 2 });
    expect(body.points[0]).toEqual({
      day: '2026-08-10',
      value: 4,
      value_excluding_internal: 2,
      reconstructed: false,
    });
  });

  it('says so when the filter is requested for a metric that carries no ASN', async () => {
    const body = await series(
      'metric=catalog.products_created&from=2026-08-10&to=2026-08-10&exclude_internal=1',
      withAsn,
    );
    expect(body.total.excluding_internal).toBeNull();
    const flag = body.notes.find((n) => n.code === 'internal_filter_unavailable');
    expect(flag?.params?.metric).toBe('catalog.products_created');
  });
});

describe('GET /api/admin/metrics/timeseries — the metrics_daily snapshot (P2.1)', () => {
  /** Seed one snapshot row. `source` decides whether the day reads as measured. */
  const snap = (day: string, metric: string, value: number, source = 'measured') =>
    t.db.insert(metricsDaily).values({
      day,
      metric,
      value,
      source,
      computedAt: `${day}T00:15:00.000Z`,
    });

  it('serves a fully covered window from the snapshot, ignoring the live rows', async () => {
    // A page view the live aggregation WOULD count. The snapshot must win, which
    // is what proves the read actually switched storage rather than coinciding.
    await t.db
      .insert(pageViews)
      .values([{ path: '/', isBot: false, createdAt: '2026-08-09T01:00:00.000Z' }]);
    await snap('2026-08-09', 'traffic.page_views_human', 42);
    await snap('2026-08-10', 'traffic.page_views_human', 7);

    const body = await series('metric=traffic.page_views_human&from=2026-08-09&to=2026-08-10');
    expect(body.source).toBe('snapshot');
    expect(body.points.map((p) => p.value)).toEqual([42, 7]);
    expect(body.total.total).toBe(49);
  });

  it('falls back to live aggregation for days the snapshot does not cover', async () => {
    await t.db.insert(pageViews).values([
      { path: '/', isBot: false, createdAt: '2026-08-10T01:00:00.000Z' },
      { path: '/', isBot: false, createdAt: '2026-08-10T02:00:00.000Z' },
    ]);
    await snap('2026-08-09', 'traffic.page_views_human', 42);

    const body = await series('metric=traffic.page_views_human&from=2026-08-09&to=2026-08-10');
    expect(body.source).toBe('mixed');
    expect(body.points.map((p) => p.value)).toEqual([42, 2]);
  });

  it('reports source:live when no day in the window was captured', async () => {
    await snap('2026-07-01', 'traffic.page_views_human', 99);
    const body = await series('metric=traffic.page_views_human&from=2026-08-09&to=2026-08-10');
    expect(body.source).toBe('live');
  });

  it('keeps series separate — a snapshot for one metric never answers another', async () => {
    await snap('2026-08-10', 'traffic.page_views_bot', 500);
    const body = await series('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10');
    expect(body.source).toBe('live');
    expect(body.points[0]?.value).toBe(0);
  });

  it('returns a continuous series across the boundary with the reconstructed segment flagged', async () => {
    // The AC: three backfilled days, then two captured on the day, then a day the
    // cron has not reached — one unbroken series, honest about which is which.
    await t.db
      .insert(auditLog)
      .values([
        { actorType: 'system', action: 'vendor.created', createdAt: '2026-08-11T01:00:00.000Z' },
      ]);
    await snap('2026-08-06', 'catalog.vendors_created', 3, 'reconstructed');
    await snap('2026-08-07', 'catalog.vendors_created', 0, 'reconstructed');
    await snap('2026-08-08', 'catalog.vendors_created', 2, 'reconstructed');
    await snap('2026-08-09', 'catalog.vendors_created', 4);
    await snap('2026-08-10', 'catalog.vendors_created', 1);

    const body = await series('metric=catalog.vendors_created&from=2026-08-06&to=2026-08-11');
    expect(body.source).toBe('mixed');
    expect(body.points.map((p) => p.value)).toEqual([3, 0, 2, 4, 1, 1]);
    expect(body.points.map((p) => p.reconstructed)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);

    const flag = body.notes.find((n) => n.code === 'series_partly_reconstructed');
    expect(flag?.severity).toBe('warn');
    expect(flag?.params).toEqual({ reconstructed_days: 3, reconstructed_through: '2026-08-08' });
  });

  it('omits the reconstructed note when every point was measured', async () => {
    await snap('2026-08-10', 'traffic.page_views_human', 5);
    const body = await series('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10');
    expect(body.notes.map((n) => n.code)).not.toContain('series_partly_reconstructed');
    expect(body.points[0]?.reconstructed).toBe(false);
  });

  it('bypasses the snapshot entirely when the internal-ASN filter is applied', async () => {
    // The snapshot stores only the unfiltered figure, so a filtered request must
    // aggregate live or `excluding_internal` would be unanswerable.
    await t.db.insert(pageViews).values([
      { path: '/', isBot: false, cfAsn: 23700, createdAt: '2026-08-10T01:00:00.000Z' },
      { path: '/', isBot: false, cfAsn: 7922, createdAt: '2026-08-10T02:00:00.000Z' },
    ]);
    await snap('2026-08-10', 'traffic.page_views_human', 999);

    const body = await series(
      'metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10&exclude_internal=1',
      { ...TEST_ENV, ANALYTICS_INTERNAL_ASNS: 'AS23700' },
    );
    expect(body.source).toBe('live');
    expect(body.points[0]).toEqual({
      day: '2026-08-10',
      value: 2,
      value_excluding_internal: 1,
      reconstructed: false,
    });
  });

  it('rounds the REAL column to the integer the wire schema requires', async () => {
    await snap('2026-08-10', 'traffic.page_views_human', 4.6);
    const body = await series('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10');
    expect(body.points[0]?.value).toBe(5);
  });
});

describe('GET /api/admin/metrics/timeseries — conventions', () => {
  it('reports live aggregation as such when nothing is snapshotted', async () => {
    const body = await series('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10');
    expect(body.source).toBe('live');
    expect(body.interval).toBe('day');
  });

  it('writes no audit_log row and is never edge-cacheable', async () => {
    const res = await call('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10');
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});

describe('GET /api/admin/metrics/timeseries — basis=net (AECI-686)', () => {
  const P1 = u(1001);
  const P2 = u(1002);
  const V1 = u(2001);
  const I1 = u(3001);
  const D1 = u(4001);
  const C1 = u(5001);

  beforeEach(async () => {
    // Two products that still exist, on two different days.
    await t.db.insert(products).values([
      { id: P1, slug: 'alpha', name: 'Alpha', createdAt: '2026-08-09T01:00:00.000Z' },
      { id: P2, slug: 'beta', name: 'Beta', createdAt: '2026-08-10T01:00:00.000Z' },
    ]);
    await t.db
      .insert(vendors)
      .values([
        { id: V1, slug: 'acme', companyName: 'Acme', createdAt: '2026-08-09T02:00:00.000Z' },
      ]);
    await t.db.insert(integrations).values([
      {
        id: I1,
        sourceProductId: P1,
        targetProductId: P2,
        name: 'Alpha to Beta',
        createdAt: '2026-08-10T02:00:00.000Z',
      },
    ]);
    await t.db.insert(taxonomyDataObjects).values({ id: D1, slug: 'rfi', name: 'RFI' });
    await t.db.insert(claims).values([
      {
        id: C1,
        integrationId: I1,
        dataObjectId: D1,
        direction: 'a_to_b',
        createdAt: '2026-08-10T03:00:00.000Z',
      },
    ]);

    // The audit log tells a DIFFERENT story on purpose: five product creations
    // for two surviving products, mirroring production, where a deleted row keeps
    // its immortal `*.created` event. Any `net` assertion that reads 5 has fallen
    // through to the additions path.
    await t.db.insert(auditLog).values([
      { actorType: 'system', action: 'product.created', createdAt: '2026-08-09T01:00:00.000Z' },
      { actorType: 'system', action: 'product.created', createdAt: '2026-08-09T04:00:00.000Z' },
      { actorType: 'system', action: 'product.created', createdAt: '2026-08-09T05:00:00.000Z' },
      { actorType: 'system', action: 'product.created', createdAt: '2026-08-10T01:00:00.000Z' },
      { actorType: 'system', action: 'product.created', createdAt: '2026-08-10T06:00:00.000Z' },
    ]);
  });

  it('counts surviving rows by created_at, not creation events', async () => {
    const net = await series(
      'metric=catalog.products_created&from=2026-08-09&to=2026-08-10&basis=net',
    );
    expect(net.points.map((p) => p.value)).toEqual([1, 1]);
    expect(net.total.total).toBe(2);

    // The same window on the default basis reads the audit log, and disagrees.
    const additions = await series('metric=catalog.products_created&from=2026-08-09&to=2026-08-10');
    expect(additions.total.total).toBe(5);
  });

  it('reconciles with a live COUNT(*) over a window covering all history', async () => {
    // The property the whole change exists for: each column sums to its table.
    const expected: Array<[string, number]> = [
      ['catalog.products_created', 2],
      ['catalog.vendors_created', 1],
      ['catalog.integrations_created', 1],
      ['catalog.claims_created', 1],
    ];
    for (const [metric, live] of expected) {
      const body = await series(`metric=${metric}&from=2026-08-01&to=2026-08-11&basis=net`);
      expect(body.total.total, metric).toBe(live);
    }
  });

  it('echoes the basis it served, and defaults to additions when unasked', async () => {
    const net = await series(
      'metric=catalog.products_created&from=2026-08-09&to=2026-08-10&basis=net',
    );
    expect(net.basis).toBe('net');
    const fallback = await series('metric=catalog.products_created&from=2026-08-09&to=2026-08-10');
    expect(fallback.basis).toBe('additions');
  });

  it('swaps the audit-log notes for the surviving-rows caveat', async () => {
    const body = await series(
      'metric=catalog.products_created&from=2026-08-01&to=2026-08-10&basis=net',
    );
    const codes = body.notes.map((n) => n.code);
    expect(codes).toContain('catalog_series_is_surviving_rows');
    // Both audit-log notes describe a source `net` never reads. `starts_at` in
    // particular would be actively wrong: this window DOES reach back before the
    // audit log, and on the net basis that is not a data gap.
    expect(codes).not.toContain('catalog_series_is_additions_only');
    expect(codes).not.toContain('catalog_series_starts_at');
  });

  it('warns that promote rewrites claims — on claims only', async () => {
    const claimsBody = await series(
      'metric=catalog.claims_created&from=2026-08-09&to=2026-08-10&basis=net',
    );
    expect(claimsBody.notes.map((n) => n.code)).toContain('catalog_claims_recreated_by_promote');

    const productsBody = await series(
      'metric=catalog.products_created&from=2026-08-09&to=2026-08-10&basis=net',
    );
    expect(productsBody.notes.map((n) => n.code)).not.toContain(
      'catalog_claims_recreated_by_promote',
    );
  });

  it('bypasses the snapshot entirely, because a net value is retroactive', async () => {
    // A stored row for a day in the window, deliberately disagreeing with the
    // table. `additions` must honour it; `net` must ignore it — freezing a
    // retroactive number into `metrics_daily` is exactly what must not happen.
    await t.db.insert(metricsDaily).values({
      day: '2026-08-09',
      metric: 'catalog.products_created',
      value: 99,
      source: 'measured',
      computedAt: '2026-08-10T00:15:00.000Z',
    });

    const additions = await series('metric=catalog.products_created&from=2026-08-09&to=2026-08-09');
    expect(additions.points[0]?.value).toBe(99);
    expect(additions.source).toBe('snapshot');

    const net = await series(
      'metric=catalog.products_created&from=2026-08-09&to=2026-08-09&basis=net',
    );
    expect(net.points[0]?.value).toBe(1);
    expect(net.source).toBe('live');
    // Nothing is being approximated: the rows are right there.
    expect(net.points.every((p) => !p.reconstructed)).toBe(true);
  });

  it('rejects basis=net on a metric with no removable rows', async () => {
    // Silently downgrading to `additions` would hand back a different reading
    // than the caller asked for, unremarked — the §1.1 failure mode.
    const res = await call(
      'metric=traffic.page_views_human&from=2026-08-09&to=2026-08-10&basis=net',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; field?: string } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.field).toBe('basis');
  });

  it('rejects an unknown basis rather than falling back', async () => {
    const res = await call(
      'metric=catalog.products_created&from=2026-08-09&to=2026-08-10&basis=gross',
    );
    expect(res.status).toBe(400);
  });

  it('zero-fills days no surviving row landed on', async () => {
    const body = await series(
      'metric=catalog.vendors_created&from=2026-08-08&to=2026-08-10&basis=net',
    );
    expect(body.points.map((p) => p.value)).toEqual([0, 1, 0]);
  });
});
