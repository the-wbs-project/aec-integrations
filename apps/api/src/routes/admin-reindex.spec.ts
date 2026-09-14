/**
 * `GET /api/admin/reindex` + `DELETE /api/admin/reindex/:id` (AECI-946), against
 * the in-memory D1 harness.
 *
 * Four INVARIANT tests here. None should be deleted without reopening the
 * decision behind it:
 *
 *   1. **The audit row rides the SAME batch as the delete.** This is an
 *      operator-initiated delete on an admin screen, so §26.1's *scheduled*-
 *      deletion exception does not reach it — it audits per row, attributed to
 *      the admin rather than to `'system'`.
 *   2. **Ordering is priority, then age, then id.** The screen's entire value is
 *      that working top-down spends a capped quota well, so a regression in the
 *      `ORDER BY` is a silent regression in what gets indexed. The `id` third
 *      term is the AECI-825 rule: two rows from one promote share a `queued_at`
 *      to the millisecond, and a paginated list without a unique trailing term
 *      can drop or duplicate a row across pages.
 *   3. **Done takes no concurrency guard, and that is safe.** An already-cleared
 *      row 404s, because `id` is `AUTOINCREMENT` and never reused. A row that was
 *      merely re-prioritised is the same URL, so clearing it is correct.
 *   4. **`readAdminQueueCounts` sees this table.** The nav badge is the only
 *      signal that the worklist is falling behind. A count that silently reads
 *      zero is worse than no badge at all.
 *
 * Authorization runs against the REAL `requireAdmin()` guard in the last
 * describe.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, gscRecrawlQueue, profiles } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { readAdminQueueCounts } from '../lib/admin-queue-counts';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createAdminReindexListHandler,
  createClearReindexRowHandler,
  REINDEX_CLEARED_ACTION,
} from './admin-reindex';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const USER = u(901);

const BASE = 'https://www.aecintegrations.com';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

// ─── Seeding ─────────────────────────────────────────────────────────────────

interface SeedRow {
  url: string;
  priority: number;
  reason: string;
  source?: string;
  queuedAt: string;
}

const seed = (rows: readonly SeedRow[]) =>
  t.db
    .insert(gscRecrawlQueue)
    .values(rows.map((r) => ({ source: 'promote', ...r })))
    .returning({ id: gscRecrawlQueue.id });

const readQueue = () => t.db.select().from(gscRecrawlQueue);

const auditRows = () => t.db.select().from(auditLog);

// ─── App under test (handlers mounted bare; authz has its own describe) ──────

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId: ADMIN,
      email: undefined,
      role: 'admin',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  a.get('/api/admin/reindex', createAdminReindexListHandler(t.factory));
  a.delete('/api/admin/reindex/:id', createClearReindexRowHandler(t.factory));
  return a;
}

const get = (query = '') =>
  app().request(`/api/admin/reindex${query}`, {}, TEST_ENV, fakeExecutionContext());

const del = (id: string | number) =>
  app().request(`/api/admin/reindex/${id}`, { method: 'DELETE' }, TEST_ENV, fakeExecutionContext());

// ─── The worklist read ───────────────────────────────────────────────────────

describe('GET /api/admin/reindex — the worklist', () => {
  it('orders by priority, then oldest first', async () => {
    await seed([
      {
        url: `${BASE}/products/b`,
        priority: 4,
        reason: 'pair.updated',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        url: `${BASE}/products/c`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-03T00:00:00.000Z',
      },
      {
        url: `${BASE}/products/a`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-02T00:00:00.000Z',
      },
      {
        url: `${BASE}/vendors/v`,
        priority: 2,
        reason: 'vendor.created',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { url: string }[]; total: number };

    // Tier 1 first and oldest-first inside it, THEN tier 2, THEN tier 4.
    expect(body.data.map((r) => r.url)).toEqual([
      `${BASE}/products/a`,
      `${BASE}/products/c`,
      `${BASE}/vendors/v`,
      `${BASE}/products/b`,
    ]);
    expect(body.total).toBe(4);
  });

  it('breaks a same-priority same-timestamp tie on id, so pagination is total', async () => {
    // Two rows from one promote share `queued_at` to the millisecond. Without
    // the `id` term the ORDER BY is not a total order and a paginated read can
    // drop or duplicate a row across the page boundary (AECI-825).
    const ts = '2026-09-05T12:00:00.000Z';
    await seed([
      { url: `${BASE}/products/x`, priority: 2, reason: 'product.updated', queuedAt: ts },
      { url: `${BASE}/products/y`, priority: 2, reason: 'product.updated', queuedAt: ts },
      { url: `${BASE}/products/z`, priority: 2, reason: 'product.updated', queuedAt: ts },
    ]);

    const first = (await (await get('?page=1&perPage=2')).json()) as { data: { url: string }[] };
    const second = (await (await get('?page=2&perPage=2')).json()) as { data: { url: string }[] };

    const seen = [...first.data, ...second.data].map((r) => r.url);
    expect(seen).toHaveLength(3);
    expect(new Set(seen).size).toBe(3);
  });

  it('filters to one tier when asked, and the total follows the filter', async () => {
    await seed([
      {
        url: `${BASE}/products/a`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        url: `${BASE}/products/b`,
        priority: 4,
        reason: 'product.minor',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    const body = (await (await get('?priority=1')).json()) as {
      data: { url: string }[];
      total: number;
    };
    expect(body.data.map((r) => r.url)).toEqual([`${BASE}/products/a`]);
    expect(body.total).toBe(1);
  });

  it('returns an empty page rather than an error when nothing is queued', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; total: number };
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('writes no audit row — a read is not a state change', async () => {
    await seed([
      {
        url: `${BASE}/products/a`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    await get();
    expect(await auditRows()).toHaveLength(0);
  });
});

// ─── The Done button ─────────────────────────────────────────────────────────

describe('DELETE /api/admin/reindex/:id — the Done button', () => {
  it('deletes the row and writes the audit entry in the same batch', async () => {
    const [row] = await seed([
      {
        url: `${BASE}/products/procore`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);

    const res = await del(row!.id);
    expect(res.status).toBe(204);
    expect(await readQueue()).toHaveLength(0);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe(REINDEX_CLEARED_ACTION);
    expect(audits[0]!.entityType).toBe('gsc_recrawl_queue');
    expect(audits[0]!.entityId).toBe(String(row!.id));
    // Attributed to the ADMIN, not to 'system' — this is not the drain's
    // scheduled-deletion case.
    expect(audits[0]!.actorType).toBe('admin');
    expect(audits[0]!.actorId).toBe(ADMIN);
    // The URL is the only surviving record of what was cleared, so it has to be
    // in `before_state`.
    expect((audits[0]!.beforeState as { url: string }).url).toBe(`${BASE}/products/procore`);
  });

  it('leaves no orphan audit row when the row is already gone', async () => {
    const [row] = await seed([
      {
        url: `${BASE}/products/a`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    await t.db.delete(gscRecrawlQueue).where(eq(gscRecrawlQueue.id, row!.id));

    const res = await del(row!.id);
    expect(res.status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });

  it('rejects a non-numeric id without touching the table', async () => {
    await seed([
      {
        url: `${BASE}/products/a`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    const res = await del('not-a-number');
    expect(res.status).toBe(400);
    expect(await readQueue()).toHaveLength(1);
  });

  it('clears a row that was re-prioritised since the read, because it is the same URL', async () => {
    // The `DO UPDATE` path keeps the id and raises the priority. Clearing it is
    // CORRECT rather than a lost update: the operator pasted this URL into
    // Search Console, and Google fetches the page as it is now — which satisfies
    // the minor edit that queued it AND the material edit that promoted it.
    // Leaving the row would demand a second identical submission against a
    // capped quota.
    const [row] = await seed([
      {
        url: `${BASE}/products/a`,
        priority: 4,
        reason: 'product.minor',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    await t.db
      .update(gscRecrawlQueue)
      .set({ priority: 2, reason: 'product.updated' })
      .where(eq(gscRecrawlQueue.id, row!.id));

    expect((await del(row!.id)).status).toBe(204);
    expect(await readQueue()).toHaveLength(0);
  });

  it('clears only the addressed row', async () => {
    const rows = await seed([
      {
        url: `${BASE}/products/a`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        url: `${BASE}/products/b`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    await del(rows[0]!.id);
    const left = await readQueue();
    expect(left).toHaveLength(1);
    expect(left[0]!.url).toBe(`${BASE}/products/b`);
  });
});

// ─── The nav badge ───────────────────────────────────────────────────────────

describe('readAdminQueueCounts — the fourth queue', () => {
  it('counts every queued row, with no predicate', async () => {
    await seed([
      {
        url: `${BASE}/products/a`,
        priority: 1,
        reason: 'product.created',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
      {
        url: `${BASE}/products/b`,
        priority: 4,
        reason: 'product.minor',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    const counts = await readAdminQueueCounts(t.db);
    // Every row here is pending by construction — Done deletes rather than
    // flagging, precisely so this count needs no predicate to keep in step with.
    expect(counts.pending_reindex).toBe(2);
  });

  it('is zero on an empty queue rather than undefined', async () => {
    const counts = await readAdminQueueCounts(t.db);
    expect(counts.pending_reindex).toBe(0);
  });
});

// ─── Authorization, against the real guard ───────────────────────────────────

describe('/api/admin/reindex — authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'preview', SUPABASE_URL } as Env;

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guarded() {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.get(
      '/api/admin/reindex',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createAdminReindexListHandler(t.factory),
    );
    a.delete(
      '/api/admin/reindex/:id',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createClearReindexRowHandler(t.factory),
    );
    return a;
  }

  const call = (path: string, method: string, token?: string) =>
    guarded().request(
      path,
      { method, headers: token ? { authorization: `Bearer ${token}` } : {} },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  it('401s an anonymous caller on both verbs', async () => {
    expect((await call('/api/admin/reindex', 'GET')).status).toBe(401);
    expect((await call('/api/admin/reindex/1', 'DELETE')).status).toBe(401);
  });

  it('403s a signed-in non-admin on both verbs', async () => {
    await t.db.insert(profiles).values({ id: USER, role: 'reviewer' });
    const token = await jwks.mintToken({ sub: USER, supabaseUrl: SUPABASE_URL });
    expect((await call('/api/admin/reindex', 'GET', token)).status).toBe(403);
    expect((await call('/api/admin/reindex/1', 'DELETE', token)).status).toBe(403);
  });

  it('lets an admin through', async () => {
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    expect((await call('/api/admin/reindex', 'GET', token)).status).toBe(200);
  });
});
