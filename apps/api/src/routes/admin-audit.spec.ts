/**
 * `GET /api/admin/audit` (AECI-653), the global audit-log viewer, on the in-memory
 * D1 harness. A stub middleware sets the `auth` Variable `requireAdmin()` would.
 * The gate itself is covered by `admin-panel.authz-matrix.spec.ts`.
 *
 * Covers each filter alone, a combination, an entity's full history with a
 * same-millisecond tiebreak, the inclusive day range, the 400 refinements, blank
 * params, keyset paging both ways and in both orders (ADR 0046), the count flag,
 * the GoTrue seam's failure path, and that the read writes no `audit_log` row.
 * The last block runs `EXPLAIN QUERY PLAN` on every allowed filter shape, in
 * both orders and with each cursor, and fails on any `SCAN audit_log` outside
 * the unfiltered count.
 */

import {
  AdminAuditLogQuerySchema,
  AdminAuditLogResponseSchema,
  encodeAuditCursor,
  type AdminAuditLogResponse,
} from '@aeci/shared';
import { count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, profiles } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { adminAuditPageQueries, type FetchAuthEmails } from '../lib/admin-audit-page';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { adminAuditLogPaging, adminAuditLogWhere, createAdminAuditLogHandler } from './admin-audit';

const ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '77777777-7777-4777-8777-777777777777';
const VENDOR_1 = '11111111-1111-4111-8111-111111111111';
const VENDOR_2 = '22222222-2222-4222-8222-222222222222';
const PRODUCT_1 = '33333333-3333-4333-8333-333333333333';
const REQUEST_1 = '55555555-5555-4555-8555-555555555555';

const id = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ADMIN_AUTH: AuthzVariables['auth'] = {
  userId: ADMIN_ID,
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

const emailsUp: FetchAuthEmails = async (_env, ids) => ({
  available: true,
  emails: new Map(ids.map((v) => [v, `${v.slice(0, 4)}@aeci.test`])),
  reason: 'ok',
});
const emailsDown: FetchAuthEmails = async () => ({
  available: false,
  emails: new Map(),
  reason: 'error',
});

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values([
    { id: ADMIN_ID, role: 'admin', displayName: 'Ada Admin' },
    { id: USER_ID, role: 'reviewer' },
  ]);
});
afterEach(() => t.dispose());

function auditApp(fetchEmails: FetchAuthEmails = emailsUp) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('/api/admin/*', async (c, next) => {
    c.set('auth', ADMIN_AUTH);
    await next();
  });
  app.get('/api/admin/audit', createAdminAuditLogHandler(t.factory, fetchEmails));
  return app;
}

const getAudit = (qs = '', fetchEmails?: FetchAuthEmails) =>
  auditApp(fetchEmails).request(`/api/admin/audit${qs}`, {}, TEST_ENV, fakeExecutionContext());

async function getBody(qs = '', fetchEmails?: FetchAuthEmails) {
  const res = await getAudit(qs, fetchEmails);
  expect(res.status).toBe(200);
  return AdminAuditLogResponseSchema.parse(await res.json());
}

const auditCount = async () => (await t.db.select({ n: count() }).from(auditLog))[0]?.n ?? 0;

/**
 * Seven rows. Newest first the ids read 6, 5, 4, 3, 2, 1, 7: rows 5 and 6 share a
 * millisecond, so `id DESC` puts 6 first. Rows 2 and 3 sit on the inclusive edges
 * of the 2026-10-02..2026-10-03 range, and rows 1 and 4 sit just outside it.
 */
