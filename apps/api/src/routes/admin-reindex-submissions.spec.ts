/**
 * `GET /api/admin/reindex/submissions` (AECI-1188), against the in-memory D1
 * harness.
 *
 * The handler is mounted bare for the query cases. The last describe mounts it
 * behind the REAL `requireAdmin()` guard for the authz cells (anon 401, reviewer
 * 403, vendor seat 403, admin 200). `admin-panel.authz-matrix.spec.ts` lists the
 * route too.
 *
 * Load-bearing assertions:
 *   1. One row per SUBMISSION, never per cause. A pair page two vendors edited
 *      is one row with two causes, and the total counts it once.
 *   2. The vendor filter keeps a submission when ANY cause names the vendor, and
 *      the row still carries every cause.
 *   3. The causes read binds one parameter per submission on the page, and no
 *      more, so a 100-row page stays under D1's bound-parameter limit.
 */

import { ListReindexSubmissionsQuerySchema } from '@aeci/shared';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  products,
  profiles,
  recrawlSubmissionCauses,
  recrawlSubmissions,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  adminReindexSubmissionsWhere,
  createAdminReindexSubmissionsHandler,
} from './admin-reindex';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const REVIEWER = u(901);
const SEAT = u(902);
const AUTODESK = u(1);
const BENTLEY = u(2);
const GONE_VENDOR = u(3);
const BUILD = u(10);
const MICROSTATION = u(11);
const AUDIT_A = u(30);
const AUDIT_B = u(31);
const BASE = 'https://www.aecintegrations.com';
const PAIR_URL = `${BASE}/products/autodesk-build/integrations/microstation`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values([
    { id: AUTODESK, slug: 'autodesk', companyName: 'Autodesk' },
    { id: BENTLEY, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(products).values([
    { id: BUILD, slug: 'autodesk-build', name: 'Autodesk Build' },
    { id: MICROSTATION, slug: 'microstation', name: 'MicroStation' },
  ]);
  await t.db.insert(auditLog).values([
    { id: AUDIT_A, actorType: 'user', action: 'product.updated' },
    { id: AUDIT_B, actorType: 'user', action: 'integration.updated' },
  ]);
});
afterEach(() => t.dispose());

// ─── Seeding ─────────────────────────────────────────────────────────────────

async function submission(
  over: {
    url?: string;
    channel?: 'indexnow' | 'gsc_manual';
    outcome?: 'accepted' | 'refused' | 'failed' | 'requested';
    submittedAt?: string;
  } = {},
): Promise<number> {
  const channel = over.channel ?? 'indexnow';
  const [row] = await t.db
    .insert(recrawlSubmissions)
    .values({
      url: over.url ?? `${BASE}/products/autodesk-build`,
      channel,
      outcome: over.outcome ?? (channel === 'gsc_manual' ? 'requested' : 'accepted'),
      httpStatus: channel === 'gsc_manual' ? null : 200,
      batchId: crypto.randomUUID(),
      priority: 1,
      submittedAt: over.submittedAt ?? '2026-10-04T00:05:00.000Z',
    })
    .returning({ id: recrawlSubmissions.id });
  return row!.id;
}

async function cause(
  submissionId: number,
  over: {
    source?: 'vendor' | 'admin' | 'promote';
    vendorId?: string | null;
    productId?: string | null;
    auditLogId?: string | null;
    promoteJobId?: string | null;
    queuedAt?: string;
  } = {},
) {
  await t.db.insert(recrawlSubmissionCauses).values({
    submissionId,
    source: over.source ?? 'vendor',
    vendorId: over.vendorId === undefined ? AUTODESK : over.vendorId,
    productId: over.productId === undefined ? BUILD : over.productId,
    auditLogId: over.auditLogId === undefined ? AUDIT_A : over.auditLogId,
    promoteJobId: over.promoteJobId ?? null,
    queuedAt: over.queuedAt ?? '2026-10-03T12:00:00.000Z',
  });
}

// ─── App under test ──────────────────────────────────────────────────────────

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
  a.get('/api/admin/reindex/submissions', createAdminReindexSubmissionsHandler(t.factory));
  return a;
}

