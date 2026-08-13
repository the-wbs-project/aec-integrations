/**
 * `GET /api/admin/page-views` (AECI-577) against the in-memory D1 harness.
 *
 * The two cases worth reading before the rest: **the D12 floor**, which asserts
 * that no combination of filters can surface an `/admin/*` or `/account` row, and
 * **the both-numbers block**, which asserts that the internal-ASN toggle filters
 * rows without ever leaving the operator a single unlabelled figure.
 */

import {
  ADMIN_PAGE_VIEW_NULL_FILTER,
  AdminPageViewsResponseSchema,
  type AdminPageViewsResponse,
} from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, pageViews, products, vendors } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminPageViewsHandler } from './admin-page-views';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = new Date('2026-08-11T05:00:00.000Z');
const RANGE = 'from=2026-08-10&to=2026-08-10';

/** Two visits share this hash+ASN pair, so they are ONE visitor under §9.8. */
const HASH_A = 'abcdef0123456789';
const HASH_B = 'fedcba9876543210';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function call(query: string, env: Env = TEST_ENV) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/admin/page-views',
    handler: createAdminPageViewsHandler(t.factory, { now: () => NOW }),
  }).request(`/api/admin/page-views?${query}`, {}, env, fakeExecutionContext());
}

async function feed(query: string, env?: Env): Promise<AdminPageViewsResponse> {
  const res = await call(query, env);
  expect(res.status).toBe(200);
  return AdminPageViewsResponseSchema.parse(await res.json());
}

const paths = (body: AdminPageViewsResponse) => body.data.map((r) => r.path);

/**
 * Seven visits on 2026-08-10. Human population is rows 1/2/3/7 — row 3 is
 * `is_bot IS NULL`, which the digest's predicate counts as human — and rows 5/6
 * are operator routes that the §13 D12 floor removes before any filter runs.
 */
async function seed(): Promise<void> {
  await t.db.insert(products).values({
    id: u(1),
    slug: 'procore',
    name: 'Procore',
    promotionStatus: 'promoted',
  });
  await t.db.insert(vendors).values({ id: u(9), slug: 'autodesk', companyName: 'Autodesk, Inc.' });
  await t.db.insert(pageViews).values([
    // 1 — product view, operator's own ISP (AS23700).
    {
      path: '/products/:slug',
      productId: u(1),
      isBot: false,
      referrerSource: 'Direct',
      referrer: null,
      cfCountry: 'ID',
      cfColo: 'CGK',
      cfAsn: 23700,
      userAgentHash: HASH_A,
      createdAt: '2026-08-10T01:00:00.000Z',
    },
    // 2 — vendor view, genuine external arrival.
    {
      path: '/vendors/:slug',
      vendorId: u(9),
      isBot: false,
      referrerSource: 'Google',
      referrer: 'www.google.com',
      cfCountry: 'US',
      cfColo: 'IAD',
      cfAsn: 7922,
      userAgentHash: HASH_B,
      createdAt: '2026-08-10T02:00:00.000Z',
    },
    // 3 — taxonomy route: no entity FK to hydrate, unclassified, unattributed.
    {
      path: '/categories/:slug',
      isBot: null,
      referrerSource: null,
      cfCountry: null,
      cfColo: null,
      cfAsn: null,
      userAgentHash: null,
      createdAt: '2026-08-10T03:00:00.000Z',
    },
    // 4 — crawler.
    {
      path: '/',
      isBot: true,
      botName: 'Googlebot',
      cfCountry: 'US',
      cfAsn: 15169,
      userAgentHash: 'googlebot000000',
      createdAt: '2026-08-10T04:00:00.000Z',
    },
    // 5 + 6 — operator routes. Present in the table, never in the feed (D12).
    {
      path: '/admin/reviews',
      isBot: false,
      cfCountry: 'ID',
      cfAsn: 23700,
      userAgentHash: HASH_A,
      createdAt: '2026-08-10T05:00:00.000Z',
    },
    {
      path: '/account',
      isBot: false,
      cfCountry: 'ID',
      cfAsn: 23700,
      userAgentHash: HASH_A,
      createdAt: '2026-08-10T06:00:00.000Z',
    },
    // 7 — public look-alike: `/administrators` is NOT `/admin`, so it stays.
    //     Same (hash, ASN) as row 1, so the two are one visitor.
    {
      path: '/administrators',
      isBot: false,
      referrerSource: null,
      cfCountry: 'ID',
      cfColo: 'CGK',
      cfAsn: 23700,
      userAgentHash: HASH_A,
      createdAt: '2026-08-10T07:00:00.000Z',
    },
  ]);
}