async function seedLedger() {
  await t.db.insert(auditLog).values([
    {
      id: id(1),
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: VENDOR_1,
      beforeState: { name: 'Old' },
      afterState: { name: 'New' },
      createdAt: '2026-10-01T23:59:59.999Z',
    },
    {
      id: id(2),
      actorId: USER_ID,
      actorType: 'user',
      action: 'product.updated',
      entityType: 'product',
      entityId: PRODUCT_1,
      createdAt: '2026-10-02T00:00:00.000Z',
    },
    {
      id: id(3),
      actorId: null,
      actorType: 'system',
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: VENDOR_1,
      createdAt: '2026-10-03T23:59:59.999Z',
    },
    {
      id: id(4),
      actorId: null,
      actorType: 'workflow',
      action: 'vendor.created',
      entityType: 'vendor',
      entityId: VENDOR_2,
      createdAt: '2026-10-04T00:00:00.000Z',
    },
    {
      id: id(5),
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: VENDOR_1,
      createdAt: '2026-10-05T12:00:00.000Z',
    },
    {
      id: id(6),
      actorId: ADMIN_ID,
      actorType: 'admin',
      action: 'vendor_entitlement.granted',
      entityType: 'vendor',
      entityId: VENDOR_1,
      createdAt: '2026-10-05T12:00:00.000Z',
    },
    {
      id: id(7),
      actorId: null,
      actorType: 'user',
      action: 'vendor_request.created',
      entityType: 'vendor_request',
      entityId: REQUEST_1,
      createdAt: '2026-09-30T08:00:00.000Z',
    },
  ]);
}

const ids = (body: { data: { id: string }[] }) => body.data.map((r) => r.id);

