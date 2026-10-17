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
  integrationFieldChallenges,
  integrations,
  licenses,
  products,
  productVendors,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import { URL_NAMESPACE, uuidv5 } from '../lib/uuidv5';
import type { DbFactory } from '../lib/handler-utils';
import { recipientHash } from '../lib/hash';
import { logToPosthog } from '../posthog';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { loadOwnedProductLicenseState } from '../lib/license';
import { racingFactory, wrappedFactory } from '../test/racing-factory';
import {
  LICENSE_GRANT_NAMESPACE,
  createGrantLicensesHandler,
  createUpdateLicenseHandler,
  grantLicenseIds,
  licensesGrantedDedupeKey,
  managedEndedDedupeKey,
  type SendLicensesGranted,
  type SendManagedEnded,
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
let sendEnded: ReturnType<typeof vi.fn>;
let queueSend: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(logToPosthog).mockClear();
  fetchSeatEmails = vi.fn(
    async (_env: Env, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, `seat-${id.slice(-3)}@bentley.example`])),
  );
  sendGranted = vi.fn(async () => 'sent' as const);
  sendEnded = vi.fn(async () => 'sent' as const);
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
  a.patch(
    '/api/admin/licenses/:id',
    createUpdateLicenseHandler(factory, fetchSeatEmails, sendEnded as unknown as SendManagedEnded),
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

// ─── PATCH /api/admin/licenses/:id (AECI-1371, E4.2) ────────────────────────

describe('PATCH /api/admin/licenses/:id: extend, reference, revoke', () => {
  const PRODUCT = u(40);
  const TERM_END = '2027-01-31T00:00:00.000Z';

  async function patch(licenseId: string, body: unknown, factory?: DbFactory) {
    const execCtx = fakeExecutionContext();
    const res = await app(factory).request(
      `/api/admin/licenses/${licenseId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      },
      ENV,
      execCtx,
    );
    const json = (await res.json()) as JsonBody;
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
    return { status: res.status, body: json };
  }

  /** A license on VENDOR with the given source, end and reference. Live by default. */
  async function license(
    over: {
      source?: string;
      endsAt?: string | null;
      reference?: string | null;
      productId?: string | null;
      endedAt?: string | null;
    } = {},
  ) {
    const id = await seedLicense(t.db, VENDOR, {
      source: over.source ?? 'invoice',
      endsAt: over.endsAt === undefined ? TERM_END : over.endsAt,
      productId: over.productId ?? null,
      endedAt: over.endedAt ?? null,
      endReason: over.endedAt ? 'lapsed' : null,
    });
    const reference = over.reference === undefined ? 'PO-1' : over.reference;
    await t.db.update(licenses).set({ reference }).where(eq(licenses.id, id));
    return id;
  }

  async function ownProduct() {
    await t.db.insert(products).values({ id: PRODUCT, slug: 'microstation', name: 'MicroStation' });
    await t.db.insert(productVendors).values({ productId: PRODUCT, vendorId: VENDOR });
  }

  const licenseRow = async (id: string) =>
    (await t.db.select().from(licenses).where(eq(licenses.id, id)))[0]!;

  // ── extend ────────────────────────────────────────────────────────────────

  it('extends the end date: one license.term_changed row, no purge, no email', async () => {
    const id = await license();
    const { status, body } = await patch(id, { action: 'extend', ends_at: END });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      vendor_id: VENDOR,
      action: 'extend',
      changed: true,
      license: { id, ends_at: END_ISO, ended_at: null, source: 'invoice' },
    });
    expect((await licenseRow(id)).endsAt).toBe(END_ISO);
    const audits = await readAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'license.term_changed',
      entityType: 'billing_account',
      entityId: body.billing_account_id,
      vendorId: VENDOR,
      actorId: ADMIN,
    });
    expect(audits[0]!.metadata).toMatchObject({ license_id: id, change: 'extend' });
    expect(queueSend).not.toHaveBeenCalled();
    expect(sendEnded).not.toHaveBeenCalled();
  });

  it.each([
    ['equal to', '2027-01-31'],
    ['before', '2026-12-31'],
  ])('refuses an end %s the current end with 400, nothing written', async (_label, endsAt) => {
    const id = await license();
    const { status, body } = await patch(id, { action: 'extend', ends_at: endsAt });
    expect(status).toBe(400);
    expect(body.error).toMatchObject({ code: ApiErrorCode.VALIDATION_FAILED, field: 'ends_at' });
    expect((await licenseRow(id)).endsAt).toBe(TERM_END);
    expect(await readAudit()).toHaveLength(0);
  });

  it('refuses extend on a Stripe license with 409 LICENSE_SOURCE_STRIPE, nothing written', async () => {
    const id = await license({ source: 'stripe', reference: null });
    const { status, body } = await patch(id, { action: 'extend', ends_at: '2099-01-01' });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_SOURCE_STRIPE);
    expect((await licenseRow(id)).endsAt).toBe(TERM_END);
    expect(await readAudit()).toHaveLength(0);
  });

  it('sets a first end date on an open-ended license, after today only', async () => {
    const id = await license({ source: 'complimentary', endsAt: null, reference: null });
    const past = await patch(id, { action: 'extend', ends_at: '2026-02-01' });
    expect(past.status).toBe(400);
    expect(past.body.error.field).toBe('ends_at');
    expect((await licenseRow(id)).endsAt).toBeNull();

    const { status } = await patch(id, { action: 'extend', ends_at: '2099-06-30' });
    expect(status).toBe(200);
    expect((await licenseRow(id)).endsAt).toBe('2099-06-30T00:00:00.000Z');
  });

  // ── reference ─────────────────────────────────────────────────────────────

  it('changes an invoice reference, and the same reference again writes nothing', async () => {
    const id = await license();
    const first = await patch(id, { action: 'reference', reference: ' INV-2 ' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ changed: true, license: { reference: 'INV-2' } });
    expect((await licenseRow(id)).reference).toBe('INV-2');
    const audits = await readAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ license_id: id, change: 'reference' });
    expect(audits[0]!.afterState).toMatchObject({ reference: 'INV-2', ends_at: TERM_END });

    const again = await patch(id, { action: 'reference', reference: 'INV-2' });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
    expect(await readAudit()).toHaveLength(1);
  });

  it('refuses a reference on a complimentary license (422) and on Stripe (409)', async () => {
    const comp = await license({ source: 'complimentary', reference: null });
    const a = await patch(comp, { action: 'reference', reference: 'INV-9' });
    expect(a.status).toBe(422);
    expect(a.body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);

    const stripe = await license({ source: 'stripe', reference: null });
    const b = await patch(stripe, { action: 'reference', reference: 'INV-9' });
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe(ApiErrorCode.LICENSE_SOURCE_STRIPE);
    expect(await readAudit()).toHaveLength(0);
  });

  it('refuses a blank reference with 400', async () => {
    const id = await license();
    const { status } = await patch(id, { action: 'reference', reference: '   ' });
    expect(status).toBe(400);
    expect((await licenseRow(id)).reference).toBe('PO-1');
  });

  // ── refusals shared by every action ───────────────────────────────────────

  it.each([
    { action: 'extend', ends_at: '2099-01-01' },
    { action: 'reference', reference: 'INV-3' },
    { action: 'revoke', reason: 'Not paid.' },
  ])('refuses $action on an ended license with 422, nothing written', async (body) => {
    const id = await license({ endedAt: '2026-06-01T00:00:00.000Z' });
    const before = await licenseRow(id);
    const { status, body: res } = await patch(id, body);
    expect(status).toBe(422);
    expect(res.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(await licenseRow(id)).toEqual(before);
    expect(await readAudit()).toHaveLength(0);
    expect(sendEnded).not.toHaveBeenCalled();
  });

  it('404s an unknown license', async () => {
    const { status, body } = await patch(u(999), { action: 'revoke', reason: 'x' });
    expect(status).toBe(404);
    expect(body.error.details).toMatchObject({ resource: 'license' });
  });

  it.each([
    ['an unknown action', { action: 'delete' }],
    ['extend with no date', { action: 'extend' }],
    ['an extra field', { action: 'revoke', reason: 'x', ends_at: '2099-01-01' }],
  ])('400s %s', async (_label, body) => {
    const id = await license();
    expect((await patch(id, body)).status).toBe(400);
    expect(await readAudit()).toHaveLength(0);
  });

  // ── revoke ────────────────────────────────────────────────────────────────

  it.each([
    ['missing', { action: 'revoke' }],
    ['blank', { action: 'revoke', reason: '   ' }],
  ])('refuses a revoke with a %s reason with 400, nothing written', async (_label, body) => {
    const id = await license();
    const { status, body: res } = await patch(id, body);
    expect(status).toBe(400);
    expect(res.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect((await licenseRow(id)).endedAt).toBeNull();
    expect(await readAudit()).toHaveLength(0);
  });

  it('revokes an assigned license in one batch: ended, product kept as history, product on Free', async () => {
    await ownProduct();
    await seedSeats();
    const id = await license({ productId: PRODUCT });
    // A second live license keeps the vendor verified, so only the product changes plan.
    await license();
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR));
    expect(await loadOwnedProductLicenseState(t.db, VENDOR)).toEqual([
      { productId: PRODUCT, licensed: true },
    ]);

    let batches = 0;
    const counting = wrappedFactory(t.factory, (_attempt, run) => {
      batches += 1;
      return run();
    });
    const { status, body } = await patch(
      id,
      { action: 'revoke', reason: 'The invoice was not paid.', internalNote: 'Ticket 42' },
      counting,
    );
    expect(status).toBe(200);
    expect(batches).toBe(1);
    expect(body).toMatchObject({
      action: 'revoke',
      changed: true,
      license: { id, end_reason: 'revoked', assigned_product_id: PRODUCT },
    });

    // Ruling P1: ended with the reason, the assignment kept as history (decision 14).
    const row = await licenseRow(id);
    expect(row.endedAt).not.toBeNull();
    expect(row).toMatchObject({ endReason: 'revoked', assignedProductId: PRODUCT });
    expect(await loadOwnedProductLicenseState(t.db, VENDOR)).toEqual([
      { productId: PRODUCT, licensed: false },
    ]);

    const audits = await readAudit();
    expect(audits.map((a) => a.action).sort()).toEqual(['license.revoked', 'notification.sent']);
    const revoked = audits.find((a) => a.action === 'license.revoked')!;
    expect(revoked).toMatchObject({
      entityType: 'billing_account',
      entityId: body.billing_account_id,
      vendorId: VENDOR,
      productId: PRODUCT,
    });
    expect(revoked.metadata).toMatchObject({
      license_id: id,
      reason: 'The invoice was not paid.',
      reasonVisibility: 'vendor',
      internalNote: 'Ticket 42',
    });
    const notice = audits.find((a) => a.action === 'notification.sent')!;
    expect(notice).toMatchObject({ vendorId: VENDOR, productId: PRODUCT });
    expect(notice.metadata).toMatchObject({
      kind: 'aeci_override',
      notificationId: 'portal-license-revoked-by-aeci',
      event: 'license_revoked',
      reason: 'The invoice was not paid.',
      reasonVisibility: 'vendor',
      licenseId: id,
      licenseProduct: { slug: 'microstation', name: 'MicroStation' },
    });
    expect(JSON.stringify(notice.metadata)).not.toContain('Ticket 42');

    // Post-commit: the product's tags and the vendor's.
    expect(queueSend).toHaveBeenCalledTimes(1);
    const purged = (queueSend.mock.calls[0]![0] as { tags: string[] }).tags;
    expect(purged).toEqual(
      expect.arrayContaining(['product:microstation', 'index:products', 'vendor:bentley']),
    );

    // The managed-ended email, to each unbanned seat, keyed per license and address.
    const sent = sendEnded.mock.calls.map((call) => call[1] as JsonBody);
    expect(sent.map((s) => s.to).sort()).toEqual([
      'seat-500@bentley.example',
      'seat-501@bentley.example',
    ]);
    expect(sent[0]).toMatchObject({
      vendorName: 'Bentley',
      products: [{ slug: 'microstation', name: 'MicroStation' }],
      cause: 'revoked',
      reason: 'The invoice was not paid.',
      entity: { type: 'billing_account', id: body.billing_account_id },
    });
    expect(sent[0]!.dedupeKey).toBe(await managedEndedDedupeKey(id, sent[0]!.to));
    expect(JSON.stringify(sent)).not.toContain('Ticket 42');
  });

  it('names no products column in the revoke batch: Managed content is untouched', async () => {
    await ownProduct();
    const id = await license({ productId: PRODUCT });
    const [productBefore] = await t.db.select().from(products);
    const sqls: string[] = [];
    const capturing = wrappedFactory(t.factory, (_attempt, run, stmts) => {
      for (const stmt of stmts as unknown as { toSQL(): { sql: string } }[]) {
        sqls.push(stmt.toSQL().sql);
      }
      return run();
    });
    expect((await patch(id, { action: 'revoke', reason: 'Abuse.' }, capturing)).status).toBe(200);
    expect(sqls.length).toBeGreaterThan(0);
    expect(sqls.filter((sql) => /"products"/.test(sql))).toEqual([]);
    const licenseUpdate = sqls.find((sql) => /^update "licenses"/.test(sql))!;
    expect(licenseUpdate).not.toContain('"assigned_product_id" =');
    expect((await t.db.select().from(products))[0]).toEqual(productBefore);
  });

  it('revokes an unassigned license: Messages row, no purge, no email', async () => {
    await seedSeats();
    const id = await license();
    await license();
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR));
    const { status } = await patch(id, { action: 'revoke', reason: 'Granted by mistake.' });
    expect(status).toBe(200);
    const audits = await readAudit();
    expect(audits.map((a) => a.action).sort()).toEqual(['license.revoked', 'notification.sent']);
    const notice = audits.find((a) => a.action === 'notification.sent')!;
    expect(notice.metadata).toMatchObject({ event: 'license_revoked', licenseProduct: null });
    expect(notice.productId).toBeNull();
    expect(queueSend).not.toHaveBeenCalled();
    expect(sendEnded).not.toHaveBeenCalled();
  });

  it('an unassigned revoke of the last live license flips verified and purges the vendor set', async () => {
    const id = await license();
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR));
    expect((await patch(id, { action: 'revoke', reason: 'Pilot ended early.' })).status).toBe(200);
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(false);
    expect(queueSend).toHaveBeenCalledWith({ tags: ['vendor:bentley'], source: 'moderation' });
    expect(sendEnded).not.toHaveBeenCalled();
  });

  it('allows a revoke of a Stripe license', async () => {
    const id = await license({ source: 'stripe', reference: null });
    expect((await patch(id, { action: 'revoke', reason: 'Chargeback.' })).status).toBe(200);
    expect((await licenseRow(id)).endReason).toBe('revoked');
  });

  // ── the last live license re-routes contests (AECI-1092 ruling B, AECI-1375) ──

  const I_POWERED = u(60);
  const P_SRC = u(61);
  const P_DST = u(62);
  let nextContest = 0;

  /** A connector-powered integration VENDOR owns, and its products. */
  async function poweredIntegration() {
    await t.db.insert(products).values([
      { id: P_SRC, slug: 'src', name: 'Src' },
      { id: P_DST, slug: 'dst', name: 'Dst' },
    ]);
    await t.db.insert(integrations).values({
      id: I_POWERED,
      sourceProductId: P_SRC,
      targetProductId: P_DST,
      mechanismKind: 'iPaaS',
      builtByVendorId: VENDOR,
      claimedAt: OLD_TS,
    });
  }

  /** An open contest on that integration, routed to VENDOR as owner. */
  function ownerContest(): string {
    const id = u(700 + nextContest);
    const fields = ['name', 'description', 'website', 'listing_url', 'docs_url', 'maturity'];
    const at = `2026-09-23T10:00:0${nextContest}.000Z`;
    t.raw
      .prepare(
        `INSERT INTO integration_field_challenges (id, integration_id, field, current_value, proposed_value, reason, submitter_vendor_id, routed_to, owner_vendor_id, status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'x', 'r', ?, 'owner', ?, 'open', ?, ?)`,
      )
      .run(id, I_POWERED, fields[nextContest++], OTHER_VENDOR, VENDOR, at, at);
    return id;
  }

  const contestRow = async (id: string) =>
    (
      await t.db
        .select()
        .from(integrationFieldChallenges)
        .where(eq(integrationFieldChallenges.id, id))
    )[0]!;

  it('a revoke of the last live license re-routes owner contests on connector rows, in the same batch', async () => {
    nextContest = 0;
    await poweredIntegration();
    const id = await license();
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR));
    const contestId = ownerContest();
    let batches = 0;
    const counting = wrappedFactory(t.factory, async (_attempt, run) => {
      batches += 1;
      return run();
    });

    const { status } = await patch(id, { action: 'revoke', reason: 'Pilot ended.' }, counting);
    expect(status).toBe(200);
    expect(batches).toBe(1);
    expect((await contestRow(contestId)).routedTo).toBe('aeci');
    const rerouted = (await readAudit()).filter((a) => a.action === 'integration.contest.rerouted');
    expect(rerouted).toHaveLength(1);
    expect(rerouted[0]!.metadata).toMatchObject({
      reason: 'entitlement-cleared',
      ownerVendorId: VENDOR,
      license_id: id,
    });
    // Stamped with the owner and the plan it held before the revoke (AECI-1192).
    expect(rerouted[0]!.vendorId).toBe(VENDOR);
    expect(rerouted[0]!.vendorTier).toBe('verified');
    expect(rerouted[0]!.vendorEntitlementStatus).toBe('active');
  });

  it('a revoke that leaves another live license re-routes nothing', async () => {
    nextContest = 0;
    await poweredIntegration();
    const id = await license();
    await license();
    const contestId = ownerContest();
    expect((await patch(id, { action: 'revoke', reason: 'One too many.' })).status).toBe(200);
    expect((await contestRow(contestId)).routedTo).toBe('owner');
    expect((await readAudit()).map((a) => a.action)).not.toContain('integration.contest.rerouted');
  });

  it('re-plans once when a contest lands mid-revoke, and answers 409 when it happens twice', async () => {
    nextContest = 0;
    await poweredIntegration();
    const id = await license();
    ownerContest();
    // Twice: every attempt sees a new owner contest land, so the revoke gives up.
    const lost = await patch(
      id,
      { action: 'revoke', reason: 'Pilot ended.' },
      racingFactory(t.factory, () => {
        ownerContest();
      }),
    );
    expect(lost.status).toBe(409);
    expect(lost.body.error.code).toBe(ApiErrorCode.CONTEST_INTEGRATION_CHANGED);
    expect((await licenseRow(id)).endedAt).toBeNull();
    expect(await readAudit()).toHaveLength(0);

    // Once: the second attempt re-plans, commits, and moves the late contest too.
    const won = await patch(
      id,
      { action: 'revoke', reason: 'Pilot ended.' },
      racingFactory(t.factory, (attempt) => {
        if (attempt === 1) ownerContest();
      }),
    );
    expect(won.status).toBe(200);
    const open = await t.db.select().from(integrationFieldChallenges);
    expect(open.every((r) => r.routedTo === 'aeci')).toBe(true);
    expect((await licenseRow(id)).endReason).toBe('revoked');
  });

  it('a grant that lands mid-revoke drops the re-route, and the revoke still commits', async () => {
    nextContest = 0;
    await poweredIntegration();
    const id = await license();
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR));
    const contestId = ownerContest();
    const { status } = await patch(
      id,
      { action: 'revoke', reason: 'Pilot ended.' },
      racingFactory(t.factory, async (attempt) => {
        if (attempt === 1) await seedLicense(t.db, VENDOR);
      }),
    );
    expect(status).toBe(200);
    expect((await licenseRow(id)).endReason).toBe('revoked');
    expect((await contestRow(contestId)).routedTo).toBe('owner');
    const audit = await readAudit();
    expect(audit.map((a) => a.action)).not.toContain('integration.contest.rerouted');
    // The batch was rebuilt from the fresh read: the grant kept the vendor verified, so
    // the committed row must not claim a flip, and nothing purges the vendor set.
    const revoked = audit.find((a) => a.action === 'license.revoked');
    expect(revoked!.metadata).toMatchObject({ verified_flipped: false });
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(true);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('a revoke that races another revoke for the last two licenses still re-routes', async () => {
    nextContest = 0;
    await poweredIntegration();
    const id = await license();
    const other = await license();
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR));
    const contestId = ownerContest();
    const { status } = await patch(
      id,
      { action: 'revoke', reason: 'Pilot ended.' },
      racingFactory(t.factory, async (attempt) => {
        if (attempt === 1) {
          await t.db
            .update(licenses)
            .set({ endedAt: '2026-10-01T00:00:00.000Z', endReason: 'revoked' })
            .where(eq(licenses.id, other));
        }
      }),
    );
    expect(status).toBe(200);
    expect((await licenseRow(id)).endReason).toBe('revoked');
    expect((await contestRow(contestId)).routedTo).toBe('aeci');
    const audit = await readAudit();
    expect(audit.filter((a) => a.action === 'integration.contest.rerouted')).toHaveLength(1);
    const revoked = audit.find((a) => a.action === 'license.revoked');
    expect(revoked!.metadata).toMatchObject({ verified_flipped: true });
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(false);
  });

  // ── a lost race (the license ended between the read and the batch) ─────────

  const RACED_AT = '2026-10-01T00:00:00.000Z';
  const endBeforeBatch = (id: string) =>
    racingFactory(t.factory, async () => {
      await t.db
        .update(licenses)
        .set({ endedAt: RACED_AT, endReason: 'revoked' })
        .where(eq(licenses.id, id));
    });

  it('a revoke that loses the race to another revoke answers 422 and writes nothing', async () => {
    await ownProduct();
    await seedSeats();
    const id = await license({ productId: PRODUCT });
    const { status, body } = await patch(
      id,
      { action: 'revoke', reason: 'Abuse.' },
      endBeforeBatch(id),
    );
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(await readAudit()).toHaveLength(0);
    expect((await licenseRow(id)).endedAt).toBe(RACED_AT);
    expect(queueSend).not.toHaveBeenCalled();
    expect(sendEnded).not.toHaveBeenCalled();
  });

  it('an extend racing a revoke answers 422 and writes nothing', async () => {
    const id = await license();
    const { status, body } = await patch(
      id,
      { action: 'extend', ends_at: END },
      endBeforeBatch(id),
    );
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(await readAudit()).toHaveLength(0);
    expect((await licenseRow(id)).endsAt).toBe(TERM_END);
    expect(queueSend).not.toHaveBeenCalled();
  });

  // ── a lost race to another edit (the term or reference moved since the read) ──

  const WINNER_END = '2027-12-31T00:00:00.000Z';
  const editBeforeBatch = (id: string, set: { endsAt?: string; reference?: string }) =>
    racingFactory(t.factory, async () => {
      await t.db.update(licenses).set(set).where(eq(licenses.id, id));
    });

  it('a reference change racing an extend answers 422 and keeps the extended end', async () => {
    const id = await license();
    const { status, body } = await patch(
      id,
      { action: 'reference', reference: 'INV-2' },
      editBeforeBatch(id, { endsAt: WINNER_END }),
    );
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(body.error.details).toMatchObject({ state: 'changed' });
    expect(await readAudit()).toHaveLength(0);
    expect(await licenseRow(id)).toMatchObject({ endsAt: WINNER_END, reference: 'PO-1' });
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('an extend racing a longer extend answers 422 and never shortens the term', async () => {
    const id = await license();
    const { status, body } = await patch(
      id,
      { action: 'extend', ends_at: END },
      editBeforeBatch(id, { endsAt: WINNER_END }),
    );
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(await readAudit()).toHaveLength(0);
    expect((await licenseRow(id)).endsAt).toBe(WINNER_END);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('an extend racing a reference change answers 422 and keeps the new reference', async () => {
    const id = await license();
    const { status } = await patch(
      id,
      { action: 'extend', ends_at: END },
      editBeforeBatch(id, { reference: 'INV-9' }),
    );
    expect(status).toBe(422);
    expect(await readAudit()).toHaveLength(0);
    expect(await licenseRow(id)).toMatchObject({ endsAt: TERM_END, reference: 'INV-9' });
  });

  it('a failing managed-ended send never fails the revoke', async () => {
    await ownProduct();
    await seedSeats();
    sendEnded.mockRejectedValue(new Error('resend down'));
    const id = await license({ productId: PRODUCT });
    expect((await patch(id, { action: 'revoke', reason: 'Abuse.' })).status).toBe(200);
    expect((await licenseRow(id)).endReason).toBe('revoked');
  });
});

describe('PATCH /api/admin/licenses/:id authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'staging', SUPABASE_URL } as Env;

  let jwks: TestJwks;
  let licenseId: string;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });
  beforeEach(async () => {
    licenseId = await seedLicense(t.db, VENDOR, { endsAt: '2027-01-31T00:00:00.000Z' });
  });

  const call = (token?: string) => {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.patch(
      '/api/admin/licenses/:id',
      requireAdmin({ getKey: jwks.getKey, dbFor: t.factory }),
      createUpdateLicenseHandler(
        t.factory,
        fetchSeatEmails,
        sendEnded as unknown as SendManagedEnded,
      ),
    );
    return a.request(
      `/api/admin/licenses/${licenseId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ action: 'revoke', reason: 'Abuse.' }),
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );
  };
  const stillLive = async () => expect((await t.db.select().from(licenses))[0]!.endedAt).toBeNull();

  it('401s with no token', async () => {
    expect((await call()).status).toBe(401);
    await stillLive();
  });

  it('403s a vendor_admin of the license holder', async () => {
    await t.db.insert(profiles).values({ id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR });
    const token = await jwks.mintToken({ sub: SEAT_A, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    await stillLive();
  });

  it('403s a banned admin', async () => {
    await t.db.insert(profiles).values({ id: u(911), role: 'admin', bannedAt: OLD_TS });
    const token = await jwks.mintToken({ sub: u(911), supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(403);
    await stillLive();
  });

  it('200s an admin', async () => {
    const token = await jwks.mintToken({ sub: ADMIN, supabaseUrl: SUPABASE_URL });
    expect((await call(token)).status).toBe(200);
    expect((await t.db.select().from(licenses))[0]!.endReason).toBe('revoked');
  });
});
