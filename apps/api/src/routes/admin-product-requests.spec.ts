/**
 * The admin product request queue (AECI-1377, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6)
 * against the in-memory D1 harness. A stub middleware sets the `auth` Variable
 * `requireAdmin()` would (the guard itself is covered in `authz.spec.ts`).
 *
 * Covers the §4.7.6 admin cases: each outcome, the 422 on a decided row, the lost race
 * rolling back with no portal row and no email, the 422 on an unpromoted product, the
 * required reason, the portal row in the batch, the email after commit, and the badge.
 */

import {
  AdminProductRequestSchema,
  ApiErrorCode,
  ListProductRequestsResponseSchema,
  ListVendorNotificationsResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, productRequests, products, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { readAdminQueueCounts } from '../lib/admin-queue-counts';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import type { SendProductRequestDecided } from '../lib/product-requests';
import { makeTestDb, type TestDb } from '../test/d1';
import { racingFactory } from '../test/racing-factory';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createAdminProductRequestsListHandler,
  createDecideProductRequestHandler,
} from './admin-product-requests';
import { createListVendorNotificationsHandler } from './vendor-notifications';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ADMIN_ID = uuid(1);
const ADMIN_2 = uuid(2);
const VENDOR = uuid(3);
const SEAT = uuid(4);
const P_CONTEXT = uuid(10);
const P_PROMOTED = uuid(11);
const P_PENDING = uuid(12);
const REQ = uuid(20);
const REQ_B = uuid(21);

const adminAuth = (userId: string): AuthzVariables['auth'] => ({
  userId,
  email: 'admin@aeci.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
});
const SEAT_AUTH: AuthzVariables['auth'] = {
  userId: SEAT,
  email: 'seat@bentley.example',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'unclaimed',
  entitlement: null,
};

let t: TestDb;
let fetchSeatEmails: ReturnType<typeof vi.fn>;
let sendDecided: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  t = await makeTestDb();
  fetchSeatEmails = vi.fn(
    async (_env: Env, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, `${id.slice(-2)}@bentley.example`])),
  );
  sendDecided = vi.fn(async () => 'sent' as const);
  await t.db.insert(profiles).values([
    { id: ADMIN_ID, role: 'admin' },
    { id: ADMIN_2, role: 'admin' },
  ]);
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'bentley', companyName: 'Bentley' });
  await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR });
  await t.db.insert(products).values([
    { id: P_CONTEXT, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' },
    { id: P_PROMOTED, slug: 'field-notes', name: 'Field Notes', promotionStatus: 'promoted' },
    { id: P_PENDING, slug: 'draft', name: 'Draft' },
  ]);
});
afterEach(() => t.dispose());

function row(o: Partial<typeof productRequests.$inferInsert> = {}) {
  return {
    id: REQ,
    vendorId: VENDOR,
    requestedBy: SEAT,
    contextProductId: P_CONTEXT,
    name: 'FieldNotes',
    maker: 'Field Notes Inc',
    website: 'https://fieldnotes.example.com',
    body: '',
    status: 'open',
    createdAt: '2026-10-15T08:00:00.000Z',
    ...o,
  } satisfies typeof productRequests.$inferInsert;
}