describe('GET /api/admin/audit — the global audit-log viewer (AECI-653)', () => {
  it('returns every row newest first with no filters', async () => {
    await seedLedger();
    const body = await getBody();
    expect(ids(body)).toEqual([id(6), id(5), id(4), id(3), id(2), id(1), id(7)]);
    expect(body.total).toBe(7);
    expect(body.perPage).toBe(25);
    expect(body).toMatchObject({
      has_next: false,
      has_prev: false,
      next_cursor: null,
      prev_cursor: null,
    });
    expect(body.actor_emails_available).toBe(true);
    expect(body.data[0]?.actor).toEqual({
      id: ADMIN_ID,
      display_name: 'Ada Admin',
      email: '4444@aeci.test',
    });
    // A row with no actor id is `null`, never a half-filled actor.
    expect(body.data.find((r) => r.id === id(3))?.actor).toBeNull();
    expect(body.data.find((r) => r.id === id(1))?.before_state).toEqual({ name: 'Old' });
  });

  it('narrows by entity_type alone', async () => {
    await seedLedger();
    const body = await getBody('?entity_type=vendor');
    expect(ids(body)).toEqual([id(6), id(5), id(4), id(3), id(1)]);
    expect(body.total).toBe(5);
  });

  it('returns one entity full history, newest first, same-millisecond rows by id DESC', async () => {
    await seedLedger();
    const body = await getBody(`?entity_type=vendor&entity_id=${VENDOR_1}`);
    expect(ids(body)).toEqual([id(6), id(5), id(3), id(1)]);
    expect(body.data[0]?.created_at).toBe(body.data[1]?.created_at);
    expect(body.total).toBe(4);
  });

  it('narrows by action alone, exact match only', async () => {
    await seedLedger();
    expect(ids(await getBody('?action=vendor.updated'))).toEqual([id(5), id(3), id(1)]);
    // No prefix match: `vendor` is not `vendor.updated`.
    expect((await getBody('?action=vendor')).total).toBe(0);
  });

  it('narrows by actor_id alone', async () => {
    await seedLedger();
    expect(ids(await getBody(`?actor_id=${USER_ID}`))).toEqual([id(2)]);
  });

  it('narrows by a date range alone, inclusive at both ends', async () => {
    await seedLedger();
    const body = await getBody('?from=2026-10-02&to=2026-10-03');
    expect(ids(body)).toEqual([id(3), id(2)]);
    expect(body.total).toBe(2);
  });

  it('accepts from alone and to alone', async () => {
    await seedLedger();
    expect(ids(await getBody('?from=2026-10-05'))).toEqual([id(6), id(5)]);
    expect(ids(await getBody('?to=2026-09-30'))).toEqual([id(7)]);
  });

  it('accepts a single-day range (from = to)', async () => {
    await seedLedger();
    expect(ids(await getBody('?from=2026-10-01&to=2026-10-01'))).toEqual([id(1)]);
  });

  it('allows actor_type next to a date range', async () => {
    await seedLedger();
    const body = await getBody('?actor_type=admin&from=2026-10-01&to=2026-10-05');
    expect(ids(body)).toEqual([id(6), id(5), id(1)]);
  });

  it('allows actor_type next to another filter', async () => {
    await seedLedger();
    expect(ids(await getBody('?entity_type=vendor&actor_type=workflow'))).toEqual([id(4)]);
  });

  it('ANDs a combination of filters', async () => {
    await seedLedger();
    const body = await getBody(
      `?entity_type=vendor&entity_id=${VENDOR_1}&action=vendor.updated&actor_id=${ADMIN_ID}&actor_type=admin&from=2026-10-01&to=2026-10-04`,
    );
    expect(ids(body)).toEqual([id(1)]);
    expect(body.total).toBe(1);
  });

  it('ignores blank params, as a filter form submits them', async () => {
    await seedLedger();
    const body = await getBody(
      '?entity_type=&entity_id=&action=&actor_id=&actor_type=&from=&to=%20',
    );
    expect(body.total).toBe(7);
    // A blank entity_type next to a real entity_id still trips the refinement.
    expect((await getAudit(`?entity_type=&entity_id=${VENDOR_1}`)).status).toBe(400);
  });

  it('still answers 200 with rows when the GoTrue seam fails', async () => {
    await seedLedger();
    const body = await getBody('', emailsDown);
    expect(body.actor_emails_available).toBe(false);
    expect(body.data).toHaveLength(7);
    expect(body.data[0]?.actor).toEqual({ id: ADMIN_ID, display_name: 'Ada Admin', email: null });
  });

  it('writes no audit_log row', async () => {
    await seedLedger();
    const before = await auditCount();
    await getBody();
    await getBody(`?entity_type=vendor&entity_id=${VENDOR_1}`);
    await getAudit('?actor_type=system');
    expect(await auditCount()).toBe(before);
  });

  describe('400 VALIDATION_FAILED', () => {
    async function expect400(qs: string, field: string) {
      const res = await getAudit(qs);
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: { code: string; field?: string; details?: unknown };
      };
      expect(body.error.code).toBe('VALIDATION_FAILED');
      expect(JSON.stringify(body.error)).toContain(field);
    }

    it('refuses entity_id without entity_type', async () => {
      await expect400(`?entity_id=${VENDOR_1}`, 'entity_id');
    });

    it('refuses actor_type as the only constraint', async () => {
      await expect400('?actor_type=system', 'actor_type');
      // Paging params are not constraints.
      await expect400('?actor_type=system&perPage=50&order=asc&count=0', 'actor_type');
      await expect400(`?actor_type=system&after=${encodeURIComponent(CURSOR_5)}`, 'actor_type');
    });

    it('refuses after and before together, on before', async () => {
      await expect400(
        `?after=${encodeURIComponent(CURSOR_5)}&before=${encodeURIComponent(CURSOR_5)}`,
        'before',
      );
    });

    it('refuses a perPage outside 25, 50 and 100', async () => {
      await expect400('?perPage=30', 'perPage');
      await expect400('?perPage=0', 'perPage');
      await expect400('?perPage=200', 'perPage');
    });

    it('refuses a malformed cursor, a bad order and a count other than 0 or 1', async () => {
      await expect400('?after=nonsense', 'after');
      await expect400('?before=2026-10-05T12:00:00.000Z%7Cnot-a-uuid', 'before');
      await expect400('?order=sideways', 'order');
      await expect400('?count=2', 'count');
    });

    it('refuses from after to', async () => {
      await expect400('?from=2026-10-05&to=2026-10-01', 'from');
    });

    it('refuses a malformed or impossible date', async () => {
      await expect400('?from=2026/10/01', 'from');
      await expect400('?to=2026-02-31', 'to');
      await expect400('?from=2026-13-01', 'from');
    });

    it('refuses an unknown actor_type and a non-uuid actor_id', async () => {
      await expect400('?actor_type=robot&from=2026-10-01', 'actor_type');
      await expect400('?actor_id=admin@aeci.test', 'actor_id');
    });
  });
});

/** Row 5 of `seedLedger`, as a cursor. */
const CURSOR_5 = encodeAuditCursor({ createdAt: '2026-10-05T12:00:00.000Z', id: id(5) });

/**
 * Keyset paging (ADR 0046). `seedMany` writes `n` rows, two per millisecond, so
 * every page boundary can fall inside a same-millisecond pair and the `id`
 * tiebreak carries the walk. Even rows are `vendor`, odd rows `product`.
 */