describe('GET /api/admin/page-views — the feed', () => {
  beforeEach(seed);

  it('returns humans newest-first by default, with the §5.2 columns', async () => {
    const body = await feed(RANGE);
    expect(body.traffic).toBe('human');
    expect(body.total).toBe(4);
    expect(paths(body)).toEqual([
      '/administrators',
      '/categories/:slug',
      '/vendors/:slug',
      '/products/:slug',
    ]);

    const productRow = body.data[3];
    expect(productRow).toMatchObject({
      created_at: '2026-08-10T01:00:00.000Z',
      is_bot: false,
      bot_name: null,
      cf_asn: 23700,
      cf_country: 'ID',
      cf_colo: 'CGK',
      path: '/products/:slug',
      entity_type: 'product',
      entity: { id: u(1), name: 'Procore', slug: 'procore' },
      referrer_source: 'Direct',
      referrer: null,
    });
  });

  it('truncates the UA hash to 8 characters — the full hash never crosses the wire', async () => {
    const body = await feed(RANGE);
    const hashes = body.data.map((r) => r.visitor_hash);
    expect(hashes).toContain(HASH_A.slice(0, 8));
    expect(hashes).not.toContain(HASH_A);
    for (const h of hashes) expect(h === null || h.length === 8).toBe(true);
  });

  it('hydrates product and vendor entities, and leaves a taxonomy route unhydrated', async () => {
    const body = await feed(RANGE);
    const byPath = new Map(body.data.map((r) => [r.path, r]));
    expect(byPath.get('/vendors/:slug')).toMatchObject({
      entity_type: 'vendor',
      entity: { id: u(9), name: 'Autodesk, Inc.', slug: 'autodesk' },
    });
    // AECI-585 stores `concrete_path` / `taxonomy_kind` / `taxonomy_id` at ingest,
    // but this endpoint does not read them (that issue was ingest-only), so a
    // taxonomy row still renders as the bare pattern with no entity.
    expect(byPath.get('/categories/:slug')).toMatchObject({ entity_type: null, entity: null });
  });

  it('counts an unclassified row as human, and ?traffic switches the population', async () => {
    // Row 3 has `is_bot IS NULL` and is in the human page — the over-inclusion
    // `bot_classification_incomplete` exists to disclose.
    expect(paths(await feed(RANGE))).toContain('/categories/:slug');

    const bots = await feed(`${RANGE}&traffic=bot`);
    expect(bots.total).toBe(1);
    expect(bots.data[0]).toMatchObject({ path: '/', is_bot: true, bot_name: 'Googlebot' });

    expect((await feed(`${RANGE}&traffic=all`)).total).toBe(5);
  });

  it('reports unique visitors as distinct (hash, ASN) pairs, not row count', async () => {
    const body = await feed(RANGE);
    // Rows 1 and 7 share HASH_A + AS23700 → one visitor across four views.
    expect(body.window_total.total).toBe(4);
    expect(body.window_visitors.total).toBe(3);
  });
});

describe('GET /api/admin/page-views — the §13 D12 floor', () => {
  beforeEach(seed);

  it('never returns an /admin or /account row under ANY filter combination', async () => {
    const queries = [
      RANGE,
      `${RANGE}&traffic=all`,
      `${RANGE}&traffic=bot`,
      `${RANGE}&country=ID`,
      `${RANGE}&path_contains=admin`,
      `${RANGE}&path_contains=account`,
      `${RANGE}&source=${ADMIN_PAGE_VIEW_NULL_FILTER}`,
      `${RANGE}&perPage=100`,
    ];
    for (const q of queries) {
      const body = await feed(q);
      expect(paths(body).some((p) => p.startsWith('/admin') && p !== '/administrators')).toBe(
        false,
      );
      expect(paths(body)).not.toContain('/account');
    }
  });

  it('still counts /administrators — the exclusion matches an exact prefix boundary', async () => {
    expect(paths(await feed(`${RANGE}&path_contains=admin`))).toEqual(['/administrators']);
  });

  it('excludes operator rows from the counts too, not just the row list', async () => {
    // 7 rows exist; 2 are operator routes. `traffic=all` must report 5.
    expect((await feed(`${RANGE}&traffic=all`)).window_total.total).toBe(5);
    expect(await t.db.select().from(pageViews)).toHaveLength(7);
  });
});

