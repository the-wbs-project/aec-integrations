/**
 * The admin early-unassign queue (AECI-1373, E4.4; `ADMIN_PANEL_SPEC.md` §5.17)
 * against the in-memory D1 harness. A stub middleware sets the `auth` Variable for the
 * handler cases; the last describe runs the REAL `requireAdmin()` guard on both routes.
 *
 * Covers: the list and its filter, an approve (the license stays live, unassigned, term
 * dates unchanged, purge, portal row), a decline (reason required, portal row), the 409
 * on a decided row, both lost races rolling back whole, the license moving under an
 * approve, and the Requests badge.
 */

import {
  AdminLicenseReleaseRequestSchema,
  ApiErrorCode,
  ListLicenseReleaseRequestsResponseSchema,
  ListVendorNotificationsResponseSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  licenseReleaseRequests,
  licenses,
  products,
  productVendors,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { readAdminQueueCounts } from '../lib/admin-queue-counts';
import { NOTIFICATION_SENT_ACTION } from '../lib/attestation-notify';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { racingFactory } from '../test/racing-factory';
import {
  createAdminLicenseReleaseRequestsListHandler,
  createDecideLicenseReleaseRequestHandler,
} from './admin-license-release-requests';
import { createListVendorNotificationsHandler } from './vendor-notifications';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const ADMIN_2 = u(901);
const VENDOR = u(1);
const OWNER = u(100);
const PRODUCT = u(10);
const OTHER_PRODUCT = u(11);
const REQ = u(20);
const REQ_B = u(21);
const OLD_TS = '2020-01-01T00:00:00.000Z';
const ENDS = '2027-06-30T00:00:00.000Z';

let t: TestDb;
let licenseId: string;
let accountId: string;
let queueSend: ReturnType<typeof vi.fn>;

const ENV = () =>
  ({
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send: (...a: unknown[]) => queueSend(...a) },
  }) as unknown as Env;

