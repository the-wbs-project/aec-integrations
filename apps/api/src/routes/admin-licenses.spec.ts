/**
 * `POST /api/admin/vendors/:id/licenses` (AECI-1370, E4.1): the admin license grant,
 * against the in-memory D1 harness. Authorization runs against the REAL
 * `requireAdmin()` guard in the last describe.
 */

import { ApiErrorCode } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  billingAccounts,
  licenses,
  products,
  productVendors,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { URL_NAMESPACE, uuidv5 } from '../lib/backfill-licenses';
import type { DbFactory } from '../lib/handler-utils';
import { recipientHash } from '../lib/hash';
import { logToPosthog } from '../posthog';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { racingFactory } from '../test/racing-factory';
import {
  LICENSE_GRANT_NAMESPACE,
  createGrantLicensesHandler,
  grantLicenseIds,
  licensesGrantedDedupeKey,
  type SendLicensesGranted,
} from './admin-licenses';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const VENDOR = u(1);
const OTHER_VENDOR = u(2);
const SEAT_A = u(500);
const SEAT_B = u(501);
const BANNED_SEAT = u(502);
const GRANT = '11111111-1111-4111-8111-111111111111';
const OLD_TS = '2020-01-01T00:00:00.000Z';
const END = '2027-06-30';
const END_ISO = '2027-06-30T00:00:00.000Z';

let t: TestDb;
let fetchSeatEmails: ReturnType<typeof vi.fn>;
let sendGranted: ReturnType<typeof vi.fn>;
let queueSend: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(logToPosthog).mockClear();
  fetchSeatEmails = vi.fn(
    async (_env: Env, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, `seat-${id.slice(-3)}@bentley.example`])),
  );
  sendGranted = vi.fn(async () => 'sent' as const);
  queueSend = vi.fn(async () => undefined);
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'bentley', companyName: 'Bentley', verified: false, updatedAt: OLD_TS },
    { id: OTHER_VENDOR, slug: 'other', companyName: 'Other', verified: false },
  ]);
});
afterEach(() => t.dispose());

const ENV = {
  ...TEST_ENV,
  CACHE_PURGE_QUEUE: { send: (...a: unknown[]) => queueSend(...a) },
} as unknown as Env;

function app(factory: DbFactory = t.factory) {
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
  a.post(
    '/api/admin/vendors/:id/licenses',
    createGrantLicensesHandler(
      factory,
      fetchSeatEmails,
      sendGranted as unknown as SendLicensesGranted,
    ),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function post(vendorId: string, body: unknown, factory?: DbFactory) {
  const execCtx = fakeExecutionContext();
  const res = await app(factory).request(
    `/api/admin/vendors/${vendorId}/licenses`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
    ENV,
    execCtx,
  );
  const json = (await res.json()) as JsonBody;
  // Settle every post-commit hook, so "no email" is asserted after it had its chance.
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
  return { status: res.status, body: json };
}

const grant = (over: Record<string, unknown> = {}) => ({
  grant_id: GRANT,
  quantity: 2,
  source: 'complimentary',
  ends_at: END,
  ...over,
});

const readLicenses = () => t.db.select().from(licenses);
const readAudit = () => t.db.select().from(auditLog);

async function seedSeats() {
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR },
    { id: BANNED_SEAT, role: 'vendor_admin', vendorId: VENDOR, bannedAt: OLD_TS },
  ]);
}

describe('grant ids', () => {
  it('pins the namespace to its derivation', async () => {
    expect(await uuidv5('https://aecintegrations.com/admin/license-grants', URL_NAMESPACE)).toBe(
      LICENSE_GRANT_NAMESPACE,
    );
  });

  it('derives one stable UUID per license, case-insensitive on the grant id', async () => {
    const ids = await grantLicenseIds(GRANT, 3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await grantLicenseIds(GRANT.toUpperCase(), 3)).toEqual(ids);
  });
});

