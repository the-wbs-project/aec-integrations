/**
 * Private row thread handler coverage (AECI-1535 / `STAGE_2_ATTESTATIONS_SPEC.md`
 * §15.2–§15.7).
 *
 * Same harness as `vendor-attestations.spec.ts`: the REAL migrations against
 * in-memory SQLite with `foreign_keys = ON`, `db.batch` shimmed onto a real
 * transaction, and the session stubbed with `c.set('auth', …)`. The route
 * registration (the guard, then the write limiter on writes only) is
 * `vendor-threads.registration.spec.ts`.
 *
 * The load-bearing cases:
 *   - a caller with no endpoint on the claim gets the same 404 as a missing claim;
 *   - the §15.2 test answers 409 THREAD_NOT_ATTESTABLE on a write;
 *   - the first post creates the thread, and only the first;
 *   - the audit row and the other company's portal row ride the post's batch, and
 *     neither carries the message text;
 *   - a soft delete hides the body from every vendor read and keeps it in D1.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  claimThreadMessages,
  claimThreadReads,
  claimThreads,
  claims,
  connectorEvidencedPairs,
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
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import {
  createDeleteThreadMessageHandler,
  createGetVendorThreadHandler,
  createListIntegrationThreadsHandler,
  createPostThreadMessageHandler,
  createRequestThreadHelpHandler,
  type SendThreadHelpAlert,
} from './vendor-threads';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A owns the SOURCE product, B the TARGET. BOTH owns both ends of its own pair.
// THIRD co-owns the target product with B in one test.
const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_BOTH = uuid(3);
const VENDOR_OUT = uuid(4);
const VENDOR_THIRD = uuid(5);

const P_SOURCE = uuid(10);
const P_TARGET = uuid(11);
const P_OWN_A = uuid(12);
const P_OWN_B = uuid(13);
const P_OUT = uuid(14);
const P_CONNECTOR = uuid(15);

const I_MAIN = uuid(20);
const I_INTRA = uuid(21);

const DO_RFIS = uuid(30);

const C_MAIN = uuid(40);
const C_INTRA = uuid(41);
const C_MISSING = uuid(49);

const SEAT_A = uuid(100);
const SEAT_A2 = uuid(101);
const SEAT_B = uuid(102);
const SEAT_BOTH = uuid(103);
const SEAT_OUT = uuid(104);
const SEAT_THIRD = uuid(105);

const BODY = 'We only sync RFIs that have a due date. Can you confirm yours do the same?';

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
const AUTH_A2 = seat(SEAT_A2, VENDOR_A);
const AUTH_B = seat(SEAT_B, VENDOR_B);
const AUTH_BOTH = seat(SEAT_BOTH, VENDOR_BOTH);
const AUTH_OUT = seat(SEAT_OUT, VENDOR_OUT);
const AUTH_THIRD = seat(SEAT_THIRD, VENDOR_THIRD);

let t: TestDb;
let sendAlert: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  t = await makeTestDb();
  sendAlert = vi.fn().mockResolvedValue('sent');

  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_BOTH, slug: 'procore', companyName: 'Procore' },
    { id: VENDOR_OUT, slug: 'trimble', companyName: 'Trimble' },
    { id: VENDOR_THIRD, slug: 'nemetschek', companyName: 'Nemetschek' },
  ]);
  await t.db.insert(products).values([
    { id: P_SOURCE, slug: 'revit', name: 'Revit' },
    { id: P_TARGET, slug: 'microstation', name: 'MicroStation' },
    { id: P_OWN_A, slug: 'procore-core', name: 'Procore Core' },
    { id: P_OWN_B, slug: 'procore-field', name: 'Procore Field' },
    { id: P_OUT, slug: 'tekla', name: 'Tekla' },
    { id: P_CONNECTOR, slug: 'agave-erp-sync', name: 'Agave ERP Sync', productRole: 'connector' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SOURCE, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_TARGET, vendorId: VENDOR_B, isPrimary: true },
    { productId: P_OWN_A, vendorId: VENDOR_BOTH, isPrimary: true },
    { productId: P_OWN_B, vendorId: VENDOR_BOTH, isPrimary: true },
    { productId: P_OUT, vendorId: VENDOR_OUT, isPrimary: true },
  ]);
  await t.db.insert(integrations).values([
    { id: I_MAIN, sourceProductId: P_SOURCE, targetProductId: P_TARGET, mechanismKind: 'native' },
    { id: I_INTRA, sourceProductId: P_OWN_A, targetProductId: P_OWN_B },
  ]);
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: DO_RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 1 });
  await t.db.insert(claims).values([
    { id: C_MAIN, integrationId: I_MAIN, dataObjectId: DO_RFIS, direction: 'a_to_b' },
    { id: C_INTRA, integrationId: I_INTRA, dataObjectId: DO_RFIS, direction: 'both' },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_A2, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_BOTH, role: 'vendor_admin', vendorId: VENDOR_BOTH },
    { id: SEAT_OUT, role: 'vendor_admin', vendorId: VENDOR_OUT },
    { id: SEAT_THIRD, role: 'vendor_admin', vendorId: VENDOR_THIRD },
  ]);
});
afterEach(() => t.dispose());

/** App with the session stubbed. Route order mirrors `index.ts`. */
function app(auth: AuthzVariables['auth']) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/claims/:claimId/thread', createGetVendorThreadHandler(t.factory));
  a.get('/api/vendor/integrations/:id/threads', createListIntegrationThreadsHandler(t.factory));
  a.post('/api/vendor/claims/:claimId/thread/messages', createPostThreadMessageHandler(t.factory));
  a.delete(
    '/api/vendor/claims/:claimId/thread/messages/:messageId',
    createDeleteThreadMessageHandler(t.factory),
  );
  a.post(
    '/api/vendor/claims/:claimId/thread/help',
    createRequestThreadHelpHandler(t.factory, sendAlert as unknown as SendThreadHelpAlert),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  auth: AuthzVariables['auth'],
  body?: unknown,
): Promise<{ status: number; body: JsonBody }> {
  const execCtx = fakeExecutionContext();
  const res = await app(auth).request(
    path,
    {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
    },
    TEST_ENV,
    execCtx,
  );
  // Drain waitUntil so the post-commit forward and the help email have run.
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody };
}