describe('GET /api/admin/audit — keyset paging (ADR 0046)', () => {
  const BASE_MS = Date.parse('2026-10-10T00:00:00.000Z');
  const manyId = (i: number) => id(100 + i);

  async function seedMany(n: number) {
    await t.db.insert(auditLog).values(
      Array.from({ length: n }, (_, i) => ({
        id: manyId(i),
        actorId: null,
        actorType: 'system' as const,
        action: 'vendor.updated',
        entityType: i % 2 === 0 ? 'vendor' : 'product',
        entityId: VENDOR_1,
        createdAt: new Date(BASE_MS + Math.floor(i / 2) * 1000).toISOString(),
      })),
    );
  }

  /** Every seeded id in `(created_at, id)` order, newest first. Ids rise with time. */
  const newestFirst = (n: number) => Array.from({ length: n }, (_, i) => manyId(n - 1 - i));

  const qs = (params: Record<string, string>) => `?${new URLSearchParams(params).toString()}`;

  /** Follow `next_cursor` from the first page until `has_next` is false. */
  async function walkForward(base: Record<string, string> = {}) {
    const pages: AdminAuditLogResponse[] = [await getBody(qs(base))];
    for (let last = pages[0]!; last.has_next; last = pages[pages.length - 1]!) {
      expect(last.next_cursor).not.toBeNull();
      pages.push(await getBody(qs({ ...base, after: last.next_cursor! })));
      expect(pages.length).toBeLessThan(10);
    }
    return pages;
  }

  it('a forward walk by next_cursor visits every row exactly once, in order', async () => {
    await seedMany(60);
    const pages = await walkForward();
    expect(pages.map((p) => p.data.length)).toEqual([25, 25, 10]);
    expect(pages.flatMap(ids)).toEqual(newestFirst(60));
    expect(pages.map((p) => [p.has_prev, p.has_next])).toEqual([
      [false, true],
      [true, true],
      [true, false],
    ]);
    expect(pages[2]!.next_cursor).toBeNull();
    // The first walk counted; every page carries the filtered total.
    for (const page of pages) expect(page.total).toBe(60);
  });

  it('a backward walk by prev_cursor returns the same pages', async () => {
    await seedMany(60);
    const forward = await walkForward();
    const back: AdminAuditLogResponse[] = [forward[forward.length - 1]!];
    for (let at = back[0]!; at.has_prev; at = back[back.length - 1]!) {
      back.push(await getBody(qs({ before: at.prev_cursor! })));
      expect(back.length).toBeLessThan(10);
    }
    expect(back.map(ids).reverse()).toEqual(forward.map(ids));
    // A `before` page always has a next page: the row it was built from.
    expect(back.slice(1).every((p) => p.has_next && p.next_cursor !== null)).toBe(true);
    expect(back[back.length - 1]!.has_prev).toBe(false);
    expect(back[back.length - 1]!.prev_cursor).toBeNull();
  });

  it('a row written between two fetches neither repeats nor skips a row', async () => {
    await seedMany(60);
    const first = await getBody();
    // A live write lands on top of the ledger, as every real write does.
    await t.db.insert(auditLog).values({
      id: id(999),
      actorType: 'system',
      action: 'vendor.updated',
      entityType: 'vendor',
      entityId: VENDOR_1,
      createdAt: '2026-10-11T00:00:00.000Z',
    });
    const second = await getBody(qs({ after: first.next_cursor! }));
    expect(ids(second)).toEqual(newestFirst(60).slice(25, 50));
    expect(second.total).toBe(61);
  });

  it('order=asc reverses the first page and the same-millisecond tiebreak', async () => {
    await seedLedger();
    const body = await getBody('?order=asc');
    // Rows 5 and 6 share a millisecond: ascending puts 5 first.
    expect(ids(body)).toEqual([id(7), id(1), id(2), id(3), id(4), id(5), id(6)]);
  });

  it('order=asc walks forward and back with the same cursor grammar', async () => {
    await seedMany(60);
    const pages = await walkForward({ order: 'asc' });
    expect(pages.flatMap(ids)).toEqual(newestFirst(60).reverse());
    const back = await getBody(qs({ order: 'asc', before: pages[2]!.prev_cursor! }));
    expect(ids(back)).toEqual(ids(pages[1]!));
  });

  it('a cursor walk keeps the filters', async () => {
    await seedMany(60);
    const pages = await walkForward({ entity_type: 'vendor' });
    expect(pages.map((p) => p.data.length)).toEqual([25, 5]);
    expect(pages.flatMap(ids)).toEqual(newestFirst(60).filter((_, i) => i % 2 === 1));
    expect(pages[1]!.total).toBe(30);
  });

  it('perPage=50 and perPage=100 are accepted', async () => {
    await seedMany(60);
    expect((await getBody('?perPage=50')).data).toHaveLength(50);
    const all = await getBody('?perPage=100');
    expect(all.data).toHaveLength(60);
    expect(all.has_next).toBe(false);
  });

  it('count=0 skips the count and returns total: null', async () => {
    await seedMany(30);
    const body = await getBody('?count=0');
    expect(body.total).toBeNull();
    expect(body.data).toHaveLength(25);
    expect(body.has_next).toBe(true);
  });

  it('a cursor past the end returns an empty page with no cursors', async () => {
    await seedLedger();
    const oldest = encodeAuditCursor({ createdAt: '2026-09-30T08:00:00.000Z', id: id(7) });
    const body = await getBody(qs({ after: oldest }));
    expect(body.data).toEqual([]);
    expect(body).toMatchObject({ has_prev: true, has_next: false });
    expect(body.next_cursor).toBeNull();
    expect(body.prev_cursor).toBeNull();
  });
});

