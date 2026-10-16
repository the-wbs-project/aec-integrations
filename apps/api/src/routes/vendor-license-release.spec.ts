/**
 * `POST /api/vendor/licenses/:id/release-request` (AECI-1373, E4.4): an owner seat
 * asks AECi to free a license early, against the in-memory D1 harness. A stub
 * middleware sets the `auth` Variable for the handler cases; the last describe runs
 * the REAL `requireVendor()` guard with signed JWTs.
 */

import { ApiErrorCode, CreateLicenseReleaseRequestResponseSchema } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  licenseReleaseRequests,
  licenses,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireVendor, type AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { racingFactory } from '../test/racing-factory';
import { createVendorLicenseReleaseRequestHandler } from './vendor-license-release';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const OTHER = u(2);
const OWNER = u(100);
const MEMBER = u(101);
const OTHER_OWNER = u(102);
const PRODUCT = u(10);
const OLD_TS = '2020-01-01T00:00:00.000Z';

const seat = (userId: string, vendorId: string): AuthzVariables['auth'] => ({
  userId,
  email: `${userId.slice(-3)}@bentley.example`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});

let t: TestDb;
let licenseId: string;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'bentley', companyName: 'Bentley' },
    { id: OTHER, slug: 'autodesk', companyName: 'Autodesk' },
  ]);
  await t.db.insert(products).values({
    id: PRODUCT,
    slug: 'microstation',
    name: 'MicroStation',
    promotionStatus: 'promoted',
  });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR },
    { id: OTHER_OWNER, role: 'vendor_admin', vendorId: OTHER, seatOwner: true },
  ]);
  licenseId = await seedLicense(t.db, VENDOR, {
    productId: PRODUCT,
    source: 'invoice',
    endsAt: '2027-06-30T00:00:00.000Z',
  });
});
afterEach(() => {
  t.dispose();
  vi.unstubAllGlobals();
});