const threadUrl = (claimId: string) => `/api/vendor/claims/${claimId}/thread`;
const messagesUrl = (claimId: string) => `${threadUrl(claimId)}/messages`;
const post = (auth: AuthzVariables['auth'], body: unknown = { body: BODY }, claimId = C_MAIN) =>
  call('POST', messagesUrl(claimId), auth, body);

const auditRows = () => t.db.select().from(auditLog);
const closeThread = () =>
  t.db
    .update(claimThreads)
    .set({ closedAt: '2026-10-29T00:00:00.000Z', closedReason: 'retired' })
    .where(eq(claimThreads.claimId, C_MAIN));

describe('the 404 guard', () => {
  it('answers a caller with no endpoint on the claim exactly as a missing claim', async () => {
    const foreign = await call('GET', threadUrl(C_MAIN), AUTH_OUT);
    const missing = await call('GET', threadUrl(C_MISSING), AUTH_OUT);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
    expect(foreign.body.error.code).toBe(missing.body.error.code);
  });

  it('answers 404 on every write from a non-endpoint caller, and writes nothing', async () => {
    await post(AUTH_A);
    const [message] = await t.db.select().from(claimThreadMessages);
    const before = (await auditRows()).length;
    for (const res of [
      await post(AUTH_OUT),
      await call('DELETE', `${messagesUrl(C_MAIN)}/${message!.id}`, AUTH_OUT),
      await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_OUT),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(await t.db.select().from(claimThreadMessages)).toHaveLength(1);
    expect(await auditRows()).toHaveLength(before);
  });

  it('answers 404 to a third company that co-owns an endpoint after the thread exists', async () => {
    await post(AUTH_A);
    await t.db
      .insert(productVendors)
      .values({ productId: P_TARGET, vendorId: VENDOR_THIRD, isPrimary: false });
    expect((await call('GET', threadUrl(C_MAIN), AUTH_THIRD)).status).toBe(404);
    expect((await post(AUTH_THIRD)).status).toBe(404);
  });
});

describe('the stamped pair decides access (ruled 2026-10-29)', () => {
  it('lets a stamped company that no longer owns its product read, never write', async () => {
    const created = await post(AUTH_A);
    const id = created.body.thread.messages[0].id;
    // A's product changes hands to THIRD after the thread was created.
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, VENDOR_A));
    await t.db
      .insert(productVendors)
      .values({ productId: P_SOURCE, vendorId: VENDOR_THIRD, isPrimary: true });

    const read = await call('GET', threadUrl(C_MAIN), AUTH_A);
    expect(read.status).toBe(200);
    expect(read.body.thread.vendor_a).toEqual({ id: VENDOR_A, name: 'Autodesk' });
    for (const res of [
      await post(AUTH_A),
      await call('DELETE', `${messagesUrl(C_MAIN)}/${id}`, AUTH_A),
      await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A),
    ]) {
      expect(res.status).toBe(404);
    }

    // The new owner is an endpoint but not on the thread: the stranger's 404.
    expect((await call('GET', threadUrl(C_MAIN), AUTH_THIRD)).status).toBe(404);
    expect((await post(AUTH_THIRD)).status).toBe(404);
  });

  it('shows help_requested_at to both companies', async () => {
    await post(AUTH_A);
    await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A);
    const asB = await call('GET', threadUrl(C_MAIN), AUTH_B);
    expect(asB.body.thread.help_requested_at).toEqual(expect.any(String));
  });
});

