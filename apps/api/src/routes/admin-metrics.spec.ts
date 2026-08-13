/**
 * `GET /api/admin/metrics/timeseries` (AECI-574) against the in-memory D1
 * harness. Covers the UTC window boundaries the AC names — a single-day range, an
 * empty (but valid) range, a reversed range, and rows sitting exactly on each
 * bound — plus the human/bot predicate, the metric vocabulary, and the
 * internal-ASN filter's both-numbers rule.
 */

import { AdminTimeseriesResponseSchema, type AdminTimeseriesResponse } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, pageViews, profiles } from '../db/schema';
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
      { day: '2026-08-09', value: 2, value_excluding_internal: null },
      { day: '2026-08-10', value: 1, value_excluding_internal: null },
    ]);
  });

  it('accepts a single-day range (from === to)', async () => {
    const body = await series('metric=traffic.page_views_human&from=2026-08-10&to=2026-08-10');
    expect(body.window.days).toBe(1);
    expect(body.points).toEqual([{ day: '2026-08-10', value: 1, value_excluding_internal: null }]);
  });

  it('zero-fills an empty-but-valid range instead of returning no points', async () => {
    const body = await series('metric=traffic.page_views_human&from=2026-07-01&to=2026-07-03');
    expect(body.total.total).toBe(0);
    expect(body.points).toEqual([
      { day: '2026-07-01', value: 0, value_excluding_internal: null },
      { day: '2026-07-02', value: 0, value_excluding_internal: null },
      { day: '2026-07-03', value: 0, value_excluding_internal: null },
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

describe('GET /api/admin/metrics/timeseries — conventions', () => {
  it('declares a storage-agnostic source so P2.1 can swap in metrics_daily', async () => {
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