async function get(qs = '') {
  const res = await app().request(
    `/api/admin/reindex/submissions${qs}`,
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { res, body: (await res.json()) as Record<string, any> };
}

// ─── Query parsing ───────────────────────────────────────────────────────────

describe('ListReindexSubmissionsQuerySchema', () => {
  it('applies the page defaults and leaves every filter unset', () => {
    expect(ListReindexSubmissionsQuerySchema.parse({})).toEqual({ page: 1, perPage: 24 });
  });

  it('accepts all four filters together', () => {
    const q = ListReindexSubmissionsQuerySchema.parse({
      vendorId: AUTODESK,
      channel: 'gsc_manual',
      outcome: 'requested',
      from: '2026-10-01',
      to: '2026-10-04',
      perPage: '100',
    });
    expect(q).toMatchObject({
      vendorId: AUTODESK,
      channel: 'gsc_manual',
      outcome: 'requested',
      from: '2026-10-01',
      to: '2026-10-04',
      perPage: 100,
    });
  });

  it('accepts from equal to to (one day)', () => {
    expect(
      ListReindexSubmissionsQuerySchema.safeParse({ from: '2026-10-04', to: '2026-10-04' }).success,
    ).toBe(true);
  });

  it.each([
    ['from after to', { from: '2026-10-05', to: '2026-10-04' }],
    ['an unknown channel', { channel: 'bing' }],
    ['an unknown outcome', { outcome: 'indexed' }],
    ['a datetime for from', { from: '2026-10-04T00:00:00Z' }],
    ['an empty vendorId', { vendorId: '' }],
    ['a perPage over 100', { perPage: '101' }],
  ])('rejects %s', (_label, input) => {
    expect(ListReindexSubmissionsQuerySchema.safeParse(input).success).toBe(false);
  });
});

describe('adminReindexSubmissionsWhere (the page predicate)', () => {
  const dialect = new SQLiteSyncDialect();

  it('is undefined with no filter', () => {
    expect(adminReindexSubmissionsWhere({}, t.db)).toBeUndefined();
  });

  it('binds every value as a parameter and makes to inclusive', () => {
    const where = adminReindexSubmissionsWhere(
      {
        channel: 'indexnow',
        outcome: 'refused',
        from: '2026-10-01',
        to: '2026-10-04',
        vendorId: AUTODESK,
      },
      t.db,
    )!;
    const q = dialect.sqlToQuery(where);
    expect(q.params).toEqual([
      'indexnow',
      'refused',
      '2026-10-01T00:00:00.000Z',
      '2026-10-05T00:00:00.000Z',
      AUTODESK,
    ]);
    expect(q.sql).toContain('exists');
    expect(q.sql).not.toContain(AUTODESK);
  });
});

// ─── The read ────────────────────────────────────────────────────────────────

describe('GET /api/admin/reindex/submissions', () => {
  it('returns an empty page on an empty log', async () => {
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body).toEqual({ data: [], page: 1, perPage: 24, total: 0 });
  });

  it('groups causes under one row per submission and counts submissions', async () => {
    const pair = await submission({ url: PAIR_URL });
    await cause(pair, { vendorId: AUTODESK, productId: BUILD, auditLogId: AUDIT_A });
    await cause(pair, {
      vendorId: BENTLEY,
      productId: MICROSTATION,
      auditLogId: AUDIT_B,
      queuedAt: '2026-10-03T13:00:00.000Z',
    });

    const { body } = await get();
    expect(body.total).toBe(1);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toEqual({
      id: pair,
      url: PAIR_URL,
      channel: 'indexnow',
      outcome: 'accepted',
      http_status: 200,
      priority: 1,
      submitted_at: '2026-10-04T00:05:00.000Z',
      causes: [
        {
          source: 'vendor',
          audit_log_id: AUDIT_A,
          action: 'product.updated',
          vendor: { id: AUTODESK, slug: 'autodesk', name: 'Autodesk' },
          product: { id: BUILD, slug: 'autodesk-build', name: 'Autodesk Build' },
          promote_job_id: null,
          queued_at: '2026-10-03T12:00:00.000Z',
        },
        {
          source: 'vendor',
          audit_log_id: AUDIT_B,
          action: 'integration.updated',
          vendor: { id: BENTLEY, slug: 'bentley', name: 'Bentley' },
          product: { id: MICROSTATION, slug: 'microstation', name: 'MicroStation' },
          promote_job_id: null,
          queued_at: '2026-10-03T13:00:00.000Z',
        },
      ],
    });
  });

  it('renders a promote cause, a deleted vendor and a cause-less submission', async () => {
    const promoted = await submission({ submittedAt: '2026-10-04T00:05:00.000Z' });
    await cause(promoted, {
      source: 'promote',
      vendorId: null,
      productId: null,
      auditLogId: null,
      promoteJobId: 'job-123',
    });
    const orphan = await submission({ submittedAt: '2026-10-03T00:05:00.000Z' });
    await cause(orphan, { vendorId: GONE_VENDOR, productId: u(99), auditLogId: u(98) });
    const bare = await submission({ submittedAt: '2026-10-02T00:05:00.000Z' });

    const { body } = await get();
    expect(body.data.map((r: { id: number }) => r.id)).toEqual([promoted, orphan, bare]);
    expect(body.data[0].causes).toEqual([
      expect.objectContaining({
        source: 'promote',
        audit_log_id: null,
        action: null,
        vendor: null,
        product: null,
        promote_job_id: 'job-123',
      }),
    ]);
    expect(body.data[1].causes[0]).toMatchObject({
      action: null,
      vendor: { id: GONE_VENDOR, slug: null, name: null },
      product: { id: u(99), slug: null, name: null },
    });
    expect(body.data[2].causes).toEqual([]);
  });

  it('orders submitted_at DESC then id DESC, and pages stably', async () => {
    const a = await submission({ submittedAt: '2026-10-04T00:05:00.000Z' });
    const b = await submission({ submittedAt: '2026-10-04T00:05:00.000Z' });
    const c = await submission({ submittedAt: '2026-10-05T00:05:00.000Z' });

    const p1 = await get('?perPage=2');
    expect(p1.body.data.map((r: { id: number }) => r.id)).toEqual([c, b]);
    expect(p1.body.total).toBe(3);
    const p2 = await get('?perPage=2&page=2');
    expect(p2.body.data.map((r: { id: number }) => r.id)).toEqual([a]);
  });

  it('filters by vendor: any cause matches, and the row keeps every cause', async () => {
    const pair = await submission({ url: PAIR_URL, submittedAt: '2026-10-04T00:05:00.000Z' });
    await cause(pair, { vendorId: AUTODESK });
    await cause(pair, { vendorId: BENTLEY, productId: MICROSTATION });
    const twice = await submission({ submittedAt: '2026-10-03T00:05:00.000Z' });
    await cause(twice, { vendorId: BENTLEY });
    await cause(twice, { vendorId: BENTLEY });
    const other = await submission({ submittedAt: '2026-10-02T00:05:00.000Z' });
    await cause(other, { vendorId: AUTODESK });

    const { body } = await get(`?vendorId=${BENTLEY}`);
    expect(body.total).toBe(2);
    expect(body.data.map((r: { id: number }) => r.id)).toEqual([pair, twice]);
    expect(body.data[0].causes).toHaveLength(2);
    expect(body.data[1].causes).toHaveLength(2);
  });

  it('filters by channel', async () => {
    await submission({ channel: 'indexnow' });
    const manual = await submission({ channel: 'gsc_manual' });
    const { body } = await get('?channel=gsc_manual');
    expect(body.total).toBe(1);
    expect(body.data[0]).toMatchObject({ id: manual, channel: 'gsc_manual', http_status: null });
  });

  it('filters by outcome', async () => {
    await submission({ outcome: 'accepted' });
    const refused = await submission({ outcome: 'refused' });
    const { body } = await get('?outcome=refused');
    expect(body.total).toBe(1);
    expect(body.data[0].id).toBe(refused);
  });

  it('filters by an inclusive UTC date range', async () => {
    await submission({ submittedAt: '2026-09-30T23:59:59.999Z' });
    const first = await submission({ submittedAt: '2026-10-01T00:00:00.000Z' });
    const last = await submission({ submittedAt: '2026-10-02T23:59:59.999Z' });
    await submission({ submittedAt: '2026-10-03T00:00:00.000Z' });

    const { body } = await get('?from=2026-10-01&to=2026-10-02');
    expect(body.data.map((r: { id: number }) => r.id)).toEqual([last, first]);
    expect(body.total).toBe(2);

    expect((await get('?from=2026-10-03')).body.total).toBe(1);
    expect((await get('?to=2026-09-30')).body.total).toBe(1);
  });

  it('400s from after to', async () => {
    const { res, body } = await get('?from=2026-10-05&to=2026-10-04');
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('binds one parameter per page row in the causes read, and no more', async () => {
    for (let i = 0; i < 5; i++) {
      await cause(await submission({ submittedAt: `2026-10-0${i + 1}T00:05:00.000Z` }));
    }
    // Record the SQL the handler prepares. The causes read has no parameter of its
    // own besides the id list, so its placeholder count IS its bound-param count.
    const prepare = vi.spyOn(t.raw, 'prepare');
    const { body } = await get('?perPage=3');
    expect(body.data).toHaveLength(3);
    const causeRead = prepare.mock.calls
      .map(([query]) => String(query))
      .find((q) => q.includes('from "recrawl_submission_causes"') && q.includes(' in ('));
    expect(causeRead).toBeDefined();
    expect(causeRead!.match(/\?/g)).toHaveLength(3);
    prepare.mockRestore();
  });

  it('skips the causes read on an empty page', async () => {
    await submission();
    const { body } = await get('?page=2');
    expect(body.data).toEqual([]);
    expect(body.total).toBe(1);
  });

  it('writes no audit row', async () => {
    await submission();
    const before = (await t.db.select().from(auditLog)).length;
    await get();
    expect((await t.db.select().from(auditLog)).length).toBe(before);
  });
});

// ─── Authorization (the real guard) ──────────────────────────────────────────

describe('/api/admin/reindex/submissions — authorization', () => {
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
      '/api/admin/reindex/submissions',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createAdminReindexSubmissionsHandler(t.factory),
    );
    return a;
  }

  const call = (token?: string) =>
    guarded().request(
      '/api/admin/reindex/submissions',
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );
  const tokenFor = (sub: string) => jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL });

  it('401s an anonymous caller', async () => {
    expect((await call()).status).toBe(401);
  });

  it('403s a signed-in reviewer', async () => {
    await t.db.insert(profiles).values({ id: REVIEWER, role: 'reviewer' });
    expect((await call(await tokenFor(REVIEWER))).status).toBe(403);
  });

  it('403s a vendor seat, even one whose vendor has submissions', async () => {
    await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: AUTODESK });
    const id = await submission();
    await cause(id);
    expect((await call(await tokenFor(SEAT))).status).toBe(403);
  });

  it('lets an admin through', async () => {
    expect((await call(await tokenFor(ADMIN))).status).toBe(200);
  });
});
