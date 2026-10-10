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
 *   2. **Ordering is priority, inspection bucket, never crawled first, age, then
 *      id.** The screen's entire value is that working top-down spends a capped
 *      quota well, so a regression in the `ORDER BY` is a silent regression in
 *      what gets indexed. The trailing `id` term is the AECI-825 rule: two rows
 *      from one promote share a `queued_at` to the millisecond, and a paginated
 *      list without a unique trailing term can drop or duplicate a row across
 *      pages.
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

import {
  auditLog,
  gscRecrawlQueue,
  profiles,
  recrawlQueueCauses,
  recrawlSubmissionCauses,
  recrawlSubmissions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { readAdminQueueCounts } from '../lib/admin-queue-counts';
import { enqueueRecrawlCauses } from '../lib/recrawl-causes';
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
  inspectReason?: string | null;
  inspectedAt?: string | null;
  lastCrawlAt?: string | null;
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

/** `outcome` defaults to `not_requested`, the clear that writes no log row.
 *  Pass `null` to omit the parameter. */
const del = (id: string | number, outcome: string | null = 'not_requested') =>
  app().request(
    `/api/admin/reindex/${id}${outcome === null ? '' : `?outcome=${outcome}`}`,
    { method: 'DELETE' },
    TEST_ENV,
    fakeExecutionContext(),
  );

const submissions = () => t.db.select().from(recrawlSubmissions);
const submissionCauses = () => t.db.select().from(recrawlSubmissionCauses);

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

  it('puts rows Google says need a request first inside a tier, fetch failures last (AECI-1236)', async () => {
    const queuedAt = '2026-09-01T00:00:00.000Z';
    await seed([
      { url: `${BASE}/vendors/never`, priority: 3, reason: 'vendor.updated', queuedAt },
      {
        url: `${BASE}/vendors/gone`,
        priority: 3,
        reason: 'vendor.updated',
        queuedAt,
        inspectReason: 'page_fetch_failed',
        inspectedAt: '2026-10-05T12:00:00.000Z',
      },
      {
        url: `${BASE}/vendors/stale`,
        priority: 3,
        reason: 'vendor.updated',
        queuedAt: '2026-09-02T00:00:00.000Z',
        inspectReason: 'crawl_predates_change',
        inspectedAt: '2026-10-05T12:00:00.000Z',
        lastCrawlAt: '2026-08-30T00:00:00Z',
      },
      { url: `${BASE}/products/t1`, priority: 1, reason: 'product.created', queuedAt },
    ]);

    const body = (await (await get()).json()) as {
      data: { url: string; inspect_reason: string | null; last_crawl_at: string | null }[];
    };
    // The tier still leads: tier 1 is first even though it was never inspected.
    expect(body.data.map((r) => r.url)).toEqual([
      `${BASE}/products/t1`,
      `${BASE}/vendors/stale`,
      `${BASE}/vendors/never`,
      `${BASE}/vendors/gone`,
    ]);
    expect(body.data[1]).toMatchObject({
      inspect_reason: 'crawl_predates_change',
      last_crawl_at: '2026-08-30T00:00:00Z',
    });
  });

  it('puts never-crawled pages first inside a bucket, ahead of older stale crawls', async () => {
    const inspectedAt = '2026-10-05T12:00:00.000Z';
    await seed([
      {
        url: `${BASE}/vendors/stale`,
        priority: 3,
        reason: 'vendor.updated',
        queuedAt: '2026-09-01T00:00:00.000Z',
        inspectReason: 'crawl_predates_change',
        inspectedAt,
        lastCrawlAt: '2026-08-30T00:00:00Z',
      },
      {
        url: `${BASE}/vendors/discovered`,
        priority: 3,
        reason: 'vendor.updated',
        queuedAt: '2026-09-03T00:00:00.000Z',
        inspectReason: 'discovered_not_indexed',
        inspectedAt,
      },
      {
        url: `${BASE}/vendors/unchecked`,
        priority: 3,
        reason: 'vendor.updated',
        queuedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        url: `${BASE}/vendors/unknown`,
        priority: 3,
        reason: 'vendor.updated',
        queuedAt: '2026-09-02T00:00:00.000Z',
        inspectReason: 'unknown_to_google',
        inspectedAt,
      },
    ]);

    const body = (await (await get()).json()) as { data: { url: string }[] };
    // Never crawled first (oldest first among them), then the stale crawl, even though
    // it is the oldest. The uninspected row stays in its own later bucket.
    expect(body.data.map((r) => r.url)).toEqual([
      `${BASE}/vendors/unknown`,
      `${BASE}/vendors/discovered`,
      `${BASE}/vendors/stale`,
      `${BASE}/vendors/unchecked`,
    ]);
  });

  it('keeps the not-yet-inspected bucket in queued_at order, crawl time or not', async () => {
    // A re-enqueue clears inspect_reason but keeps last_crawl_at, so this bucket
    // mixes new rows with pages Google already crawled. Age alone orders it.
    await seed([
      {
        url: `${BASE}/vendors/re-changed`,
        priority: 3,
        reason: 'vendor.updated',
        queuedAt: '2026-09-01T00:00:00.000Z',
        lastCrawlAt: '2026-08-30T00:00:00Z',
      },
      {
        url: `${BASE}/vendors/new`,
        priority: 3,
        reason: 'vendor.updated',
        queuedAt: '2026-09-02T00:00:00.000Z',
      },
    ]);

    const body = (await (await get()).json()) as { data: { url: string }[] };
    expect(body.data.map((r) => r.url)).toEqual([
      `${BASE}/vendors/re-changed`,
      `${BASE}/vendors/new`,
    ]);
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

  it('sweeps the cleared URLs gsc causes and keeps every other cause (AECI-1184)', async () => {
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
    const cause = {
      source: 'vendor' as const,
      auditLogId: 'audit-1',
      vendorId: 'vendor-1',
      productId: null,
      promoteJobId: null,
    };
    await enqueueRecrawlCauses(t.db, 'gsc', [`${BASE}/products/a`, `${BASE}/products/b`], cause);
    // The same URL on the IndexNow channel belongs to the drain, not to this clear.
    await enqueueRecrawlCauses(t.db, 'indexnow', [`${BASE}/products/a`], cause);

    expect((await del(rows[0]!.id)).status).toBe(204);

    const left = await t.db.select().from(recrawlQueueCauses).orderBy(recrawlQueueCauses.id);
    expect(left.map((c) => [c.channel, c.url])).toEqual([
      ['gsc', `${BASE}/products/b`],
      ['indexnow', `${BASE}/products/a`],
    ]);
  });
});

// ─── The Done outcome (AECI-1185) ────────────────────────────────────────────

describe('DELETE /api/admin/reindex/:id — the outcome', () => {
  const procore = `${BASE}/products/procore`;
  const cause = {
    source: 'vendor' as const,
    auditLogId: 'audit-1',
    vendorId: 'vendor-1',
    productId: 'product-1',
    promoteJobId: null,
  };

  const seedOne = async () => {
    const [row] = await seed([
      {
        url: procore,
        priority: 2,
        reason: 'product.updated',
        queuedAt: '2026-09-01T00:00:00.000Z',
      },
    ]);
    await enqueueRecrawlCauses(t.db, 'gsc', [procore], cause);
    return row!;
  };

  it('400s a missing outcome and touches nothing', async () => {
    const row = await seedOne();
    const res = await del(row.id, null);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
    expect(await readQueue()).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
    expect(await submissions()).toHaveLength(0);
  });

  it('400s an unknown outcome and touches nothing', async () => {
    const row = await seedOne();
    // "indexed" is exactly the claim this surface must never make.
    const res = await del(row.id, 'indexed');
    expect(res.status).toBe(400);
    expect(await readQueue()).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });

  it('requested: logs one gsc_manual row with its causes, in the clear batch', async () => {
    const row = await seedOne();

    const res = await del(row.id, 'requested');
    expect(res.status).toBe(204);
    expect(await readQueue()).toHaveLength(0);

    const subs = await submissions();
    expect(subs).toHaveLength(1);
    const sub = subs[0]!;
    expect(sub.url).toBe(procore);
    expect(sub.channel).toBe('gsc_manual');
    expect(sub.outcome).toBe('requested');
    expect(sub.httpStatus).toBeNull();
    expect(sub.priority).toBe(2);
    expect(sub.batchId).toMatch(/^[0-9a-f-]{36}$/);

    const causes = await submissionCauses();
    expect(causes).toHaveLength(1);
    expect(causes[0]).toMatchObject({
      submissionId: sub.id,
      source: 'vendor',
      auditLogId: 'audit-1',
      vendorId: 'vendor-1',
      productId: 'product-1',
    });
    // The transient cause went with the queue row.
    expect(await t.db.select().from(recrawlQueueCauses)).toHaveLength(0);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe(REINDEX_CLEARED_ACTION);
    expect(audits[0]!.metadata).toMatchObject({
      source: 'admin-panel',
      outcome: 'requested',
      batchId: sub.batchId,
    });
  });

  it('requested: does not copy the same URLs IndexNow causes', async () => {
    const row = await seedOne();
    await enqueueRecrawlCauses(t.db, 'indexnow', [procore], { ...cause, auditLogId: 'audit-2' });

    expect((await del(row.id, 'requested')).status).toBe(204);

    const causes = await submissionCauses();
    expect(causes.map((c) => c.auditLogId)).toEqual(['audit-1']);
    const left = await t.db.select().from(recrawlQueueCauses);
    expect(left.map((c) => c.channel)).toEqual(['indexnow']);
  });

  it('not_requested: writes no submission row, drops the causes, audits the outcome', async () => {
    const row = await seedOne();

    const res = await del(row.id, 'not_requested');
    expect(res.status).toBe(204);
    expect(await readQueue()).toHaveLength(0);
    expect(await submissions()).toHaveLength(0);
    expect(await submissionCauses()).toHaveLength(0);
    expect(await t.db.select().from(recrawlQueueCauses)).toHaveLength(0);

    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ source: 'admin-panel', outcome: 'not_requested' });
  });

  it('404s an already-cleared row with either outcome and logs nothing', async () => {
    const row = await seedOne();
    await t.db.delete(gscRecrawlQueue).where(eq(gscRecrawlQueue.id, row.id));

    expect((await del(row.id, 'requested')).status).toBe(404);
    expect((await del(row.id, 'not_requested')).status).toBe(404);
    expect(await submissions()).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
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
  const AUTHZ_ENV = { ENV: 'staging', SUPABASE_URL } as Env;

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
    expect((await call('/api/admin/reindex/1?outcome=requested', 'DELETE')).status).toBe(401);
  });

  it('403s a signed-in non-admin on both verbs', async () => {
    await t.db.insert(profiles).values({ id: USER, role: 'reviewer' });
    const token = await jwks.mintToken({ sub: USER, supabaseUrl: SUPABASE_URL });
    expect((await call('/api/admin/reindex', 'GET', token)).status).toBe(403);
    expect((await call('/api/admin/reindex/1?outcome=requested', 'DELETE', token)).status).toBe(
      403,
    );
  });

  it('lets an admin through', async () => {
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    expect((await call('/api/admin/reindex', 'GET', token)).status).toBe(200);
  });
});
