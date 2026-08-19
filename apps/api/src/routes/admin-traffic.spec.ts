/**
 * `GET /api/admin/traffic/breakdown` (AECI-574) against the in-memory D1 harness.
 * One case per `dimension` value (the AC names all five), plus the pagination
 * caps, the NULL-bucket rule, and the both-numbers filter.
 */

import {
  AdminTrafficBreakdownResponseSchema,
  type AdminTrafficBreakdownResponse,
} from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, pageViews, products } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminTrafficBreakdownHandler } from './admin-traffic';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-08-11T05:00:00.000Z');
const RANGE = 'from=2026-08-10&to=2026-08-10';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function call(query: string, env: Env = TEST_ENV) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/admin/traffic/breakdown',
    handler: createAdminTrafficBreakdownHandler(t.factory, { now: () => NOW }),
  }).request(`/api/admin/traffic/breakdown?${query}`, {}, env, fakeExecutionContext());
}

async function breakdown(query: string, env?: Env): Promise<AdminTrafficBreakdownResponse> {
  const res = await call(query, env);
  expect(res.status).toBe(200);
  return AdminTrafficBreakdownResponseSchema.parse(await res.json());
}

async function seed(): Promise<void> {
  await t.db.insert(products).values([
    { id: u(1), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: u(2), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(pageViews).values([
    {
      path: '/products/:slug',
      productId: u(1),
      isBot: false,
      referrerSource: 'Direct',
      cfCountry: 'ID',
      cfAsn: 23700,
      createdAt: '2026-08-10T01:00:00.000Z',
    },
    {
      path: '/products/:slug',
      productId: u(1),
      isBot: false,
      referrerSource: 'Direct',
      cfCountry: 'ID',
      cfAsn: 23700,
      createdAt: '2026-08-10T02:00:00.000Z',
    },
    {
      path: '/products/:slug',
      productId: u(2),
      isBot: false,
      referrerSource: 'Google',
      cfCountry: 'US',
      cfAsn: 7922,
      createdAt: '2026-08-10T03:00:00.000Z',
    },
    // No referrer source and no country — the unattributed bucket.
    {
      path: '/',
      isBot: false,
      referrerSource: null,
      cfCountry: null,
      cfAsn: null,
      createdAt: '2026-08-10T04:00:00.000Z',
    },
    // Crawlers.
    {
      path: '/',
      isBot: true,
      botName: 'Googlebot',
      cfCountry: 'US',
      createdAt: '2026-08-10T05:00:00.000Z',
    },
    {
      path: '/',
      isBot: true,
      botName: null,
      cfCountry: 'US',
      createdAt: '2026-08-10T06:00:00.000Z',
    },
  ]);
}

describe('GET /api/admin/traffic/breakdown — every dimension', () => {
  beforeEach(seed);

  it('source: groups by referrer_source and SHOWS the unattributed bucket', async () => {
    const body = await breakdown(`dimension=source&${RANGE}`);
    expect(body.dimension).toBe('source');
    expect(body.traffic).toBe('human');
    expect(body.data).toEqual([
      {
        key: 'Direct',
        label: 'Direct',
        ref: null,
        views: 2,
        views_excluding_internal: null,
        asn_registry: null,
      },
      {
        key: 'Google',
        label: 'Google',
        ref: null,
        views: 1,
        views_excluding_internal: null,
        asn_registry: null,
      },
      {
        key: null,
        label: 'Unattributed',
        ref: null,
        views: 1,
        views_excluding_internal: null,
        asn_registry: null,
      },
    ]);
    // Dropping the null bucket is how a source breakdown starts claiming
    // attribution it does not have: the groups must reconcile to window_total.
    expect(body.data.reduce((n, r) => n + r.views, 0)).toBe(body.window_total.total);
    expect(body.notes.map((n) => n.code)).toContain('direct_is_mixed_bucket');
    expect(body.notes.map((n) => n.code)).toContain('referrer_source_incomplete');
  });

  it('country: groups by cf_country with an Unknown bucket', async () => {
    const body = await breakdown(`dimension=country&${RANGE}`);
    expect(body.data).toEqual([
      {
        key: 'ID',
        label: 'ID',
        ref: null,
        views: 2,
        views_excluding_internal: null,
        asn_registry: null,
      },
      {
        key: 'US',
        label: 'US',
        ref: null,
        views: 1,
        views_excluding_internal: null,
        asn_registry: null,
      },
      {
        key: null,
        label: 'Unknown',
        ref: null,
        views: 1,
        views_excluding_internal: null,
        asn_registry: null,
      },
    ]);
  });

  it('path: groups by the stored route pattern', async () => {
    const body = await breakdown(`dimension=path&${RANGE}`);
    expect(body.data.map((r) => [r.key, r.views])).toEqual([
      ['/products/:slug', 3],
      ['/', 1],
    ]);
  });

  it('product: hydrates a LinkRef so the UI can link without a second lookup', async () => {
    const body = await breakdown(`dimension=product&${RANGE}`);
    expect(body.data).toEqual([
      {
        key: u(1),
        label: 'Procore',
        ref: { id: u(1), name: 'Procore', slug: 'procore' },
        views: 2,
        views_excluding_internal: null,
        asn_registry: null,
      },
      {
        key: u(2),
        label: 'Revit',
        ref: { id: u(2), name: 'Revit', slug: 'revit' },
        views: 1,
        views_excluding_internal: null,
        asn_registry: null,
      },
    ]);
    // Non-product views are not a product, so the groups sum to LESS than
    // window_total — deliberate, and why window_total is returned.
    expect(body.window_total.total).toBe(4);
  });

  it('bot: forces the bot population regardless of ?traffic, and labels a null bot_name', async () => {
    const body = await breakdown(`dimension=bot&${RANGE}&traffic=human`);
    expect(body.traffic).toBe('bot');
    expect(body.data).toEqual([
      {
        key: 'Googlebot',
        label: 'Googlebot',
        ref: null,
        views: 1,
        views_excluding_internal: null,
        asn_registry: null,
      },
      {
        key: null,
        label: 'Other bot',
        ref: null,
        views: 1,
        views_excluding_internal: null,
        asn_registry: null,
      },
    ]);
    expect(body.window_total.total).toBe(2);
  });

  it('?traffic=all counts humans and bots together', async () => {
    const body = await breakdown(`dimension=path&${RANGE}&traffic=all`);
    expect(body.window_total.total).toBe(6);
  });
});

describe('GET /api/admin/traffic/breakdown — pagination over groups', () => {
  beforeEach(async () => {
    // Nine distinct countries with a strictly decreasing view count, so ordering
    // and page boundaries are unambiguous.
    const rows = [];
    for (let i = 0; i < 9; i += 1) {
      for (let n = 0; n <= i; n += 1) {
        rows.push({
          path: '/',
          isBot: false,
          cfCountry: `C${String(9 - i).padStart(2, '0')}`,
          createdAt: `2026-08-10T0${n % 10}:00:00.000Z`,
        });
      }
    }
    await t.db.insert(pageViews).values(rows);
  });

  it('reports the distinct-group count as `total` and slices with page/perPage', async () => {
    const first = await breakdown(`dimension=country&${RANGE}&perPage=4`);
    expect(first.total).toBe(9);
    expect(first.page).toBe(1);
    expect(first.perPage).toBe(4);
    expect(first.data).toHaveLength(4);

    const second = await breakdown(`dimension=country&${RANGE}&perPage=4&page=2`);
    expect(second.data).toHaveLength(4);
    // Stable ordering: no group appears on two pages.
    const overlap = first.data
      .map((r) => r.key)
      .filter((k) => second.data.some((r) => r.key === k));
    expect(overlap).toEqual([]);

    const third = await breakdown(`dimension=country&${RANGE}&perPage=4&page=3`);
    expect(third.data).toHaveLength(1);
  });

  it('caps perPage at 100 (PageQuerySchema)', async () => {
    expect((await call(`dimension=country&${RANGE}&perPage=101`)).status).toBe(400);
    expect((await call(`dimension=country&${RANGE}&perPage=0`)).status).toBe(400);
    expect((await call(`dimension=country&${RANGE}&page=0`)).status).toBe(400);
    expect((await breakdown(`dimension=country&${RANGE}&perPage=100`)).perPage).toBe(100);
  });

  it('defaults to perPage=24, matching every other list endpoint', async () => {
    const body = await breakdown(`dimension=country&${RANGE}`);
    expect(body.perPage).toBe(24);
  });
});

describe('GET /api/admin/traffic/breakdown — validation and conventions', () => {
  it('400s an unknown dimension, a reversed range, and an impossible date', async () => {
    expect((await call(`dimension=browser&${RANGE}`)).status).toBe(400);
    expect((await call('dimension=country&from=2026-08-10&to=2026-08-01')).status).toBe(400);
    expect((await call('dimension=country&from=2026-02-30&to=2026-03-01')).status).toBe(400);
  });

  it('reports both figures when the internal filter is applied', async () => {
    await seed();
    const body = await breakdown(`dimension=country&${RANGE}&exclude_internal=1`, {
      ...TEST_ENV,
      ANALYTICS_INTERNAL_ASNS: '23700',
    });
    expect(body.window_total).toEqual({ total: 4, excluding_internal: 2 });
    expect(body.data).toEqual([
      {
        key: 'ID',
        label: 'ID',
        ref: null,
        views: 2,
        views_excluding_internal: 0,
        asn_registry: null,
      },
      {
        key: 'US',
        label: 'US',
        ref: null,
        views: 1,
        views_excluding_internal: 1,
        asn_registry: null,
      },
      // NULL cf_asn survives the filter.
      {
        key: null,
        label: 'Unknown',
        ref: null,
        views: 1,
        views_excluding_internal: 1,
        asn_registry: null,
      },
    ]);
  });

  it('writes no audit_log row and is never edge-cacheable', async () => {
    const res = await call(`dimension=source&${RANGE}`);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