/**
 * Index discipline, measured. `EXPLAIN QUERY PLAN` runs on the exact page and
 * count SQL `readAdminAuditPage` sends, for every filter shape the schema allows,
 * in both orders, and with an `after` or `before` cursor (ADR 0046).
 *
 * The rule is stricter than "no bare `SCAN audit_log`". A lone `entity_id` plans
 * as `SCAN audit_log USING COVERING INDEX audit_log_entity_idx`: it names an
 * index and still walks all of it, because `entity_type` leads that index. So
 * every FILTERED shape must plan as `SEARCH` only, a seek into an index range.
 * D1 bills rows read, and a SCAN reads them all.
 *
 * Two things this test accepts on purpose:
 * - `USE TEMP B-TREE FOR ... ORDER BY`. `audit_log.id` is a uuid, not the rowid,
 *   so the `id DESC` tiebreak is in no index. SQLite sorts within the matching
 *   rows. That cost is bounded by the filtered set, not the table.
 * - The UNFILTERED view may `SCAN audit_log USING INDEX audit_log_created_at_idx`.
 *   The page walks that index in `order` and stops at `perPage`. Its `count()`
 *   walks the whole index, which is the cheapest a count of everything can be.
 *   A bare `SCAN audit_log` with no index still fails it. A cursor with no
 *   filter is the same: its page SEARCHes, its count is the unfiltered count.
 *
 * The cursor is a row-value comparison, `(created_at, id) < (?, ?)`. SQLite
 * seeks its leading term as a `created_at` range, so it adds a bound to the
 * index the filters chose and never forces a scan.
 *
 * If a shape fails, fix the query or refuse the shape. Do not weaken this.
 */