describe('GET /api/vendor/claims/:claimId/thread', () => {
  it('answers { thread: null } before the first message, and creates nothing', async () => {
    const res = await call('GET', threadUrl(C_MAIN), AUTH_B);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ thread: null, counterparty: { id: VENDOR_A, name: 'Autodesk' } });
    expect(await t.db.select().from(claimThreads)).toHaveLength(0);
    expect(await t.db.select().from(claimThreadReads)).toHaveLength(0);
  });

  it('upserts the read marker and writes no audit row', async () => {
    await post(AUTH_A);
    const before = (await auditRows()).length;
    await call('GET', threadUrl(C_MAIN), AUTH_B);
    await call('GET', threadUrl(C_MAIN), AUTH_B);
    const reads = await t.db.select().from(claimThreadReads);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.profileId).toBe(SEAT_B);
    // The AECI-1537 digest compares read_at to created_at as text: same ISO format.
    expect(reads[0]!.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const [message] = await t.db.select().from(claimThreadMessages);
    expect(message!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(await auditRows()).toHaveLength(before);
  });
});

describe('GET /api/vendor/integrations/:id/threads (AECI-1546)', () => {
  const C_SECOND = uuid(42);
  const DO_DRAWINGS = uuid(31);
  const listUrl = (integrationId: string) => `/api/vendor/integrations/${integrationId}/threads`;

  beforeEach(async () => {
    await t.db
      .insert(taxonomyDataObjects)
      .values({ id: DO_DRAWINGS, slug: 'drawings', name: 'Drawings', displayOrder: 2 });
    await t.db.insert(claims).values({
      id: C_SECOND,
      integrationId: I_MAIN,
      dataObjectId: DO_DRAWINGS,
      direction: 'a_to_b',
    });
  });

  it('answers the first-post counterparty and no threads before any message', async () => {
    const res = await call('GET', listUrl(I_MAIN), AUTH_B);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ counterparty: { id: VENDOR_A, name: 'Autodesk' }, threads: [] });
  });

  it('summarises every thread on the integration in one read, with no text', async () => {
    await post(AUTH_A);
    await post(AUTH_B, { body: 'Yes, ours do too.' });
    const [first] = await t.db
      .select()
      .from(claimThreadMessages)
      .where(eq(claimThreadMessages.body, BODY));
    await call('DELETE', `${messagesUrl(C_MAIN)}/${first!.id}`, AUTH_A);
    await post(AUTH_B, undefined, C_SECOND);
    await t.db
      .update(claimThreads)
      .set({ closedAt: '2026-10-29T00:00:00.000Z', closedReason: 'retired' })
      .where(eq(claimThreads.claimId, C_SECOND));

    const res = await call('GET', listUrl(I_MAIN), AUTH_A);
    expect(res.status).toBe(200);
    expect(res.body.counterparty).toEqual({ id: VENDOR_B, name: 'Bentley' });
    expect(res.body.threads).toEqual([
      expect.objectContaining({
        claim_id: C_MAIN,
        counterparty: { id: VENDOR_B, name: 'Bentley' },
        // The deleted message still counts: it shows as "Message deleted".
        message_count: 2,
        closed_at: null,
        closed_reason: null,
      }),
      expect.objectContaining({ claim_id: C_SECOND, message_count: 1, closed_reason: 'retired' }),
    ]);
    const onMain = await t.db
      .select()
      .from(claimThreadMessages)
      .where(eq(claimThreadMessages.threadId, res.body.threads[0].id));
    const latest = onMain.map((m) => m.createdAt).reduce((a, b) => (a > b ? a : b));
    expect(res.body.threads[0].latest_message_at).toBe(latest);
    expect(JSON.stringify(res.body)).not.toContain(BODY);
    expect(JSON.stringify(res.body)).not.toContain('Yes, ours do too.');
  });

  it('writes no read marker and no audit row', async () => {
    await post(AUTH_A);
    const before = (await auditRows()).length;
    await call('GET', listUrl(I_MAIN), AUTH_B);
    expect(await t.db.select().from(claimThreadReads)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(before);
    // The claim read, which shows the messages, still writes it.
    await call('GET', threadUrl(C_MAIN), AUTH_B);
    expect(await t.db.select().from(claimThreadReads)).toHaveLength(1);
  });

  it('lists a thread only to its two stamped companies', async () => {
    await post(AUTH_A);
    await t.db
      .insert(productVendors)
      .values({ productId: P_TARGET, vendorId: VENDOR_THIRD, isPrimary: false });
    const asThird = await call('GET', listUrl(I_MAIN), AUTH_THIRD);
    expect(asThird.status).toBe(200);
    expect(asThird.body.threads).toEqual([]);
  });

  it('answers a non-endpoint caller exactly as a missing integration', async () => {
    const foreign = await call('GET', listUrl(I_MAIN), AUTH_OUT);
    const missing = await call('GET', listUrl(uuid(29)), AUTH_OUT);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
  });

  it('answers a null counterparty when the rows have no second company', async () => {
    const res = await call('GET', listUrl(I_INTRA), AUTH_BOTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ counterparty: null, threads: [] });
  });
});