function app(auth: AuthzVariables['auth'], factory: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post(
    '/api/vendor/licenses/:id/release-request',
    createVendorLicenseReleaseRequestHandler(factory),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function post(
  id: string,
  body: unknown = { reason: 'We retired MicroStation for OpenRoads.' },
  opts: { auth?: AuthzVariables['auth']; env?: Partial<Env>; factory?: DbFactory } = {},
) {
  const execCtx = fakeExecutionContext();
  const res = await app(opts.auth ?? seat(OWNER, VENDOR), opts.factory).request(
    `/api/vendor/licenses/${id}/release-request`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    { ...TEST_ENV, ...opts.env },
    execCtx,
  );
  const json = (await res.json()) as JsonBody;
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
  return { status: res.status, body: json };
}

const readRequests = () => t.db.select().from(licenseReleaseRequests);
const readAudit = () => t.db.select().from(auditLog);

describe('POST /api/vendor/licenses/:id/release-request', () => {
  it('saves an open request and its audit row in one batch, and touches no license', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    const { status, body } = await post(licenseId);
    expect(status).toBe(201);
    const parsed = CreateLicenseReleaseRequestResponseSchema.parse(body);
    expect(parsed.request).toMatchObject({
      license_id: licenseId,
      product_id: PRODUCT,
      status: 'open',
      reason: 'We retired MicroStation for OpenRoads.',
      decided_at: null,
      decision_note: null,
    });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
    batch.mockRestore();

    const [row] = await readRequests();
    const accountId = await seedBillingAccount(t.db, VENDOR);
    expect(row).toMatchObject({
      id: parsed.request.id,
      licenseId,
      vendorId: VENDOR,
      billingAccountId: accountId,
      productId: PRODUCT,
      requestedBy: OWNER,
      status: 'open',
    });

    const audits = await readAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'license.release_requested',
      entityType: 'billing_account',
      entityId: accountId,
      actorId: OWNER,
      vendorId: VENDOR,
      productId: PRODUCT,
    });
    expect(audits[0]!.metadata).toMatchObject({
      source: 'vendor-portal',
      license_id: licenseId,
      request_id: parsed.request.id,
    });
    // The typed reason stays on the row: the forward leaves the Worker.
    expect(JSON.stringify(audits[0]!.metadata)).not.toContain('OpenRoads');

    const [license] = await t.db.select().from(licenses);
    expect(license!.assignedProductId).toBe(PRODUCT);
  });

  it('403s a member seat and writes nothing', async () => {
    const { status, body } = await post(licenseId, undefined, { auth: seat(MEMBER, VENDOR) });
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.FORBIDDEN);
    expect(await readRequests()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
  });

  it("404s another vendor's license, the same as an unknown id", async () => {
    const theirs = await seedLicense(t.db, OTHER, { productId: null });
    for (const id of [theirs, u(999)]) {
      const { status, body } = await post(id, undefined, { auth: seat(OWNER, VENDOR) });
      expect(status).toBe(404);
      expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    }
    // And the other vendor's owner cannot reach ours.
    const { status } = await post(licenseId, undefined, { auth: seat(OTHER_OWNER, OTHER) });
    expect(status).toBe(404);
    expect(await readRequests()).toHaveLength(0);
  });

  it.each([
    ['unassigned', { productId: null }],
    ['ended', { productId: null, endedAt: OLD_TS, endReason: 'lapsed' }],
  ] as const)('409s an %s license with LICENSE_NOT_ASSIGNED', async (_label, seed) => {
    const id = await seedLicense(t.db, VENDOR, seed);
    const { status, body } = await post(id);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_NOT_ASSIGNED);
    expect(await readRequests()).toHaveLength(0);
  });

  it('409s RELEASE_REQUEST_OPEN while one is open, and allows a new one once decided', async () => {
    const first = await post(licenseId);
    expect(first.status).toBe(201);
    const second = await post(licenseId);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe(ApiErrorCode.RELEASE_REQUEST_OPEN);
    expect(second.body.error.details.request_id).toBe(first.body.request.id);

    await t.db.update(licenseReleaseRequests).set({ status: 'declined' });
    expect((await post(licenseId)).status).toBe(201);
    expect(await readRequests()).toHaveLength(2);
  });

  it('maps a lost race on the partial unique index to the same 409, writing nothing', async () => {
    const winner = u(777);
    const factory = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      const accountId = await seedBillingAccount(t.db, VENDOR);
      await t.db.insert(licenseReleaseRequests).values({
        id: winner,
        licenseId,
        vendorId: VENDOR,
        billingAccountId: accountId,
        productId: PRODUCT,
        requestedBy: OWNER,
        reason: 'First',
      });
    });
    const { status, body } = await post(licenseId, undefined, { factory });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.RELEASE_REQUEST_OPEN);
    expect(body.error.details.request_id).toBe(winner);
    expect(await readRequests()).toHaveLength(1);
    expect(await readAudit()).toHaveLength(0);
  });

  it.each([
    ['a missing reason', {}],
    ['a blank reason', { reason: '   ' }],
    ['an unknown key', { reason: 'ok', extra: 1 }],
    ['a reason over 1,000 characters', { reason: 'x'.repeat(1001) }],
  ])('400s %s', async (_label, body) => {
    const { status } = await post(licenseId, body);
    expect(status).toBe(400);
    expect(await readRequests()).toHaveLength(0);
  });

  it('emails SUPPORT_EMAIL after commit, reply-to the seat', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{"id":"re_1"}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { status } = await post(licenseId, undefined, {
      env: {
        RESEND_API_KEY: 'rk_test',
        EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
        SUPPORT_EMAIL: 'support@aecintegrations.com',
      },
    });
    expect(status).toBe(201);
    const resend = fetchMock.mock.calls.filter(([url]) => String(url).includes('resend'));
    expect(resend).toHaveLength(1);
    const sent = JSON.parse(String(resend[0]![1]!.body)) as {
      to: string | string[];
      subject: string;
      text: string;
      reply_to?: string;
    };
    expect(String(sent.to)).toContain('support@aecintegrations.com');
    expect(sent.subject).toContain('[AECi] Early unassign request: Bentley, MicroStation');
    expect(sent.reply_to).toBe(seat(OWNER, VENDOR).email);
    expect(sent.text).toContain('We retired MicroStation for OpenRoads.');
  });

  it('still answers 201 when the alert send fails (fail-open)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const { status } = await post(licenseId, undefined, {
      env: {
        RESEND_API_KEY: 'rk_test',
        EMAIL_FROM: 'AEC Integrations <notifications@aecintegrations.com>',
        SUPPORT_EMAIL: 'support@aecintegrations.com',
      },
    });
    expect(status).toBe(201);
    expect(await readRequests()).toHaveLength(1);
  });
});

describe('authorization (the real requireVendor guard)', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'staging', SUPABASE_URL } as Env;

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guardedApp() {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.post(
      '/api/vendor/licenses/:id/release-request',
      requireVendor({ getKey: jwks.getKey, dbFor: t.factory }),
      createVendorLicenseReleaseRequestHandler(t.factory),
    );
    return a;
  }

  const call = (token?: string) =>
    guardedApp().request(
      `/api/vendor/licenses/${licenseId}/release-request`,
      {
        method: 'POST',
        body: JSON.stringify({ reason: 'Retired' }),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  it('401s with no token', async () => {
    expect((await call()).status).toBe(401);
    expect(await readRequests()).toHaveLength(0);
  });

  it('403s a plain reviewer', async () => {
    await t.db.insert(profiles).values({ id: u(910), role: 'reviewer' });
    const token = await jwks.mintToken({ sub: u(910), supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
  });

  it('403s an admin: the vendor surface is for seats', async () => {
    await t.db.insert(profiles).values({ id: u(911), role: 'admin' });
    const token = await jwks.mintToken({ sub: u(911), supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
  });

  it('403s a banned owner seat', async () => {
    await t.db.insert(profiles).values({
      id: u(912),
      role: 'vendor_admin',
      vendorId: VENDOR,
      seatOwner: true,
      bannedAt: OLD_TS,
    });
    const token = await jwks.mintToken({ sub: u(912), supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect(await readRequests()).toHaveLength(0);
  });

  it('403s a member seat', async () => {
    const token = await jwks.mintToken({ sub: MEMBER, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
  });

  it('201s an owner seat', async () => {
    const token = await jwks.mintToken({ sub: OWNER, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(201);
    expect(await readRequests()).toHaveLength(1);
  });
});