describe('GET /api/admin/audit — every allowed filter shape uses an index', () => {
  const FILTERED_SHAPES: Record<string, Record<string, string>> = {
    'date range only': { from: '2026-10-01', to: '2026-10-05' },
    'from only': { from: '2026-10-01' },
    'to only': { to: '2026-10-05' },
    entity_type: { entity_type: 'vendor' },
    'entity_type + entity_id': { entity_type: 'vendor', entity_id: VENDOR_1 },
    action: { action: 'vendor.updated' },
    actor_id: { actor_id: ADMIN_ID },
    'actor_type + date range': { actor_type: 'admin', from: '2026-10-01', to: '2026-10-05' },
    'actor_id + action': { actor_id: ADMIN_ID, action: 'vendor.updated' },
    'entity_type + actor_type': { entity_type: 'vendor', actor_type: 'workflow' },
  };
  const CURSOR = CURSOR_5;
  const CURSOR_SHAPES: Record<string, Record<string, string>> = {
    'after + entity_type + entity_id': {
      after: CURSOR,
      entity_type: 'vendor',
      entity_id: VENDOR_1,
    },
    'after + action': { after: CURSOR, action: 'vendor.updated' },
    'after + date range': { after: CURSOR, from: '2026-10-01', to: '2026-10-05' },
    'after + actor_id': { after: CURSOR, actor_id: ADMIN_ID },
    'before + entity_type': { before: CURSOR, entity_type: 'vendor' },
  };
  /** Every filtered shape in both orders, plus the cursor shapes in both orders. */
  const ALL_FILTERED: Record<string, Record<string, string>> = Object.fromEntries(
    Object.entries({ ...FILTERED_SHAPES, ...CURSOR_SHAPES }).flatMap(([name, params]) => [
      [name, params],
      [`${name}, order=asc`, { ...params, order: 'asc' }],
    ]),
  );

  function plan(sql: { sql: string; params: unknown[] }): string[] {
    const rows = t.raw.prepare(`EXPLAIN QUERY PLAN ${sql.sql}`).all(...sql.params) as {
      detail: string;
    }[];
    return rows.map((r) => r.detail);
  }

  function plans(params: Record<string, string>): { page: string[]; total: string[] } {
    const query = AdminAuditLogQuerySchema.parse(params);
    const queries = adminAuditPageQueries(
      t.db,
      adminAuditLogWhere(query),
      adminAuditLogPaging(query),
    );
    return {
      page: plan(queries.page.toSQL()),
      total: queries.total ? plan(queries.total.toSQL()) : [],
    };
  }

  function planFor(params: Record<string, string>): string[] {
    const { page, total } = plans(params);
    return [...page, ...total];
  }

  const searches = (lines: string[]) =>
    lines.some((l) => /^SEARCH audit_log USING (COVERING )?INDEX /.test(l));

  const scans = (lines: string[]) => lines.filter((l) => /^SCAN audit_log\b/.test(l));
  const bareScans = (lines: string[]) => scans(lines).filter((l) => !/USING/.test(l));

  it.each([
    ['none', {}],
    ['none, order=asc', { order: 'asc' }],
  ] as const)('%s: walks audit_log_created_at_idx, never a bare SCAN', async (_name, params) => {
    await seedLedger();
    const lines = planFor(params);
    expect(bareScans(lines), lines.join('\n')).toEqual([]);
    for (const line of scans(lines)) expect(line).toMatch(/USING .*INDEX audit_log_created_at_idx/);
  });

  for (const [name, params] of Object.entries(ALL_FILTERED)) {
    it(`${name}: SEARCHes an index, never a SCAN`, async () => {
      await seedLedger();
      const lines = planFor(params);
      expect(scans(lines), lines.join('\n')).toEqual([]);
      expect(searches(lines), lines.join('\n')).toBe(true);
    });
  }

  // A cursor with no filter: the page SEARCHes `audit_log_created_at_idx` from
  // the cursor. Its count is the unfiltered count, held to the `none` rule, and
  // a client that already has the total sends `count=0` and skips it.
  it.each([
    ['after alone', { after: CURSOR_5 }],
    ['after alone, order=asc', { after: CURSOR_5, order: 'asc' }],
    ['before alone', { before: CURSOR_5 }],
    ['before alone, order=asc', { before: CURSOR_5, order: 'asc' }],
  ] as const)('%s: the page SEARCHes audit_log_created_at_idx', async (_name, params) => {
    await seedLedger();
    const { page, total } = plans(params);
    expect(scans(page), page.join('\n')).toEqual([]);
    expect(page.some((l) => /^SEARCH audit_log USING INDEX audit_log_created_at_idx/.test(l))).toBe(
      true,
    );
    expect(bareScans(total), total.join('\n')).toEqual([]);
    expect(plans({ ...params, count: '0' }).total).toEqual([]);
  });

  // The control: the two shapes the schema refuses DO plan as a SCAN, which is
  // why they are refused, and it proves the assertion above can fail.
  it.each([
    ['actor_type alone', { actorType: 'system' }],
    ['entity_id alone', { entityId: VENDOR_1 }],
  ] as const)('%s plans as a SCAN, so the schema refuses it', async (_name, filter) => {
    await seedLedger();
    const where =
      'actorType' in filter
        ? eq(auditLog.actorType, filter.actorType)
        : eq(auditLog.entityId, filter.entityId);
    const lines = plan(adminAuditPageQueries(t.db, where, { page: 1, perPage: 25 }).total.toSQL());
    expect(scans(lines), lines.join('\n')).not.toEqual([]);
  });
});