describe('counterparty: the real recipient (AECI-1545, §15.6)', () => {
  it.each([
    ['plain two-company row', [] as { productId: string; vendorId: string }[], AUTH_A],
    ['co-owned other endpoint', [{ productId: P_TARGET, vendorId: VENDOR_THIRD }], AUTH_A],
    [
      'caller is a co-owner of its endpoint',
      [{ productId: P_SOURCE, vendorId: VENDOR_THIRD }],
      AUTH_THIRD,
    ],
  ])('before the first post, names the vendor the post stamps: %s', async (_l, extra, auth) => {
    if (extra.length > 0) {
      await t.db.insert(productVendors).values(extra.map((row) => ({ ...row, isPrimary: false })));
    }
    const before = await call('GET', threadUrl(C_MAIN), auth);
    expect(before.status).toBe(200);
    expect(before.body.thread).toBeNull();
    expect(before.body.counterparty).not.toBeNull();

    await post(auth);
    const [stamped] = await t.db.select().from(claimThreads);
    const callerVendor = auth.vendorId;
    const stampedOther =
      stamped!.vendorAId === callerVendor ? stamped!.vendorBId : stamped!.vendorAId;
    expect(before.body.counterparty.id).toBe(stampedOther);

    const after = await call('GET', threadUrl(C_MAIN), auth);
    expect(after.body.counterparty).toEqual(before.body.counterparty);
  });

  it('is null before the first post on a row with no second company', async () => {
    const res = await call('GET', threadUrl(C_INTRA), AUTH_BOTH);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ thread: null, counterparty: null });
  });

  it('stays the stamped company after the other product changes hands', async () => {
    await post(AUTH_A);
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, VENDOR_B));
    await t.db
      .insert(productVendors)
      .values({ productId: P_TARGET, vendorId: VENDOR_THIRD, isPrimary: true });
    const res = await call('GET', threadUrl(C_MAIN), AUTH_A);
    expect(res.status).toBe(200);
    expect(res.body.counterparty).toEqual({ id: VENDOR_B, name: 'Bentley' });
  });
});