describe('GET /api/admin/page-views — filters', () => {
  beforeEach(seed);

  it('filters by source, including the NULL bucket via the sentinel', async () => {
    expect(paths(await feed(`${RANGE}&source=Direct`))).toEqual(['/products/:slug']);
    expect(paths(await feed(`${RANGE}&source=${ADMIN_PAGE_VIEW_NULL_FILTER}`))).toEqual([
      '/administrators',
      '/categories/:slug',
    ]);
    expect(await feed(`${RANGE}&source=Bing`)).toMatchObject({ total: 0, data: [] });
  });

  it('filters by country, including the NULL bucket via the sentinel', async () => {
    expect(paths(await feed(`${RANGE}&country=ID`))).toEqual([
      '/administrators',
      '/products/:slug',
    ]);
    expect(paths(await feed(`${RANGE}&country=${ADMIN_PAGE_VIEW_NULL_FILTER}`))).toEqual([
      '/categories/:slug',
    ]);
  });

  it('matches path_contains literally — LIKE metacharacters are escaped', async () => {
    expect(paths(await feed(`${RANGE}&path_contains=products`))).toEqual(['/products/:slug']);
    // A bare `%` would match every row if it reached SQL as a wildcard.
    expect((await feed(`${RANGE}&path_contains=${encodeURIComponent('%')}`)).total).toBe(0);
    expect((await feed(`${RANGE}&path_contains=_`)).total).toBe(0);
  });

  it('combines filters conjunctively', async () => {
    expect(paths(await feed(`${RANGE}&country=ID&source=Direct&path_contains=products`))).toEqual([
      '/products/:slug',
    ]);
    // Same filters, wrong country → nothing.
    expect((await feed(`${RANGE}&country=US&source=Direct`)).total).toBe(0);
  });

  it('narrows the window to the requested UTC days', async () => {
    await t.db.insert(pageViews).values({
      path: '/pricing',
      isBot: false,
      createdAt: '2026-08-09T23:59:59.000Z',
    });
    expect(paths(await feed(RANGE))).not.toContain('/pricing');
    expect(paths(await feed('from=2026-08-09&to=2026-08-09'))).toEqual(['/pricing']);
  });
});

describe('GET /api/admin/page-views — pagination', () => {
  beforeEach(async () => {
    // Twelve visits sharing ONE timestamp: without the `id` tiebreak, SQLite is
    // free to order them differently per query and a page boundary would repeat
    // or drop rows.
    await t.db.insert(pageViews).values(
      Array.from({ length: 12 }, (_, i) => ({
        path: `/p${String(i).padStart(2, '0')}`,
        isBot: false,
        createdAt: '2026-08-10T12:00:00.000Z',
      })),
    );
  });

  it('slices with page/perPage and never repeats or skips a row', async () => {
    const first = await feed(`${RANGE}&perPage=5`);
    expect(first.total).toBe(12);
    expect(first.data).toHaveLength(5);

    const second = await feed(`${RANGE}&perPage=5&page=2`);
    const third = await feed(`${RANGE}&perPage=5&page=3`);
    expect(third.data).toHaveLength(2);

    const seen = [...first.data, ...second.data, ...third.data].map((r) => r.id);
    expect(new Set(seen).size).toBe(12);
  });

  it('defaults to perPage=24 and caps it at 100', async () => {
    expect((await feed(RANGE)).perPage).toBe(24);
    expect((await feed(`${RANGE}&perPage=100`)).perPage).toBe(100);
    expect((await call(`${RANGE}&perPage=101`)).status).toBe(400);
    expect((await call(`${RANGE}&page=0`)).status).toBe(400);
  });
});