describe('POST /api/admin/vendors/:id/licenses: the grant', () => {
  it('writes N unassigned licenses and N audit rows in one batch', async () => {
    const accountId = await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await post(VENDOR, grant({ notes: 'Pilot cohort 1' }));
    expect(status).toBe(201);
    const ids = await grantLicenseIds(GRANT, 2);
    expect(body).toMatchObject({
      vendor_id: VENDOR,
      billing_account_id: accountId,
      grant_id: GRANT,
      replayed: false,
      warnings: [],
    });
    expect(body.licenses.map((l: JsonBody) => l.id)).toEqual(ids);

    const rows = await readLicenses();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        billingAccountId: accountId,
        source: 'complimentary',
        endsAt: END_ISO,
        endedAt: null,
        reference: null,
        assignedProductId: null,
        grantedBy: ADMIN,
      });
    }

    const audits = await readAudit();
    expect(audits).toHaveLength(2);
    for (const [i, audit] of audits.entries()) {
      expect(audit).toMatchObject({
        action: 'license.granted',
        entityType: 'billing_account',
        entityId: accountId,
        vendorId: VENDOR,
        productId: null,
        actorId: ADMIN,
        actorType: 'admin',
      });
      expect(audit.metadata).toMatchObject({
        license_id: ids[i],
        grant_id: GRANT,
        notes: 'Pilot cohort 1',
      });
    }
  });

  it('moves the verified mirror on a first grant, and purges the vendor tags', async () => {
    await seedBillingAccount(t.db, VENDOR);
    await post(VENDOR, grant());
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(true);
    expect(queueSend).toHaveBeenCalledWith({ tags: ['vendor:bentley'], source: 'moderation' });
  });

  it('purges nothing when the vendor already holds a live license', async () => {
    await seedLicense(t.db, VENDOR);
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR));
    const { status } = await post(VENDOR, grant());
    expect(status).toBe(201);
    expect(queueSend).not.toHaveBeenCalled();
    expect(await readLicenses()).toHaveLength(3);
  });

  it('records an invoice grant with its reference and an explicit start', async () => {
    await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await post(
      VENDOR,
      grant({ source: 'invoice', reference: ' PO-77 ', starts_at: '2026-11-01', quantity: 1 }),
    );
    expect(status).toBe(201);
    expect(body.licenses[0]).toMatchObject({
      source: 'invoice',
      reference: 'PO-77',
      starts_at: '2026-11-01T00:00:00.000Z',
      ends_at: END_ISO,
      assigned_product_id: null,
    });
    const [row] = await readLicenses();
    expect(row).toMatchObject({ source: 'invoice', reference: 'PO-77' });
  });

  it('lists the grant on the vendor audit trail leg (audit_log.vendor_id)', async () => {
    await seedBillingAccount(t.db, VENDOR);
    await post(VENDOR, grant());
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.vendorId, VENDOR));
    expect(rows.map((r) => r.action)).toEqual(['license.granted', 'license.granted']);
  });
});

