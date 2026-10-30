/**
 * `GET /api/vendor/threads/:threadId` (AECI-1548, `STAGE_2_ATTESTATIONS_SPEC.md`
 * §15.3, §15.10): one thread read by its id, read-only, for the close notice's link.
 *
 * Same harness as `vendor-threads.spec.ts`: the real migrations on in-memory SQLite,
 * the session stubbed with `c.set('auth', …)`. The registration (guard, no limiter)
 * is in `vendor-threads.registration.spec.ts`.
 *
 * The load-bearing cases:
 *   - either stamped company reads it, a stranger and a missing id get one 404;
 *   - a detached thread (`claim_id` null) is still read, named from its snapshot;
 *   - the read writes the caller's read marker;
 *   - a deleted message's body never reaches the vendor;
 *   - `can_write` is true only where the claim write routes would accept (AECI-1551);
 *   - `GET /api/vendor/threads` lists the company's threads, newest activity first,
 *     paged and filtered, and writes no marker (AECI-1551).
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GetVendorThreadByIdResponseSchema, ListVendorThreadsResponseSchema } from '@aeci/shared';

import {
  claimThreadMessages,
  claimThreadReads,
  claimThreads,
  claims,
  integrations,
  productVendors,
  products,
  profiles,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createGetVendorThreadByIdHandler,
  createListVendorThreadsHandler,
} from './vendor-thread-by-id';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_OUT = uuid(3);
const P_A = uuid(10);
const P_B = uuid(11);
const I_MAIN = uuid(20);
const DO_RFIS = uuid(30);
const DO_ISSUES = uuid(31);
const C_MAIN = uuid(40);
const C_OPEN = uuid(41);
const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const SEAT_OUT = uuid(102);
const T_LIVE = uuid(200);
const T_DETACHED = uuid(201);
const T_OPEN = uuid(202);
const T_MISSING = uuid(299);
const TS = '2026-10-30T09:00:00.000Z';

const seat = (userId: string, vendorId: string): AuthzVariables['auth'] => ({
  userId,
  email: `${userId}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
  licensedProductIds: [],
});
const AUTH_A = seat(SEAT_A, VENDOR_A);
const AUTH_B = seat(SEAT_B, VENDOR_B);
const AUTH_OUT = seat(SEAT_OUT, VENDOR_OUT);

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_OUT, slug: 'trimble', companyName: 'Trimble' },
  ]);
  await t.db.insert(products).values([
    { id: P_A, slug: 'revit', name: 'Revit' },
    { id: P_B, slug: 'microstation', name: 'MicroStation' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_B, vendorId: VENDOR_B, isPrimary: true },
  ]);
  await t.db
    .insert(integrations)
    .values({ id: I_MAIN, sourceProductId: P_A, targetProductId: P_B, mechanismKind: 'native' });
  await t.db.insert(taxonomyDataObjects).values([
    { id: DO_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 1 },
    { id: DO_ISSUES, slug: 'issues', name: 'Issues', displayOrder: 2 },
  ]);
  await t.db.insert(claims).values([
    { id: C_MAIN, integrationId: I_MAIN, dataObjectId: DO_RFIS, direction: 'a_to_b' },
    { id: C_OPEN, integrationId: I_MAIN, dataObjectId: DO_ISSUES, direction: 'a_to_b' },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_OUT, role: 'vendor_admin', vendorId: VENDOR_OUT },
  ]);
  // A thread on a live claim, closed `retired`, one whose claim was deleted, and an
  // open one on a live attestable row (AECI-1551).
  await t.db.insert(claimThreads).values([
    {
      id: T_OPEN,
      claimId: C_OPEN,
      vendorAId: VENDOR_A,
      vendorBId: VENDOR_B,
      createdAt: TS,
    },
    {
      id: T_LIVE,
      claimId: C_MAIN,
      vendorAId: VENDOR_A,
      vendorBId: VENDOR_B,
      closedAt: TS,
      closedReason: 'retired',
      createdAt: TS,
    },
    {
      id: T_DETACHED,
      claimId: null,
      vendorAId: VENDOR_A,
      vendorBId: VENDOR_B,
      anchorSnapshot: { anchorId: I_MAIN, dataObjectId: DO_ISSUES },
      closedAt: TS,
      closedReason: 'claim_removed',
      createdAt: TS,
    },
  ]);
  await t.db.insert(claimThreadMessages).values([
    {
      id: uuid(300),
      threadId: T_DETACHED,
      authorProfileId: SEAT_A,
      authorVendorId: VENDOR_A,
      body: 'first message',
      createdAt: TS,
    },
    {
      id: uuid(301),
      threadId: T_DETACHED,
      authorProfileId: SEAT_B,
      authorVendorId: VENDOR_B,
      body: 'withdrawn words',
      createdAt: '2026-10-30T09:01:00.000Z',
      deletedAt: '2026-10-30T09:02:00.000Z',
    },
    {
      id: uuid(302),
      threadId: T_OPEN,
      authorProfileId: SEAT_B,
      authorVendorId: VENDOR_B,
      body: 'open question',
      createdAt: '2026-10-30T10:00:00.000Z',
    },
  ]);
});
afterEach(() => t.dispose());

function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/threads/:threadId', createGetVendorThreadByIdHandler(t.factory));
  a.get('/api/vendor/threads', createListVendorThreadsHandler(t.factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function get(threadId: string, auth: AuthzVariables['auth']) {
  return getPath(`/api/vendor/threads/${threadId}`, auth);
}

async function getPath(path: string, auth: AuthzVariables['auth']) {
  const execCtx = fakeExecutionContext();
  const res = await app(auth).request(path, { method: 'GET' }, TEST_ENV, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody };
}

describe('GET /api/vendor/threads/:threadId (AECI-1548)', () => {
  it('reads a detached thread for either stamped company, named from its snapshot', async () => {
    for (const auth of [AUTH_A, AUTH_B]) {
      const res = await get(T_DETACHED, auth);
      expect(res.status).toBe(200);
      expect(() => GetVendorThreadByIdResponseSchema.parse(res.body)).not.toThrow();
      expect(res.body.thread).toMatchObject({
        id: T_DETACHED,
        claim_id: null,
        closed_reason: 'claim_removed',
        data_object: { slug: 'issues', name: 'Issues' },
        vendor_a: { id: VENDOR_A, name: 'Autodesk' },
        vendor_b: { id: VENDOR_B, name: 'Bentley' },
      });
      expect(res.body.thread.messages.map((m: JsonBody) => m.body)).toEqual([
        'first message',
        null,
      ]);
    }
    expect(JSON.stringify((await get(T_DETACHED, AUTH_A)).body)).not.toContain('withdrawn words');
    // `is_own` is the caller's profile AND company (AECI-1545's isOwnMessage).
    const own = (await get(T_DETACHED, AUTH_A)).body.thread.messages.map((m: JsonBody) => m.is_own);
    expect(own).toEqual([true, false]);
  });

  it('reads a thread whose claim still exists, named from the claim', async () => {
    const res = await get(T_LIVE, AUTH_B);
    expect(res.status).toBe(200);
    expect(res.body.thread).toMatchObject({
      claim_id: C_MAIN,
      closed_reason: 'retired',
      data_object: { slug: 'rfis', name: 'RFIs' },
      messages: [],
    });
  });

  it('answers a stranger and a missing thread with the same 404', async () => {
    const stranger = await get(T_DETACHED, AUTH_OUT);
    const missing = await get(T_MISSING, AUTH_A);
    expect(stranger.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(stranger.body.error.code).toBe(missing.body.error.code);
    expect(JSON.stringify(stranger.body)).not.toContain('first message');
    // The stranger's read writes no marker.
    expect(await t.db.select().from(claimThreadReads)).toEqual([]);
  });

  it("writes the caller's read marker, and moves it on a second read", async () => {
    await get(T_DETACHED, AUTH_A);
    const [first] = await t.db
      .select()
      .from(claimThreadReads)
      .where(eq(claimThreadReads.profileId, SEAT_A));
    expect(first).toMatchObject({ threadId: T_DETACHED, profileId: SEAT_A });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await get(T_DETACHED, AUTH_A);
    const rows = await t.db.select().from(claimThreadReads);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.readAt > first!.readAt).toBe(true);
  });
});

describe('can_write on the by-id read (AECI-1551)', () => {
  it('is true for either company on an open thread whose row is live and attestable', async () => {
    for (const auth of [AUTH_A, AUTH_B]) {
      const res = await get(T_OPEN, auth);
      expect(res.status).toBe(200);
      expect(() => GetVendorThreadByIdResponseSchema.parse(res.body)).not.toThrow();
      expect(res.body.thread).toMatchObject({ claim_id: C_OPEN, can_write: true });
    }
  });

  it('is false on a closed thread and on a detached one', async () => {
    expect((await get(T_LIVE, AUTH_A)).body.thread.can_write).toBe(false);
    expect((await get(T_DETACHED, AUTH_A)).body.thread.can_write).toBe(false);
  });

  it('is false, and the read still answers, once the caller is no longer an endpoint', async () => {
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, VENDOR_A));
    const res = await get(T_OPEN, AUTH_A);
    expect(res.status).toBe(200);
    expect(res.body.thread.can_write).toBe(false);
    // With side A unowned the row is not attestable by two companies, so B's post
    // would be a 409 too (§15.2).
    expect((await get(T_OPEN, AUTH_B)).body.thread.can_write).toBe(false);
    // A new owner of P_A is an endpoint but not on the thread: still no write.
    await t.db
      .insert(productVendors)
      .values({ productId: P_A, vendorId: VENDOR_OUT, isPrimary: true });
    expect((await get(T_OPEN, AUTH_B)).body.thread.can_write).toBe(true);
    expect((await get(T_OPEN, AUTH_OUT)).status).toBe(404);
  });

  it('is false on a retired integration', async () => {
    await t.db
      .update(integrations)
      .set({ retiredAt: '2026-10-30T11:00:00.000Z' })
      .where(eq(integrations.id, I_MAIN));
    expect((await get(T_OPEN, AUTH_A)).body.thread.can_write).toBe(false);
  });

  it('is false once the edge is connector-powered (§15.2)', async () => {
    await t.db
      .update(integrations)
      .set({ mechanismKind: 'iPaaS' })
      .where(eq(integrations.id, I_MAIN));
    expect((await get(T_OPEN, AUTH_A)).body.thread.can_write).toBe(false);
  });
});

describe('GET /api/vendor/threads (AECI-1551)', () => {
  it('lists every thread the company is on, newest activity first, with no text', async () => {
    const res = await getPath('/api/vendor/threads', AUTH_A);
    expect(res.status).toBe(200);
    expect(() => ListVendorThreadsResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.total).toBe(3);
    expect(res.body.data.map((r: JsonBody) => r.id)).toEqual([T_OPEN, T_DETACHED, T_LIVE]);
    expect(res.body.data[0]).toMatchObject({
      claim_id: C_OPEN,
      counterparty: { id: VENDOR_B, name: 'Bentley' },
      data_object: { slug: 'issues', name: 'Issues' },
      message_count: 1,
      last_activity_at: '2026-10-30T10:00:00.000Z',
      closed_at: null,
      help_requested_at: null,
    });
    // A detached thread is named from its snapshot, and counts its deleted message.
    expect(res.body.data[1]).toMatchObject({
      claim_id: null,
      data_object: { slug: 'issues', name: 'Issues' },
      message_count: 2,
      closed_reason: 'claim_removed',
    });
    // The other company sees itself as the counterparty's other side.
    const b = await getPath('/api/vendor/threads', AUTH_B);
    expect(b.body.data[0].counterparty).toEqual({ id: VENDOR_A, name: 'Autodesk' });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('open question');
    expect(raw).not.toContain('first message');
  });

  it('counts a help ask and a close as activity', async () => {
    await t.db
      .update(claimThreads)
      .set({ helpRequestedAt: '2026-10-30T12:00:00.000Z' })
      .where(eq(claimThreads.id, T_LIVE));
    const res = await getPath('/api/vendor/threads', AUTH_A);
    expect(res.body.data[0]).toMatchObject({
      id: T_LIVE,
      last_activity_at: '2026-10-30T12:00:00.000Z',
    });
  });

  it('filters by status and pages with page / perPage', async () => {
    const open = await getPath('/api/vendor/threads?status=open', AUTH_A);
    expect(open.body.data.map((r: JsonBody) => r.id)).toEqual([T_OPEN]);
    expect(open.body.total).toBe(1);
    const closed = await getPath('/api/vendor/threads?status=closed', AUTH_A);
    expect(closed.body.data.map((r: JsonBody) => r.id)).toEqual([T_DETACHED, T_LIVE]);
    const second = await getPath('/api/vendor/threads?page=2&perPage=2', AUTH_A);
    expect(second.body).toMatchObject({ page: 2, perPage: 2, total: 3 });
    expect(second.body.data.map((r: JsonBody) => r.id)).toEqual([T_LIVE]);
    expect((await getPath('/api/vendor/threads?status=nope', AUTH_A)).status).toBe(400);
  });

  it('shows a stranger nothing, and writes no read marker', async () => {
    const res = await getPath('/api/vendor/threads', AUTH_OUT);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ data: [], total: 0 });
    await getPath('/api/vendor/threads', AUTH_A);
    expect(await t.db.select().from(claimThreadReads)).toEqual([]);
  });
});