describe('GET /api/admin/page-views — the internal-ASN filter (§13 D10)', () => {
  const WITH_ASN: Env = { ...TEST_ENV, ANALYTICS_INTERNAL_ASNS: '23700' };
  beforeEach(seed);

  it('computes BOTH counts with the toggle off, so neither figure stands alone', async () => {
    const body = await feed(RANGE, WITH_ASN);
    expect(body.internal_filter).toEqual({ available: true, applied: false, asns: [23700] });
    // Rows are unfiltered…
    expect(body.total).toBe(4);
    expect(body.data).toHaveLength(4);
    // …but the operator can still see what the toggle would do.
    expect(body.window_total).toEqual({ total: 4, excluding_internal: 2 });
    expect(body.window_visitors).toEqual({ total: 3, excluding_internal: 2 });
  });

  it('filters only the rows when the toggle is on; window_total.total is unchanged', async () => {
    const body = await feed(`${RANGE}&exclude_internal=1`, WITH_ASN);
    expect(body.internal_filter.applied).toBe(true);
    expect(body.total).toBe(2);
    // A NULL cf_asn survives the filter (the `IS NULL OR NOT IN` shape) — a bare
    // NOT IN would evaluate NULL and silently delete a real visitor.
    expect(paths(body)).toEqual(['/categories/:slug', '/vendors/:slug']);
    expect(body.window_total).toEqual({ total: 4, excluding_internal: 2 });
    expect(body.total).toBe(body.window_total.excluding_internal);
  });

  it('reports both counts under the column filters too, so they reconcile with total', async () => {
    const body = await feed(`${RANGE}&country=ID`, WITH_ASN);
    expect(body.total).toBe(2);
    expect(body.window_total).toEqual({ total: 2, excluding_internal: 0 });
  });

  it('is unavailable when the var is unset — the shipped default hides the toggle', async () => {
    const body = await feed(`${RANGE}&exclude_internal=1`);
    expect(body.internal_filter).toEqual({ available: false, applied: false, asns: [] });
    expect(body.window_total.excluding_internal).toBeNull();
    expect(body.window_visitors.excluding_internal).toBeNull();
    expect(body.total).toBe(4);
    expect(body.notes.map((n) => n.code)).toContain('internal_filter_unavailable');
  });

  it('notes that both figures are present whenever the var is set', async () => {
    const off = await feed(RANGE, WITH_ASN);
    const on = await feed(`${RANGE}&exclude_internal=1`, WITH_ASN);
    for (const body of [off, on]) {
      expect(body.notes.map((n) => n.code)).toContain('internal_filter_applied');
    }
  });
});

describe('GET /api/admin/page-views — the honesty envelope', () => {
  beforeEach(seed);

  it('carries every caveat the window earns', async () => {
    const codes = (await feed(RANGE)).notes.map((n) => n.code);
    expect(codes).toContain('bot_classification_incomplete');
    expect(codes).toContain('referrer_source_incomplete');
    expect(codes).toContain('direct_is_mixed_bucket');
    expect(codes).toContain('visitor_definition_approximate');
    // The window ends before the current UTC day, so this one must NOT fire.
    expect(codes).not.toContain('partial_day');
  });

  it('flags a window that reaches into the current UTC day', async () => {
    const codes = (await feed('from=2026-08-10&to=2026-08-11')).notes.map((n) => n.code);
    expect(codes).toContain('partial_day');
  });

  it('reports the window as a half-open UTC range', async () => {
    expect((await feed(RANGE)).window).toEqual({
      from: '2026-08-10T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
      timezone: 'UTC',
      days: 1,
    });
  });
});

describe('GET /api/admin/page-views — validation and conventions', () => {
  it('400s a reversed range, an impossible date, and an over-long window', async () => {
    expect((await call('from=2026-08-10&to=2026-08-01')).status).toBe(400);
    expect((await call('from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await call('from=2025-01-01&to=2026-08-10')).status).toBe(400);
    expect((await call('to=2026-08-10')).status).toBe(400);
  });

  it('returns an empty page rather than an error when nothing matches', async () => {
    const body = await feed(RANGE);
    expect(body).toMatchObject({ data: [], total: 0, page: 1 });
    expect(body.window_total.total).toBe(0);
  });

  it('writes no audit_log row and is never edge-cacheable', async () => {
    await seed();
    const res = await call(RANGE);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