describe('validation: 400 and nothing written', () => {
  beforeEach(async () => {
    await seedBillingAccount(t.db, VENDOR);
  });

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['a missing end date', { ends_at: undefined }, 'ends_at'],
    ['an invoice with no reference', { source: 'invoice' }, 'reference'],
    ['an invoice with a blank reference', { source: 'invoice', reference: '   ' }, 'reference'],
    ['a quantity of 0', { quantity: 0 }, 'quantity'],
    ['a quantity over 50', { quantity: 51 }, 'quantity'],
    ['a non-integer quantity', { quantity: 1.5 }, 'quantity'],
    ['source stripe', { source: 'stripe' }, 'source'],
    ['a grant id that is not a uuid', { grant_id: 'abc' }, 'grant_id'],
    ['an end on the start', { starts_at: '2027-01-01', ends_at: '2027-01-01' }, 'ends_at'],
    ['an end before the start', { starts_at: '2027-01-02', ends_at: '2027-01-01' }, 'ends_at'],
    ['an end in the past with the default start', { ends_at: '2020-01-01' }, 'ends_at'],
  ];

  it.each(cases)('rejects %s', async (_label, over, field) => {
    const { status, body } = await post(VENDOR, grant(over));
    expect(status).toBe(400);
    expect(body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect(body.error.field).toBe(field);
    expect(await readLicenses()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
    expect(sendGranted).not.toHaveBeenCalled();
  });

  it('compares the dates as instants: a date-only end after a timestamp start passes', async () => {
    const { status } = await post(
      VENDOR,
      grant({ starts_at: '2027-06-29T23:59:59.000Z', ends_at: '2027-06-30' }),
    );
    expect(status).toBe(201);
  });

  it('400s a body that is not JSON', async () => {
    const { status, body } = await post(VENDOR, '{not json');
    expect(status).toBe(400);
    expect(body.error.code).toBe(ApiErrorCode.MALFORMED_REQUEST);
  });
});

describe('404s', () => {
  it('404s an unknown vendor', async () => {
    const { status, body } = await post(u(77), grant());
    expect(status).toBe(404);
    expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    expect(body.error.details).toMatchObject({ resource: 'vendor' });
  });

  it('404s a vendor with no billing account, writing nothing', async () => {
    const { status, body } = await post(VENDOR, grant());
    expect(status).toBe(404);
    expect(body.error.details).toMatchObject({ resource: 'billing_account', id: VENDOR });
    expect(await readLicenses()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
  });
});

describe('idempotency on grant_id', () => {
  beforeEach(async () => {
    await seedBillingAccount(t.db, VENDOR);
    await seedSeats();
  });

  it('a repeat of the same grant is a 200 replay: nothing written, no email', async () => {
    const first = await post(VENDOR, grant());
    expect(first.status).toBe(201);
    sendGranted.mockClear();

    const again = await post(VENDOR, grant());
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.licenses).toEqual(first.body.licenses);
    expect(await readLicenses()).toHaveLength(2);
    expect(await readAudit()).toHaveLength(2);
    expect(sendGranted).not.toHaveBeenCalled();
  });

  it.each([
    ['a larger quantity', { quantity: 3 }],
    ['a smaller quantity', { quantity: 1 }],
    ['another source', { source: 'invoice', reference: 'PO-1' }],
    ['another end date', { ends_at: '2027-07-01' }],
  ])('409s the same grant id with %s', async (_label, over) => {
    await post(VENDOR, grant());
    sendGranted.mockClear();
    const { status, body } = await post(VENDOR, grant(over));
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_GRANT_CONFLICT);
    expect(await readLicenses()).toHaveLength(2);
    expect(sendGranted).not.toHaveBeenCalled();
  });

  it('409s a grant id already used on another vendor', async () => {
    await seedBillingAccount(t.db, OTHER_VENDOR);
    await post(OTHER_VENDOR, grant());
    const { status, body } = await post(VENDOR, grant());
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_GRANT_CONFLICT);
  });

  it('a grant that loses the race on the license ids is a 409 and writes nothing', async () => {
    const [firstId] = await grantLicenseIds(GRANT, 1);
    const accountId = await seedBillingAccount(t.db, VENDOR);
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db.insert(licenses).values({
        id: firstId!,
        billingAccountId: accountId,
        source: 'complimentary',
        startsAt: OLD_TS,
        endsAt: END_ISO,
      });
    });
    const { status, body } = await post(VENDOR, grant(), racing);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_GRANT_CONFLICT);
    expect(await readLicenses()).toHaveLength(1);
    expect(await readAudit()).toHaveLength(0);
    expect(sendGranted).not.toHaveBeenCalled();
  });
});

describe('connector vendors warn and never gate (AECI-738)', () => {
  beforeEach(async () => {
    await seedBillingAccount(t.db, VENDOR);
  });

  async function ownProduct(id: string, role: string) {
    await t.db
      .insert(products)
      .values({ id, slug: `p-${id.slice(-3)}`, name: id, productRole: role });
    await t.db.insert(productVendors).values({ productId: id, vendorId: VENDOR });
  }

  it('warns when every owned product is a connector, and still grants', async () => {
    await ownProduct(u(30), 'connector');
    await ownProduct(u(31), 'connector');
    const { status, body } = await post(VENDOR, grant());
    expect(status).toBe(201);
    expect(body.warnings).toEqual([expect.objectContaining({ code: 'pure_connector_vendor' })]);
    expect(await readLicenses()).toHaveLength(2);
  });

  it('does not warn when one product is an endpoint', async () => {
    await ownProduct(u(30), 'connector');
    await ownProduct(u(31), 'hybrid');
    const { body } = await post(VENDOR, grant());
    expect(body.warnings).toEqual([]);
  });

  it('does not warn for a vendor with no products (unknown, not exempt)', async () => {
    const { body } = await post(VENDOR, grant());
    expect(body.warnings).toEqual([]);
  });
});