describe('POST /api/vendor/claims/:claimId/thread/messages', () => {
  it('creates the thread on the first message, between the two endpoint companies', async () => {
    const res = await post(AUTH_B);
    expect(res.status).toBe(201);
    const threads = await t.db.select().from(claimThreads);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ claimId: C_MAIN, vendorAId: VENDOR_A, vendorBId: VENDOR_B });
    expect(res.body.thread).toMatchObject({
      claim_id: C_MAIN,
      vendor_a: { id: VENDOR_A, name: 'Autodesk' },
      vendor_b: { id: VENDOR_B, name: 'Bentley' },
      closed_at: null,
      help_requested_at: null,
    });
    expect(res.body.thread.messages).toEqual([
      expect.objectContaining({
        author_vendor: { id: VENDOR_B, name: 'Bentley' },
        author_removed: false,
        is_own: true,
        body: BODY,
        deleted_at: null,
      }),
    ]);
  });

  it('reuses the thread on later messages and lists them oldest first', async () => {
    await post(AUTH_A, { body: 'first' });
    const res = await post(AUTH_B, { body: '  second  ' });
    expect(await t.db.select().from(claimThreads)).toHaveLength(1);
    expect(res.body.thread.messages.map((m: JsonBody) => m.body)).toEqual(['first', 'second']);
    // The other company reads B's message as not its own.
    const asA = await call('GET', threadUrl(C_MAIN), AUTH_A);
    expect(asA.body.thread.messages.map((m: JsonBody) => m.is_own)).toEqual([true, false]);
  });

  it('writes the posted audit row in the batch, with the length and no text', async () => {
    const res = await post(AUTH_A);
    const messageId = res.body.thread.messages[0].id;
    const rows = await auditRows();
    const posted = rows.find((r) => r.action === 'thread.message.posted');
    expect(posted).toMatchObject({
      entityType: 'claim_thread_message',
      entityId: messageId,
      vendorId: VENDOR_A,
      actorId: SEAT_A,
    });
    expect(posted!.afterState).toEqual({
      threadId: res.body.thread.id,
      claimId: C_MAIN,
      vendorId: VENDOR_A,
      length: BODY.length,
    });
    expect(JSON.stringify(rows)).not.toContain(BODY);
  });

  it("writes one portal row for the other company's seats, in the batch, without the text", async () => {
    const res = await post(AUTH_A);
    const notices = (await auditRows()).filter((r) => r.action === NOTIFICATION_SENT_ACTION);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      vendorId: VENDOR_B,
      entityType: 'claim_thread_message',
      entityId: res.body.thread.messages[0].id,
    });
    expect(notices[0]!.metadata).toMatchObject({
      kind: 'thread_message',
      notificationId: 'portal-thread-message',
      vendorId: VENDOR_B,
      fromVendorId: VENDOR_A,
      fromVendorName: 'Autodesk',
      claimId: C_MAIN,
      dataObject: { slug: 'rfis', name: 'RFIs' },
      pairSlugs: ['microstation', 'revit'],
    });
    expect(JSON.stringify(notices)).not.toContain(BODY);
  });

  it('rolls the message, the audit row and the portal row back together', async () => {
    await post(AUTH_A);
    const before = (await auditRows()).length;
    // The thread closes between the handler's read and its batch.
    const batch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await closeThread();
      return batch(stmts);
    }) as never);
    const res = await post(AUTH_B);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('THREAD_CLOSED');
    expect(await t.db.select().from(claimThreadMessages)).toHaveLength(1);
    expect(await auditRows()).toHaveLength(before);
  });

  it.each([
    ['empty', { body: '   ' }],
    ['over 2000 characters', { body: 'x'.repeat(2001) }],
  ])('answers 400 VALIDATION_FAILED for a body that is %s', async (_label, body) => {
    const res = await post(AUTH_A, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(await t.db.select().from(claimThreads)).toHaveLength(0);
  });

  it('accepts exactly 2000 characters', async () => {
    expect((await post(AUTH_A, { body: 'x'.repeat(2000) })).status).toBe(201);
  });
});

