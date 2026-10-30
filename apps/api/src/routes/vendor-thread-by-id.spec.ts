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
 *   - a deleted message's body never reaches the vendor.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GetVendorThreadByIdResponseSchema } from '@aeci/shared';

import {
  claimThreadMessages,
  claimThreadReads,
  claimThreads,
  claims,
  integrations,
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
import { createGetVendorThreadByIdHandler } from './vendor-thread-by-id';

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
const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const SEAT_OUT = uuid(102);
const T_LIVE = uuid(200);
const T_DETACHED = uuid(201);
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
  await t.db.insert(integrations).values({ id: I_MAIN, sourceProductId: P_A, targetProductId: P_B });
  await t.db.insert(taxonomyDataObjects).values([
    { id: DO_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 1 },
    { id: DO_ISSUES, slug: 'issues', name: 'Issues', displayOrder: 2 },
  ]);
  await t.db
    .insert(claims)
    .values({ id: C_MAIN, integrationId: I_MAIN, dataObjectId: DO_RFIS, direction: 'a_to_b' });
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_OUT, role: 'vendor_admin', vendorId: VENDOR_OUT },
  ]);
  // A thread on a live claim, closed `retired`, and one whose claim was deleted.
  await t.db.insert(claimThreads).values([
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
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function get(threadId: string, auth: AuthzVariables['auth']) {
  const execCtx = fakeExecutionContext();
  const res = await app(auth).request(
    `/api/vendor/threads/${threadId}`,
    { method: 'GET' },
    TEST_ENV,
    execCtx,
  );
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
    const own = (await get(T_DETACHED, AUTH_A)).body.thread.messages.map(
      (m: JsonBody) => m.is_own,
    );
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