describe('the licenses-granted email', () => {
  beforeEach(async () => {
    await seedBillingAccount(t.db, VENDOR);
  });

  const sentTo = () => sendGranted.mock.calls.map((call) => (call[1] as JsonBody).to);

  it('goes once to every unbanned seat, keyed per address and grant', async () => {
    await seedSeats();
    await post(VENDOR, grant({ source: 'invoice', reference: 'PO-9' }));
    expect(sentTo().sort()).toEqual(['seat-500@bentley.example', 'seat-501@bentley.example']);
    const call = sendGranted.mock.calls[0]![1] as JsonBody;
    expect(call).toMatchObject({
      vendorName: 'Bentley',
      count: 2,
      source: 'invoice',
      endsAt: END_ISO,
      reference: 'PO-9',
      entity: { type: 'billing_account' },
    });
    expect(call.dedupeKey).toBe(await licensesGrantedDedupeKey(GRANT, call.to));
    expect(call.dedupeKey).toBe(`licenses-granted:${GRANT}:${await recipientHash(call.to)}`);
  });

  it('adds the billing email when one is set, and sends a shared address once', async () => {
    await seedSeats();
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: 'SEAT-500@bentley.example' })
      .where(eq(billingAccounts.vendorId, VENDOR));
    await post(VENDOR, grant());
    expect(sentTo()).toHaveLength(2);

    sendGranted.mockClear();
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: 'ap@bentley.example' })
      .where(eq(billingAccounts.vendorId, VENDOR));
    await post(VENDOR, grant({ grant_id: '22222222-2222-4222-8222-222222222222' }));
    expect(sentTo().sort()).toEqual([
      'ap@bentley.example',
      'seat-500@bentley.example',
      'seat-501@bentley.example',
    ]);
  });

  it('still mails the billing email when no seat resolves (no GoTrue creds), and warns', async () => {
    await seedSeats();
    fetchSeatEmails.mockResolvedValue(new Map());
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: 'ap@bentley.example' })
      .where(eq(billingAccounts.vendorId, VENDOR));
    const { status } = await post(VENDOR, grant());
    expect(status).toBe(201);
    expect(sentTo()).toEqual(['ap@bentley.example']);
    expect(vi.mocked(logToPosthog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('no seat') }),
    );
  });

  it('a failing send never fails the response', async () => {
    await seedSeats();
    sendGranted.mockRejectedValue(new Error('resend down'));
    const { status } = await post(VENDOR, grant());
    expect(status).toBe(201);
    expect(await readLicenses()).toHaveLength(2);
  });
});

describe('authorization', () => {
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
      '/api/admin/vendors/:id/licenses',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createGrantLicensesHandler(
        t.factory,
        fetchSeatEmails,
        sendGranted as unknown as SendLicensesGranted,
      ),
    );
    return a;
  }

  const call = (token?: string) =>
    guardedApp().request(
      `/api/admin/vendors/${VENDOR}/licenses`,
      {
        method: 'POST',
        body: JSON.stringify(grant()),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );

  beforeEach(async () => {
    await seedBillingAccount(t.db, VENDOR);
  });

  it('401s with no token', async () => {
    expect((await call()).status).toBe(401);
    expect(await readLicenses()).toHaveLength(0);
  });

  it('403s a plain reviewer', async () => {
    await t.db.insert(profiles).values({ id: u(910), role: 'reviewer' });
    const token = await jwks.mintToken({ sub: u(910), supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect(await readLicenses()).toHaveLength(0);
  });

  it('403s a vendor_admin on the very vendor being granted', async () => {
    await t.db.insert(profiles).values({ id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR });
    const token = await jwks.mintToken({ sub: SEAT_A, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect(await readLicenses()).toHaveLength(0);
  });

  it('403s a banned admin', async () => {
    await t.db.insert(profiles).values({ id: u(911), role: 'admin', bannedAt: OLD_TS });
    const token = await jwks.mintToken({ sub: u(911), supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    expect(await readLicenses()).toHaveLength(0);
  });

  it('201s an admin', async () => {
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(201);
    expect(await readLicenses()).toHaveLength(2);
  });
});