function app(factory: DbFactory = t.factory, admin = ADMIN_ID) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('/api/admin/*', async (c, next) => {
    c.set('auth', adminAuth(admin));
    await next();
  });
  a.use('/api/vendor/*', async (c, next) => {
    c.set('auth', SEAT_AUTH);
    await next();
  });
  a.get('/api/admin/product-requests', createAdminProductRequestsListHandler(factory));
  a.patch(
    '/api/admin/product-requests/:id',
    createDecideProductRequestHandler(
      factory,
      fetchSeatEmails,
      sendDecided as unknown as SendProductRequestDecided,
    ),
  );
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function patch(id: string, body: unknown, factory?: DbFactory) {
  const execCtx = fakeExecutionContext();
  const res = await app(factory).request(
    `/api/admin/product-requests/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    TEST_ENV,
    execCtx,
  );
  const json = (await res.json()) as JsonBody;
  // Settle every post-commit hook, so "no email" is asserted after it had its chance.
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
  return { status: res.status, body: json, execCtx };
}

const list = async (qs = '') =>
  (
    await app().request(`/api/admin/product-requests${qs}`, {}, TEST_ENV, fakeExecutionContext())
  ).json() as Promise<JsonBody>;

const feed = async () =>
  ListVendorNotificationsResponseSchema.parse(
    await (
      await app().request('/api/vendor/notifications', {}, TEST_ENV, fakeExecutionContext())
    ).json(),
  ).notifications;

describe('GET /api/admin/product-requests', () => {
  it('lists open requests newest first, with the vendor and both products joined', async () => {
    await t.db
      .insert(productRequests)
      .values([
        row(),
        row({ id: REQ_B, name: 'Newer', createdAt: '2026-10-15T09:00:00.000Z' }),
        row({ id: uuid(22), status: 'declined', declineReason: 'No.' }),
      ]);
    const parsed = ListProductRequestsResponseSchema.parse(await list());
    expect(parsed.total).toBe(2);
    expect(parsed.data.map((r) => r.id)).toEqual([REQ_B, REQ]);
    expect(parsed.data[1]).toMatchObject({
      vendor: { id: VENDOR, slug: 'bentley', name: 'Bentley' },
      context_product: { id: P_CONTEXT, slug: 'microstation', name: 'MicroStation' },
      requested_by: SEAT,
      name: 'FieldNotes',
      maker: 'Field Notes Inc',
      website: 'https://fieldnotes.example.com',
      resolved_product: null,
    });
  });

  it('filters by status and pages', async () => {
    await t.db
      .insert(productRequests)
      .values([row(), row({ id: REQ_B, status: 'added', resolvedProductId: P_PROMOTED })]);
    const parsed = ListProductRequestsResponseSchema.parse(await list('?status=added'));
    expect(parsed.data.map((r) => r.id)).toEqual([REQ_B]);
    expect(parsed.data[0]!.resolved_product).toMatchObject({ slug: 'field-notes' });
    const paged = ListProductRequestsResponseSchema.parse(
      await list('?status=open&perPage=1&page=2'),
    );
    expect(paged).toMatchObject({ data: [], page: 2, perPage: 1, total: 1 });
  });
});

describe('PATCH /api/admin/product-requests/:id', () => {
  it.each([
    ['added', 'product_request.added'],
    ['already_listed', 'product_request.already_listed'],
  ] as const)(
    '%s links the promoted product, with its audit and portal rows in one batch',
    async (outcome, action) => {
      await t.db.insert(productRequests).values(row());
      const batch = vi.spyOn(t.db, 'batch');
      const { status, body } = await patch(REQ, { outcome, product_id: P_PROMOTED });
      expect(status).toBe(200);
      const parsed = AdminProductRequestSchema.parse(body);
      expect(parsed).toMatchObject({
        status: outcome,
        resolved_by: ADMIN_ID,
        resolved_product: { id: P_PROMOTED, slug: 'field-notes', name: 'Field Notes' },
        decline_reason: null,
      });
      expect(batch).toHaveBeenCalledTimes(1);
      // UPDATE, sentinel, audit row, portal row.
      expect(batch.mock.calls[0]![0]).toHaveLength(4);
      batch.mockRestore();

      const [stored] = await t.db.select().from(productRequests);
      expect(stored).toMatchObject({
        status: outcome,
        resolvedProductId: P_PROMOTED,
        resolvedById: ADMIN_ID,
      });
      const audits = await t.db.select().from(auditLog);
      expect(audits.map((a) => a.action).sort()).toEqual([action, NOTIFICATION_SENT_ACTION].sort());
      const decision = audits.find((a) => a.action === action)!;
      expect(decision).toMatchObject({
        entityType: 'product_request',
        entityId: REQ,
        actorId: ADMIN_ID,
        vendorId: VENDOR,
        productId: P_CONTEXT,
      });
      const portal = audits.find((a) => a.action === NOTIFICATION_SENT_ACTION)!;
      expect(portal.vendorId).toBe(VENDOR);
      expect(portal.metadata).toMatchObject({
        kind: 'product_request',
        notificationId: 'portal-product-request-decided',
        vendorId: VENDOR,
        event: outcome,
        requestId: REQ,
        requestName: 'FieldNotes',
        product: { slug: 'field-notes', name: 'Field Notes' },
        contextProduct: { slug: 'microstation', name: 'MicroStation' },
      });

      // The vendor's feed reads the row as the new member.
      expect(await feed()).toEqual([
        {
          kind: 'product_request',
          id: portal.id,
          event: outcome,
          request_id: REQ,
          request_name: 'FieldNotes',
          product: { slug: 'field-notes', name: 'Field Notes' },
          context_product: { slug: 'microstation', name: 'MicroStation' },
          reason: null,
          created_at: portal.createdAt,
        },
      ]);

      // The email after commit, to the seat that asked, under the one key.
      expect(sendDecided).toHaveBeenCalledTimes(1);
      expect(sendDecided.mock.calls[0]![1]).toMatchObject({
        to: '04@bentley.example',
        requestId: REQ,
        requestName: 'FieldNotes',
        vendorSlug: 'bentley',
        contextProductSlug: 'microstation',
        decision: { outcome, productName: 'Field Notes', productSlug: 'field-notes' },
        dedupeKey: `product-request-decided:${REQ}`,
      });
    },
  );

  it('declined stores the reason, shows it in the feed row, and emails it', async () => {
    await t.db.insert(productRequests).values(row());
    const { status, body } = await patch(REQ, {
      outcome: 'declined',
      reason: ' Not AEC software. ',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: 'declined',
      decline_reason: 'Not AEC software.',
      resolved_product: null,
    });
    const notifications = await feed();
    expect(notifications[0]).toMatchObject({
      kind: 'product_request',
      event: 'declined',
      product: null,
      reason: 'Not AEC software.',
    });
    expect(sendDecided.mock.calls[0]![1]).toMatchObject({
      decision: { outcome: 'declined', reason: 'Not AEC software.' },
    });
  });

  it.each([
    ['no reason', { outcome: 'declined' }],
    ['a blank reason', { outcome: 'declined', reason: '   ' }],
    ['a reason over 1000', { outcome: 'declined', reason: 'x'.repeat(1001) }],
    ['added without a product', { outcome: 'added' }],
    ['an unknown outcome', { outcome: 'approve', product_id: P_PROMOTED }],
    ['a reason on added', { outcome: 'added', product_id: P_PROMOTED, reason: 'x' }],
  ])('answers 400 for %s, and writes nothing', async (_label, body) => {
    await t.db.insert(productRequests).values(row());
    expect((await patch(REQ, body)).status).toBe(400);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it.each([
    ['an unpromoted product', P_PENDING],
    ['an unknown product', uuid(99)],
  ])('answers 422 PRODUCT_NOT_PROMOTED for %s, and writes nothing', async (_label, id) => {
    await t.db.insert(productRequests).values(row());
    const { status, body } = await patch(REQ, { outcome: 'added', product_id: id });
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.PRODUCT_NOT_PROMOTED);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect((await t.db.select().from(productRequests))[0]!.status).toBe('open');
    expect(sendDecided).not.toHaveBeenCalled();
  });

  it('answers 422 on a request that is already decided, and writes nothing', async () => {
    await t.db.insert(productRequests).values(row({ status: 'declined', declineReason: 'No.' }));
    const { status, body } = await patch(REQ, { outcome: 'added', product_id: P_PROMOTED });
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(sendDecided).not.toHaveBeenCalled();
  });

  it('rolls a lost two-admin race back: no audit row, no portal row, no email', async () => {
    await t.db.insert(productRequests).values(row());
    // Another admin declines between this handler's read and its batch.
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db
        .update(productRequests)
        .set({ status: 'declined', declineReason: 'Other admin.', resolvedById: ADMIN_2 })
        .where(eq(productRequests.id, REQ));
    });
    const { status, body } = await patch(REQ, { outcome: 'added', product_id: P_PROMOTED }, racing);
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(await feed()).toEqual([]);
    expect(sendDecided).not.toHaveBeenCalled();
    // The winner's decision stands.
    expect((await t.db.select().from(productRequests))[0]).toMatchObject({
      status: 'declined',
      resolvedById: ADMIN_2,
      resolvedProductId: null,
    });
  });

  it('answers 404 for an unknown id', async () => {
    const { status, body } = await patch(REQ, { outcome: 'declined', reason: 'No.' });
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  describe('the seat is gone', () => {
    it.each([
      ['banned', { bannedAt: '2026-10-15T00:00:00.000Z' }],
      ['moved to another vendor', { vendorId: null }],
      ['no longer a vendor_admin', { role: 'reviewer' }],
    ] as const)(
      'sends no email when the seat is %s, and the portal row still lands',
      async (_l, set) => {
        await t.db.insert(productRequests).values(row());
        await t.db.update(profiles).set(set).where(eq(profiles.id, SEAT));
        expect((await patch(REQ, { outcome: 'declined', reason: 'No.' })).status).toBe(200);
        expect(sendDecided).not.toHaveBeenCalled();
        expect(fetchSeatEmails).not.toHaveBeenCalled();
        expect(await feed()).toHaveLength(1);
      },
    );

    it('sends no email when the auth seam has no address for the seat', async () => {
      await t.db.insert(productRequests).values(row());
      fetchSeatEmails.mockResolvedValue(new Map());
      expect((await patch(REQ, { outcome: 'declined', reason: 'No.' })).status).toBe(200);
      expect(fetchSeatEmails).toHaveBeenCalledWith(expect.anything(), [SEAT]);
      expect(sendDecided).not.toHaveBeenCalled();
    });

    it('still answers 200 when the email throws (fail-open)', async () => {
      await t.db.insert(productRequests).values(row());
      sendDecided.mockRejectedValue(new Error('boom'));
      expect((await patch(REQ, { outcome: 'declined', reason: 'No.' })).status).toBe(200);
    });
  });
});

describe('pending_requests (AECI-1377)', () => {
  it('adds open product requests to the Requests badge, and never decided ones', async () => {
    await t.db
      .insert(productRequests)
      .values([row(), row({ id: REQ_B, status: 'added', resolvedProductId: P_PROMOTED })]);
    const counts = await readAdminQueueCounts(t.db);
    expect(counts.pending_requests).toBe(1);
    expect(counts.pending_claims).toBe(0);
  });
});