beforeEach(async () => {
  t = await makeTestDb();
  queueSend = vi.fn(async () => undefined);
  await t.db.insert(profiles).values([
    { id: ADMIN, role: 'admin' },
    { id: ADMIN_2, role: 'admin' },
  ]);
  await t.db
    .insert(vendors)
    .values({ id: VENDOR, slug: 'bentley', companyName: 'Bentley', verified: true });
  await t.db.insert(profiles).values({
    id: OWNER,
    role: 'vendor_admin',
    vendorId: VENDOR,
    seatOwner: true,
  });
  await t.db.insert(products).values([
    { id: PRODUCT, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' },
    { id: OTHER_PRODUCT, slug: 'openroads', name: 'OpenRoads', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: PRODUCT, vendorId: VENDOR, isPrimary: true },
    { productId: OTHER_PRODUCT, vendorId: VENDOR, isPrimary: true },
  ]);
  licenseId = await seedLicense(t.db, VENDOR, {
    productId: PRODUCT,
    source: 'invoice',
    endsAt: ENDS,
  });
  accountId = await seedBillingAccount(t.db, VENDOR);
  await t.db.update(licenses).set({ releaseAtRenewal: true }).where(eq(licenses.id, licenseId));
});
afterEach(() => t.dispose());

function request(o: Partial<typeof licenseReleaseRequests.$inferInsert> = {}) {
  return {
    id: REQ,
    licenseId,
    vendorId: VENDOR,
    billingAccountId: accountId,
    productId: PRODUCT,
    requestedBy: OWNER,
    reason: 'We retired MicroStation.',
    status: 'open',
    createdAt: '2026-10-15T08:00:00.000Z',
    updatedAt: '2026-10-15T08:00:00.000Z',
    ...o,
  } satisfies typeof licenseReleaseRequests.$inferInsert;
}

function app(factory: DbFactory = t.factory, admin = ADMIN) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('/api/admin/*', async (c, next) => {
    c.set('auth', {
      userId: admin,
      email: 'admin@aeci.test',
      role: 'admin',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  a.use('/api/vendor/*', async (c, next) => {
    c.set('auth', {
      userId: OWNER,
      email: 'owner@bentley.example',
      role: 'vendor_admin',
      vendorId: VENDOR,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  a.get(
    '/api/admin/license-release-requests',
    createAdminLicenseReleaseRequestsListHandler(factory),
  );
  a.patch(
    '/api/admin/license-release-requests/:id',
    createDecideLicenseReleaseRequestHandler(factory),
  );
  a.get('/api/vendor/notifications', createListVendorNotificationsHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function patch(id: string, body: unknown, factory?: DbFactory) {
  const execCtx = fakeExecutionContext();
  const res = await app(factory).request(
    `/api/admin/license-release-requests/${id}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    ENV(),
    execCtx,
  );
  const json = (await res.json()) as JsonBody;
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
  return { status: res.status, body: json };
}

const list = async (qs = '') =>
  (
    await app().request(
      `/api/admin/license-release-requests${qs}`,
      {},
      ENV(),
      fakeExecutionContext(),
    )
  ).json() as Promise<JsonBody>;

const feed = async () =>
  ListVendorNotificationsResponseSchema.parse(
    await (
      await app().request('/api/vendor/notifications', {}, ENV(), fakeExecutionContext())
    ).json(),
  ).notifications;

const readLicense = async () =>
  (await t.db.select().from(licenses).where(eq(licenses.id, licenseId)))[0]!;
const readRequest = async (id = REQ) =>
  (await t.db.select().from(licenseReleaseRequests).where(eq(licenseReleaseRequests.id, id)))[0]!;
const readAudit = () => t.db.select().from(auditLog);

describe('GET /api/admin/license-release-requests', () => {
  it('lists open requests newest first, with the vendor, product and current license', async () => {
    await t.db.insert(licenseReleaseRequests).values([
      request(),
      request({
        id: REQ_B,
        status: 'declined',
        decisionNote: 'No.',
        createdAt: '2026-10-15T09:00:00.000Z',
      }),
    ]);
    const parsed = ListLicenseReleaseRequestsResponseSchema.parse(await list());
    expect(parsed.total).toBe(1);
    expect(parsed.data[0]).toMatchObject({
      id: REQ,
      status: 'open',
      license_id: licenseId,
      vendor: { id: VENDOR, slug: 'bentley', name: 'Bentley' },
      billing_account_id: accountId,
      product: { id: PRODUCT, slug: 'microstation', name: 'MicroStation' },
      requested_by: OWNER,
      reason: 'We retired MicroStation.',
      license: { source: 'invoice', ends_at: ENDS, ended_at: null, assigned_product_id: PRODUCT },
    });
    const declined = ListLicenseReleaseRequestsResponseSchema.parse(await list('?status=declined'));
    expect(declined.data.map((r) => r.id)).toEqual([REQ_B]);
    expect(declined.data[0]!.decision_note).toBe('No.');
  });

  it('pages, and 400s an unknown status', async () => {
    await t.db.insert(licenseReleaseRequests).values(request());
    const paged = ListLicenseReleaseRequestsResponseSchema.parse(await list('?perPage=1&page=2'));
    expect(paged).toMatchObject({ data: [], page: 2, perPage: 1, total: 1 });
    const res = await app().request(
      '/api/admin/license-release-requests?status=bogus',
      {},
      ENV(),
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/admin/license-release-requests/:id: approve', () => {
  it('frees the license in one batch: still live, term dates unchanged, purge and a notice', async () => {
    await t.db.insert(licenseReleaseRequests).values(request());
    const before = await readLicense();
    const batch = vi.spyOn(t.db, 'batch');
    const { status, body } = await patch(REQ, { action: 'approve' });
    expect(status).toBe(200);
    const parsed = AdminLicenseReleaseRequestSchema.parse(body);
    expect(parsed).toMatchObject({
      status: 'approved',
      decided_by: ADMIN,
      decision_note: null,
      license: { assigned_product_id: null, ended_at: null },
    });
    expect(batch).toHaveBeenCalledTimes(1);
    // request UPDATE, sentinel, license UPDATE, sentinel, audit, reconcile, notice.
    expect(batch.mock.calls[0]![0]).toHaveLength(7);
    batch.mockRestore();

    const after = await readLicense();
    expect(after).toMatchObject({
      assignedProductId: null,
      assignedAt: null,
      endedAt: null,
      endReason: null,
      releaseAtRenewal: false,
      startsAt: before.startsAt,
      endsAt: before.endsAt,
      source: 'invoice',
    });

    const audits = await readAudit();
    expect(audits.map((a) => a.action).sort()).toEqual(
      ['license.release_approved', NOTIFICATION_SENT_ACTION].sort(),
    );
    const approved = audits.find((a) => a.action === 'license.release_approved')!;
    expect(approved).toMatchObject({
      entityType: 'billing_account',
      entityId: accountId,
      actorId: ADMIN,
      vendorId: VENDOR,
      productId: PRODUCT,
    });
    expect(approved.metadata).toMatchObject({ license_id: licenseId, request_id: REQ });
    const notice = audits.find((a) => a.action === NOTIFICATION_SENT_ACTION)!;
    expect(notice).toMatchObject({ vendorId: VENDOR, entityType: 'billing_account' });
    expect(notice.metadata).toMatchObject({
      kind: 'aeci_override',
      notificationId: 'portal-license-release-approved-by-aeci',
      event: 'license_release_approved',
      reason: 'We retired MicroStation.',
      recordSubject: { type: 'product', slug: 'microstation', name: 'MicroStation' },
    });

    expect(queueSend).toHaveBeenCalledWith({
      tags: ['product:microstation', 'index:products', 'vendor:bentley'],
      source: 'moderation',
    });

    const items = await feed();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'aeci_override',
      event: 'license_release_approved',
      record_subject: { type: 'product', slug: 'microstation', name: 'MicroStation' },
    });
  });

  it('409s RELEASE_REQUEST_NOT_OPEN on a decided row, writing nothing', async () => {
    await t.db.insert(licenseReleaseRequests).values(request({ status: 'declined' }));
    const { status, body } = await patch(REQ, { action: 'approve' });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.RELEASE_REQUEST_NOT_OPEN);
    expect((await readLicense()).assignedProductId).toBe(PRODUCT);
    expect(await readAudit()).toHaveLength(0);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('a lost race with another admin rolls back whole and answers RELEASE_REQUEST_NOT_OPEN', async () => {
    await t.db.insert(licenseReleaseRequests).values(request());
    const factory = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db
        .update(licenseReleaseRequests)
        .set({ status: 'declined', decidedBy: ADMIN_2, decisionNote: 'Mine.' })
        .where(eq(licenseReleaseRequests.id, REQ));
    });
    const { status, body } = await patch(REQ, { action: 'approve' }, factory);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.RELEASE_REQUEST_NOT_OPEN);
    expect((await readLicense()).assignedProductId).toBe(PRODUCT);
    expect(await readAudit()).toHaveLength(0);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it.each([
    ['unassigned', { assignedProductId: null, assignedAt: null }],
    ['ended', { endedAt: OLD_TS, endReason: 'revoked' }],
    ['moved to another product', { assignedProductId: OTHER_PRODUCT }],
  ] as const)(
    '409s LICENSE_NOT_ASSIGNED when the license was %s before the read',
    async (_label, change) => {
      await t.db.insert(licenseReleaseRequests).values(request());
      await t.db.update(licenses).set(change).where(eq(licenses.id, licenseId));
      const { status, body } = await patch(REQ, { action: 'approve' });
      expect(status).toBe(409);
      expect(body.error.code).toBe(ApiErrorCode.LICENSE_NOT_ASSIGNED);
      expect((await readRequest()).status).toBe('open');
      expect(await readAudit()).toHaveLength(0);
    },
  );

  it('rolls back whole when the license ends between the read and the batch', async () => {
    await t.db.insert(licenseReleaseRequests).values(request());
    const factory = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db
        .update(licenses)
        .set({ endedAt: OLD_TS, endReason: 'revoked' })
        .where(eq(licenses.id, licenseId));
    });
    const { status, body } = await patch(REQ, { action: 'approve' }, factory);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_NOT_ASSIGNED);
    expect((await readRequest()).status).toBe('open');
    expect(await readAudit()).toHaveLength(0);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('404s an unknown request', async () => {
    const { status } = await patch(u(999), { action: 'approve' });
    expect(status).toBe(404);
  });
});

describe('PATCH /api/admin/license-release-requests/:id: decline', () => {
  it('records the reason and a notice, and leaves the license and the cache alone', async () => {
    await t.db.insert(licenseReleaseRequests).values(request());
    const batch = vi.spyOn(t.db, 'batch');
    const { status, body } = await patch(REQ, {
      action: 'decline',
      reason: '  Not before renewal.  ',
    });
    expect(status).toBe(200);
    expect(AdminLicenseReleaseRequestSchema.parse(body)).toMatchObject({
      status: 'declined',
      decided_by: ADMIN,
      decision_note: 'Not before renewal.',
    });
    // request UPDATE, sentinel, audit, notice.
    expect(batch.mock.calls[0]![0]).toHaveLength(4);
    batch.mockRestore();

    expect(await readRequest()).toMatchObject({
      status: 'declined',
      decidedBy: ADMIN,
      decisionNote: 'Not before renewal.',
    });
    expect((await readLicense()).assignedProductId).toBe(PRODUCT);

    const audits = await readAudit();
    const declined = audits.find((a) => a.action === 'license.release_declined')!;
    expect(declined).toMatchObject({
      entityType: 'billing_account',
      entityId: accountId,
      vendorId: VENDOR,
      productId: PRODUCT,
      vendorTier: 'verified',
      vendorEntitlementStatus: 'active',
    });
    expect(declined.metadata).toMatchObject({ license_id: licenseId, request_id: REQ });
    const notice = audits.find((a) => a.action === NOTIFICATION_SENT_ACTION)!;
    expect(notice.metadata).toMatchObject({
      notificationId: 'portal-license-release-declined-by-aeci',
      event: 'license_release_declined',
      reason: 'Not before renewal.',
    });
    expect(queueSend).not.toHaveBeenCalled();

    const [item] = await feed();
    expect(item).toMatchObject({
      event: 'license_release_declined',
      reason: 'Not before renewal.',
    });
  });

  it.each([
    ['no reason', { action: 'decline' }],
    ['a blank reason', { action: 'decline', reason: '   ' }],
    ['an unknown action', { action: 'release' }],
    ['a reason on an approve', { action: 'approve', reason: 'x' }],
  ])('400s %s and writes nothing', async (_label, body) => {
    await t.db.insert(licenseReleaseRequests).values(request());
    const { status } = await patch(REQ, body);
    expect(status).toBe(400);
    expect((await readRequest()).status).toBe('open');
    expect(await readAudit()).toHaveLength(0);
  });
});

describe('the Requests badge', () => {
  it('counts open release requests, and a decision takes one off', async () => {
    await t.db
      .insert(licenseReleaseRequests)
      .values([request(), request({ id: REQ_B, status: 'approved' })]);
    expect((await readAdminQueueCounts(t.db)).pending_requests).toBe(1);
    await patch(REQ, { action: 'decline', reason: 'No.' });
    expect((await readAdminQueueCounts(t.db)).pending_requests).toBe(0);
  });
});

describe('authorization (the real requireAdmin guard)', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'staging', SUPABASE_URL } as Env;

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guardedApp() {
    const guard = requireAdmin({ getKey: jwks.getKey, dbFor: t.factory });
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.get(
      '/api/admin/license-release-requests',
      guard,
      createAdminLicenseReleaseRequestsListHandler(t.factory),
    );
    a.patch(
      '/api/admin/license-release-requests/:id',
      guard,
      createDecideLicenseReleaseRequestHandler(t.factory),
    );
    return a;
  }

  const call = (method: 'GET' | 'PATCH', token?: string) =>
    guardedApp().request(
      method === 'GET'
        ? '/api/admin/license-release-requests'
        : `/api/admin/license-release-requests/${REQ}`,
      {
        method,
        ...(method === 'PATCH'
          ? { body: JSON.stringify({ action: 'decline', reason: 'No.' }) }
          : {}),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  beforeEach(async () => {
    await t.db.insert(licenseReleaseRequests).values(request());
  });

  for (const method of ['GET', 'PATCH'] as const) {
    it(`${method}: 401s with no token`, async () => {
      expect((await call(method)).status).toBe(401);
    });

    it(`${method}: 403s a plain reviewer`, async () => {
      await t.db.insert(profiles).values({ id: u(910), role: 'reviewer' });
      const token = await jwks.mintToken({ sub: u(910), supabaseUrl: SUPABASE_URL });
      expect((await call(method, token)).status).toBe(403);
    });

    it(`${method}: 403s the vendor's own owner seat`, async () => {
      const token = await jwks.mintToken({ sub: OWNER, supabaseUrl: SUPABASE_URL });
      expect((await call(method, token)).status).toBe(403);
    });

    it(`${method}: 403s a banned admin`, async () => {
      await t.db.insert(profiles).values({ id: u(911), role: 'admin', bannedAt: OLD_TS });
      const token = await jwks.mintToken({ sub: u(911), supabaseUrl: SUPABASE_URL });
      expect((await call(method, token)).status).toBe(403);
    });

    it(`${method}: 200s an admin`, async () => {
      const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
      expect((await call(method, token)).status).toBe(200);
    });
  }

  it('a refused PATCH writes nothing', async () => {
    await call('PATCH');
    expect((await readRequest()).status).toBe('open');
    expect(await readAudit()).toHaveLength(0);
  });
});