describe('409 THREAD_NOT_ATTESTABLE (§15.2)', () => {
  it.each([
    ['powered_by set', { poweredByProductId: P_CONNECTOR }],
    ['a connector mechanism_kind', { mechanismKind: 'iPaaS' }],
  ])('refuses a connector-powered edge (%s)', async (_label, patch) => {
    await t.db.update(integrations).set(patch).where(eq(integrations.id, I_MAIN));
    const res = await post(AUTH_A);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('THREAD_NOT_ATTESTABLE');
    expect(await t.db.select().from(claimThreads)).toHaveLength(0);
  });

  it('refuses a row whose two endpoints belong to one company', async () => {
    const res = await post(AUTH_BOTH, { body: BODY }, C_INTRA);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('THREAD_NOT_ATTESTABLE');
  });

  it('refuses a row whose other endpoint has no vendor', async () => {
    await t.db.delete(productVendors).where(eq(productVendors.productId, P_TARGET));
    const res = await post(AUTH_A);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('THREAD_NOT_ATTESTABLE');
  });

  it('refuses a delete and a help request once the edge becomes connector-powered', async () => {
    const created = await post(AUTH_A);
    await t.db
      .update(integrations)
      .set({ poweredByProductId: P_CONNECTOR })
      .where(eq(integrations.id, I_MAIN));
    const id = created.body.thread.messages[0].id;
    for (const res of [
      await call('DELETE', `${messagesUrl(C_MAIN)}/${id}`, AUTH_A),
      await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('THREAD_NOT_ATTESTABLE');
    }
    // The read still shows the thread it has.
    expect((await call('GET', threadUrl(C_MAIN), AUTH_B)).body.thread.messages).toHaveLength(1);
  });
});

describe('409 INTEGRATION_RETIRED (§15.6, AECI-1544)', () => {
  const RETIRED_AT = '2026-10-29T00:00:00.000Z';
  /** What a retire commits: the row retired and every open thread on it closed. */
  const retire = async () => {
    await t.db
      .update(integrations)
      .set({ retiredAt: RETIRED_AT })
      .where(eq(integrations.id, I_MAIN));
    await closeThread();
  };
  /** Run `retire` between the handler's reads and its batch. */
  const retireBeforeTheBatch = () => {
    const batch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await retire();
      return batch(stmts);
    }) as never);
  };

  it('refuses a post and a help ask on a retired row', async () => {
    await post(AUTH_A);
    await retire();
    for (const res of [
      await post(AUTH_B),
      await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
    }
  });

  it('refuses a first post when a retire lands between the read and the batch', async () => {
    retireBeforeTheBatch();
    const res = await post(AUTH_A);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
    // No thread opened on the retired row, so none is left open behind the retire.
    expect(await t.db.select().from(claimThreads)).toHaveLength(0);
    expect(await t.db.select().from(claimThreadMessages)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('refuses a later post when a retire lands between the read and the batch', async () => {
    await post(AUTH_A);
    const before = (await auditRows()).length;
    retireBeforeTheBatch();
    const res = await post(AUTH_B);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
    expect(await t.db.select().from(claimThreadMessages)).toHaveLength(1);
    expect(await auditRows()).toHaveLength(before);
  });

  it('refuses a help ask when a retire lands between the read and the batch', async () => {
    await post(AUTH_A);
    const before = (await auditRows()).length;
    retireBeforeTheBatch();
    const res = await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INTEGRATION_RETIRED');
    expect((await t.db.select().from(claimThreads))[0]).toMatchObject({ helpRequestedAt: null });
    expect(await auditRows()).toHaveLength(before);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('a promote move between the read and the batch (AECI-1544)', () => {
  /** What a promote move into the connector tier commits: the pair row under the
   *  same id, the claims re-homed onto it, and the `integrations` row deleted. */
  const moveBeforeTheBatch = () => {
    const batch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.insert(connectorEvidencedPairs).values({
        id: I_MAIN,
        connectorProductId: P_CONNECTOR,
        productAId: P_SOURCE,
        productBId: P_TARGET,
      });
      await t.db
        .update(claims)
        .set({ integrationId: null, connectorEvidencedPairId: I_MAIN })
        .where(eq(claims.integrationId, I_MAIN));
      await t.db.delete(integrations).where(eq(integrations.id, I_MAIN));
      return batch(stmts);
    }) as never);
  };

  it('answers the claim 404 to a first post, and opens no thread on the moved row', async () => {
    moveBeforeTheBatch();
    const res = await post(AUTH_A);
    expect(res.status).toBe(404);
    expect(res.body.error.details).toMatchObject({ resource: 'claim' });
    expect(await t.db.select().from(claimThreads)).toHaveLength(0);
    expect(await t.db.select().from(claimThreadMessages)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers the claim 404 to a help ask, and writes nothing', async () => {
    await post(AUTH_A);
    const before = (await auditRows()).length;
    moveBeforeTheBatch();
    const res = await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A);
    expect(res.status).toBe(404);
    expect(res.body.error.details).toMatchObject({ resource: 'claim' });
    expect((await t.db.select().from(claimThreads))[0]).toMatchObject({ helpRequestedAt: null });
    expect(await auditRows()).toHaveLength(before);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('a claim delete between the read and the batch (AECI-1544)', () => {
  /** What promote's reconcile and the retraction commit before a claim DELETE (§15.5):
   *  the thread detached and closed `claim_removed`, then the claim gone. */
  const deleteClaim = async () => {
    await t.db
      .update(claimThreads)
      .set({
        claimId: null,
        anchorSnapshot: { anchorId: I_MAIN, dataObjectId: DO_RFIS },
        closedAt: '2026-10-30T00:00:00.000Z',
        closedReason: 'claim_removed',
      })
      .where(eq(claimThreads.claimId, C_MAIN));
    await t.db.delete(claims).where(eq(claims.id, C_MAIN));
  };
  const deleteClaimBeforeTheBatch = () => {
    const batch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await deleteClaim();
      return batch(stmts);
    }) as never);
  };
  const expectClaimRemoved = (res: { status: number; body: JsonBody }) => {
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('THREAD_CLOSED');
    expect(res.body.error.details).toEqual({ closed_reason: 'claim_removed' });
  };

  it('answers a first post with the claim 404, never a 500, and writes nothing', async () => {
    deleteClaimBeforeTheBatch();
    const res = await post(AUTH_A);
    expect(res.status).toBe(404);
    expect(res.body.error.details).toMatchObject({ resource: 'claim' });
    expect(await t.db.select().from(claimThreads)).toHaveLength(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers a later post THREAD_CLOSED with the claim_removed reason', async () => {
    await post(AUTH_A);
    const before = (await auditRows()).length;
    deleteClaimBeforeTheBatch();
    expectClaimRemoved(await post(AUTH_B));
    expect(await t.db.select().from(claimThreadMessages)).toHaveLength(1);
    expect(await auditRows()).toHaveLength(before);
  });

  it('answers a delete THREAD_CLOSED, and the message keeps its body', async () => {
    const created = await post(AUTH_A);
    const id = created.body.thread.messages[0].id;
    const before = (await auditRows()).length;
    deleteClaimBeforeTheBatch();
    expectClaimRemoved(await call('DELETE', `${messagesUrl(C_MAIN)}/${id}`, AUTH_A));
    expect((await t.db.select().from(claimThreadMessages))[0]).toMatchObject({ deletedAt: null });
    expect(await auditRows()).toHaveLength(before);
  });

  it('answers a help ask THREAD_CLOSED, writes nothing and sends no email', async () => {
    await post(AUTH_A);
    const before = (await auditRows()).length;
    deleteClaimBeforeTheBatch();
    expectClaimRemoved(await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A));
    expect((await t.db.select().from(claimThreads))[0]).toMatchObject({ helpRequestedAt: null });
    expect(await auditRows()).toHaveLength(before);
    expect(sendAlert).not.toHaveBeenCalled();
  });
});

describe('409 THREAD_CLOSED', () => {
  it('refuses every write to a closed thread', async () => {
    const created = await post(AUTH_A);
    const id = created.body.thread.messages[0].id;
    await closeThread();
    for (const res of [
      await post(AUTH_B),
      await call('DELETE', `${messagesUrl(C_MAIN)}/${id}`, AUTH_A),
      await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('THREAD_CLOSED');
      expect(res.body.error.details).toEqual({ closed_reason: 'retired' });
    }
    const read = await call('GET', threadUrl(C_MAIN), AUTH_B);
    expect(read.body.thread).toMatchObject({ closed_reason: 'retired' });
  });
});

describe('DELETE /api/vendor/claims/:claimId/thread/messages/:messageId', () => {
  it('soft-deletes: the body leaves every vendor read and stays in D1', async () => {
    const created = await post(AUTH_A);
    const id = created.body.thread.messages[0].id;
    const res = await call('DELETE', `${messagesUrl(C_MAIN)}/${id}`, AUTH_A);
    expect(res.status).toBe(200);
    expect(res.body.thread.messages[0]).toMatchObject({ id, body: null });
    expect(res.body.thread.messages[0].deleted_at).toEqual(expect.any(String));

    const asB = await call('GET', threadUrl(C_MAIN), AUTH_B);
    expect(asB.body.thread.messages[0]).toMatchObject({ id, body: null });
    expect(JSON.stringify(asB.body)).not.toContain(BODY);

    const [stored] = await t.db.select().from(claimThreadMessages);
    expect(stored!.body).toBe(BODY);
    expect(stored!.deletedAt).not.toBeNull();

    const deleted = (await auditRows()).filter((r) => r.action === 'thread.message.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ entityId: id, vendorId: VENDOR_A });
    expect(deleted[0]!.afterState).toEqual({ deletedAt: stored!.deletedAt });
    expect(JSON.stringify(await auditRows())).not.toContain(BODY);
  });

  it('is a no-op 200 with no second audit row on an already deleted message', async () => {
    const created = await post(AUTH_A);
    const id = created.body.thread.messages[0].id;
    await call('DELETE', `${messagesUrl(C_MAIN)}/${id}`, AUTH_A);
    const again = await call('DELETE', `${messagesUrl(C_MAIN)}/${id}`, AUTH_A);
    expect(again.status).toBe(200);
    expect((await auditRows()).filter((r) => r.action === 'thread.message.deleted')).toHaveLength(
      1,
    );
  });

  it.each([
    ['the other company', AUTH_B],
    ['a colleague on the same company', AUTH_A2],
  ])('answers 403 MESSAGE_NOT_AUTHOR to %s', async (_label, auth) => {
    const created = await post(AUTH_A);
    const id = created.body.thread.messages[0].id;
    const res = await call('DELETE', `${messagesUrl(C_MAIN)}/${id}`, auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MESSAGE_NOT_AUTHOR');
    const [stored] = await t.db.select().from(claimThreadMessages);
    expect(stored!.deletedAt).toBeNull();
  });

  it('answers 403 MESSAGE_NOT_AUTHOR to the author re-seated at the other company', async () => {
    const created = await post(AUTH_A);
    const id = created.body.thread.messages[0].id;
    // Same person, now a seat of the other company on the thread (AECI-1545).
    const reseated = seat(SEAT_A, VENDOR_B);
    const read = await call('GET', threadUrl(C_MAIN), reseated);
    expect(read.status).toBe(200);
    expect(read.body.thread.messages[0]).toMatchObject({ id, is_own: false });
    const res = await call('DELETE', `${messagesUrl(C_MAIN)}/${id}`, reseated);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MESSAGE_NOT_AUTHOR');
    const [stored] = await t.db.select().from(claimThreadMessages);
    expect(stored!.deletedAt).toBeNull();
  });

  it('answers 404 for a message that is not on this thread', async () => {
    await post(AUTH_A);
    const res = await call('DELETE', `${messagesUrl(C_MAIN)}/${uuid(999)}`, AUTH_A);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/vendor/claims/:claimId/thread/help', () => {
  it('answers 404 before the first message: a thread is never created in advance', async () => {
    const res = await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A);
    expect(res.status).toBe(404);
    expect(await t.db.select().from(claimThreads)).toHaveLength(0);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it('sets help_requested_at, audits it and emails the support inbox once', async () => {
    await post(AUTH_A);
    const res = await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_B);
    expect(res.status).toBe(200);
    expect(res.body.thread.help_requested_at).toEqual(expect.any(String));

    const asked = (await auditRows()).filter((r) => r.action === 'thread.help_requested');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      entityType: 'claim_thread',
      entityId: res.body.thread.id,
      vendorId: VENDOR_B,
    });
    expect(asked[0]!.afterState).toEqual({ helpRequestedAt: res.body.thread.help_requested_at });

    expect(sendAlert).toHaveBeenCalledTimes(1);
    const opts = sendAlert.mock.calls[0]![1];
    expect(opts).toMatchObject({
      threadId: res.body.thread.id,
      claimId: C_MAIN,
      integrationName: 'Revit and MicroStation',
      dataObjectName: 'RFIs',
      requesterVendorName: 'Bentley',
      otherVendorName: 'Autodesk',
      messageCount: 1,
    });
    expect(JSON.stringify(opts)).not.toContain(BODY);
  });

  it('is a no-op 200 on a second ask: no audit row, no email', async () => {
    await post(AUTH_A);
    const first = await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_A);
    const second = await call('POST', `${threadUrl(C_MAIN)}/help`, AUTH_B);
    expect(second.status).toBe(200);
    expect(second.body.thread.help_requested_at).toBe(first.body.thread.help_requested_at);
    expect((await auditRows()).filter((r) => r.action === 'thread.help_requested')).toHaveLength(1);
    expect(sendAlert).toHaveBeenCalledTimes(1);
  });
});
