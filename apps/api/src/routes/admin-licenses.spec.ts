/**
 * `POST /api/admin/vendors/:id/licenses` (AECI-1370, E4.1): the admin license grant,
 * against the in-memory D1 harness. Since AECI-1615 a grant writes a pending
 * `license_grants` row and no license, unless a signed deal activates it at create. Authorization runs against the REAL
 * `requireAdmin()` guard in the last describe.
 */

import {
  ApiErrorCode,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_TEXT_SHA256,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  billingAccounts,
  licenseGrants,
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
  BAN_TERM_REFERENCE,
  LICENSE_GRANT_NAMESPACE,
  createBanTermLicensesHandler,
  createGrantLicensesHandler,
  createUpdateLicenseHandler,
  createWithdrawLicenseGrantHandler,
  grantLicenseIds,
  licensesGrantedDedupeKey,
  managedEndedDedupeKey,
  type SendLicenseGrantPending,
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
let sendPending: ReturnType<typeof vi.fn>;
let sendEnded: ReturnType<typeof vi.fn>;
let queueSend: ReturnType<typeof vi.fn>;
let queueSendBatch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(logToPosthog).mockClear();
  fetchSeatEmails = vi.fn(
    async (_env: Env, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, `seat-${id.slice(-3)}@bentley.example`])),
  );
  sendGranted = vi.fn(async () => 'sent' as const);
  sendPending = vi.fn(async () => 'sent' as const);
  sendEnded = vi.fn(async () => 'sent' as const);
  queueSend = vi.fn(async () => undefined);
  queueSendBatch = vi.fn(async () => undefined);
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'bentley', companyName: 'Bentley', verified: false, updatedAt: OLD_TS },
    { id: OTHER_VENDOR, slug: 'other', companyName: 'Other', verified: false },
  ]);
});
afterEach(() => t.dispose());

const ENV = {
  ...TEST_ENV,
  CACHE_PURGE_QUEUE: {
    send: (...a: unknown[]) => queueSend(...a),
    sendBatch: (...a: unknown[]) => queueSendBatch(...a),
  },
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
      sendPending as unknown as SendLicenseGrantPending,
    ),
  );
  a.patch(
    '/api/admin/licenses/:id',
    createUpdateLicenseHandler(factory, fetchSeatEmails, sendEnded as unknown as SendManagedEnded),
  );
  a.patch('/api/admin/license-grants/:id', createWithdrawLicenseGrantHandler(factory));
  a.post(
    '/api/admin/vendors/:id/licenses/ban-term',
    createBanTermLicensesHandler(
      factory,
      fetchSeatEmails,
      sendPending as unknown as SendLicenseGrantPending,
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
const readGrants = () => t.db.select().from(licenseGrants);

/** A valid signed deal (ruling R5): every field, naming the current version. */
const deal = (over: Record<string, unknown> = {}) => ({
  signer_name: 'Dana Signer',
  signer_role: 'CFO',
  company_legal_name: 'Bentley Systems, Inc.',
  signer_email: 'CFO@bentley.example',
  deal_reference: 'MSA-2026-07',
  version_named: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
  version_date_named: '2026-11-09',
  signing_accepts: true,
  signed_at: '2026-11-01',
  ...over,
});
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

describe('POST /api/admin/vendors/:id/licenses: the grant waits (AECI-1615)', () => {
  it('writes one pending grant and its audit row, and no license', async () => {
    const accountId = await seedBillingAccount(t.db, VENDOR);
    await seedSeats();
    const { status, body } = await post(VENDOR, grant({ notes: 'Pilot cohort 1' }));
    expect(status).toBe(201);
    expect(body).toMatchObject({
      vendor_id: VENDOR,
      billing_account_id: accountId,
      grant_id: GRANT,
      replayed: false,
      status: 'pending_acceptance',
      licenses: [],
      warnings: [],
    });
    expect(body.grant).toMatchObject({
      id: GRANT,
      kind: 'grant',
      status: 'pending_acceptance',
      source: 'complimentary',
      quantity: 2,
      starts_at: null,
      ends_at: END_ISO,
      notes: 'Pilot cohort 1',
      terms_version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
      items: [],
      granted_by: ADMIN,
      acceptance_id: null,
      acceptance_method: null,
    });

    expect(await readLicenses()).toHaveLength(0);
    const [row] = await readGrants();
    expect(row).toMatchObject({
      id: GRANT,
      billingAccountId: accountId,
      vendorId: VENDOR,
      status: 'pending_acceptance',
      termsVersion: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
    });
    const audits = await readAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'license_grant.created',
      entityType: 'license_grant',
      entityId: GRANT,
      vendorId: VENDOR,
      actorId: ADMIN,
      actorType: 'admin',
    });
    expect(audits[0]!.metadata).toMatchObject({ grant_id: GRANT, notes: 'Pilot cohort 1' });

    // No license, so no mirror flip, no purge and no licenses-granted email.
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(false);
    expect(queueSend).not.toHaveBeenCalled();
    expect(sendGranted).not.toHaveBeenCalled();
  });

  it('prompts the owner seats only, keyed per grant and owner', async () => {
    await seedBillingAccount(t.db, VENDOR);
    await seedSeats();
    await post(VENDOR, grant());
    expect(sendPending).toHaveBeenCalledTimes(1);
    expect(sendPending.mock.calls[0]![1]).toMatchObject({
      to: 'seat-500@bentley.example',
      quantity: 2,
      source: 'complimentary',
      endsAt: END_ISO,
      vendorSlug: 'bentley',
      termsVersion: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
      dedupeKey: `license-grant-pending:${GRANT}:${SEAT_A}`,
    });
  });

  it('warns when no owner seat resolves, and still answers 201', async () => {
    await seedBillingAccount(t.db, VENDOR);
    const { status } = await post(VENDOR, grant());
    expect(status).toBe(201);
    expect(sendPending).not.toHaveBeenCalled();
    expect(vi.mocked(logToPosthog)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('no owner') }),
    );
  });

  it('records an invoice grant with its reference and an explicit start', async () => {
    await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await post(
      VENDOR,
      grant({ source: 'invoice', reference: ' PO-77 ', starts_at: '2026-11-01', quantity: 1 }),
    );
    expect(status).toBe(201);
    expect(body.grant).toMatchObject({
      source: 'invoice',
      reference: 'PO-77',
      starts_at: '2026-11-01T00:00:00.000Z',
      ends_at: END_ISO,
      quantity: 1,
    });
  });

  it('lists the grant on the vendor audit trail leg (audit_log.vendor_id)', async () => {
    await seedBillingAccount(t.db, VENDOR);
    await post(VENDOR, grant());
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.vendorId, VENDOR));
    expect(rows.map((r) => r.action)).toEqual(['license_grant.created']);
  });
});

describe('POST /api/admin/vendors/:id/licenses: a recorded signed deal (ruling R5)', () => {
  it('activates the grant in the create batch: acceptance, licenses and audit rows together', async () => {
    const accountId = await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await post(VENDOR, grant({ signed_deal: deal() }));
    expect(status).toBe(201);
    const ids = await grantLicenseIds(GRANT, 2);
    expect(body.status).toBe('accepted');
    expect(body.grant).toMatchObject({ status: 'accepted', acceptance_method: 'signed_deal' });
    expect(body.licenses.map((l: JsonBody) => l.id)).toEqual(ids);

    const rows = await readLicenses();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        billingAccountId: accountId,
        source: 'complimentary',
        endsAt: END_ISO,
        endedAt: null,
        assignedProductId: null,
        grantedBy: ADMIN,
        licenseGrantId: GRANT,
        termsVersion: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
      });
    }

    const [acceptance] = await t.db.select().from(agreementAcceptances);
    expect(acceptance).toMatchObject({
      document: 'managed_plan',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
      source: 'grant',
      method: 'signed_deal',
      email: 'cfo@bentley.example',
      profileId: null,
      vendorId: VENDOR,
      billingAccountId: accountId,
      licenseGrantId: GRANT,
      grantEndsAt: END_ISO,
      textSha256: LEGAL_AGREEMENT_TEXT_SHA256.managed_plan['1.1'],
      seatRole: null,
      signerName: 'Dana Signer',
      signerTitle: 'CFO',
      companyLegalName: 'Bentley Systems, Inc.',
      dealReference: 'MSA-2026-07',
      dealSignedAt: '2026-11-01T00:00:00.000Z',
      // Ruling 16: a signed deal has no box.
      checkboxLabelSha256: null,
      checkboxDefaultUnticked: null,
      // Recorded from the admin's browser, not the signer's.
      ip: null,
      userAgent: null,
    });
    const [stored] = await readGrants();
    expect(stored).toMatchObject({ status: 'accepted', acceptanceId: acceptance!.id });

    const actions = (await readAudit()).map((a) => a.action);
    expect(actions).toEqual([
      'license_grant.created',
      'agreement.accepted',
      'license.granted',
      'license.granted',
      'license_grant.accepted',
    ]);
    const accepted = (await readAudit()).find((a) => a.action === 'license_grant.accepted')!;
    expect(accepted.metadata).toMatchObject({
      method: 'signed_deal',
      deal_version_named: '1.1',
      deal_version_date_named: '2026-11-09',
    });
    // No personal data on any audit row.
    expect(JSON.stringify(await readAudit())).not.toContain('cfo@bentley.example');
    expect(JSON.stringify(await readAudit())).not.toContain('Dana Signer');
  });

  it('moves the verified mirror, purges the vendor tags and sends licenses-granted, not the prompt', async () => {
    await seedBillingAccount(t.db, VENDOR);
    await seedSeats();
    await post(VENDOR, grant({ signed_deal: deal() }));
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(true);
    expect(queueSend).toHaveBeenCalledWith({ tags: ['vendor:bentley'], source: 'moderation' });
    expect(sendGranted).toHaveBeenCalled();
    expect(sendPending).not.toHaveBeenCalled();
  });

  it('purges nothing when the vendor already holds a live license', async () => {
    await seedLicense(t.db, VENDOR);
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR));
    const { status } = await post(VENDOR, grant({ signed_deal: deal() }));
    expect(status).toBe(201);
    expect(queueSend).not.toHaveBeenCalled();
    expect(await readLicenses()).toHaveLength(3);
  });

  it('400s a deal that names another version: a substituted version needs a new acceptance', async () => {
    await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await post(
      VENDOR,
      grant({ signed_deal: deal({ version_named: '1.0' }) }),
    );
    expect(status).toBe(400);
    expect(body.error.field).toBe('signed_deal.version_named');
    expect(await readGrants()).toHaveLength(0);
    expect(await readLicenses()).toHaveLength(0);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(0);
  });

  it('400s a deal signed in the future', async () => {
    await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await post(
      VENDOR,
      grant({ signed_deal: deal({ signed_at: '2999-01-01' }) }),
    );
    expect(status).toBe(400);
    expect(body.error.field).toBe('signed_deal.signed_at');
    expect(await readGrants()).toHaveLength(0);
  });

  it.each([
    ['signing_accepts false', { signing_accepts: false }],
    ['no signer name', { signer_name: undefined }],
    ['no deal reference', { deal_reference: '  ' }],
    ['no version date', { version_date_named: undefined }],
    ['a bad signer email', { signer_email: 'not-an-email' }],
  ])('400s a deal with %s, writing nothing', async (_label, over) => {
    await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await post(VENDOR, grant({ signed_deal: deal(over) }));
    expect(status).toBe(400);
    expect(body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect(await readGrants()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
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
    expect(await readGrants()).toHaveLength(0);
    expect(await readLicenses()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
    expect(sendPending).not.toHaveBeenCalled();
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
    expect(await readGrants()).toHaveLength(0);
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
    sendPending.mockClear();

    const again = await post(VENDOR, grant());
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.status).toBe('pending_acceptance');
    expect(again.body.grant).toEqual(first.body.grant);
    expect(await readGrants()).toHaveLength(1);
    expect(await readAudit()).toHaveLength(1);
    expect(sendPending).not.toHaveBeenCalled();
  });

  it('a repeat of a signed-deal grant answers 200 with its licenses', async () => {
    const first = await post(VENDOR, grant({ signed_deal: deal() }));
    sendGranted.mockClear();
    const again = await post(VENDOR, grant({ signed_deal: deal() }));
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('accepted');
    expect(again.body.grant.acceptance_method).toBe('signed_deal');
    expect(again.body.licenses).toEqual(first.body.licenses);
    expect(await readLicenses()).toHaveLength(2);
    expect(sendGranted).not.toHaveBeenCalled();
  });

  it.each([
    ['a larger quantity', { quantity: 3 }],
    ['a smaller quantity', { quantity: 1 }],
    ['another source', { source: 'invoice', reference: 'PO-1' }],
    ['another end date', { ends_at: '2027-07-01' }],
    ['an explicit start', { starts_at: '2026-12-01' }],
  ])('409s the same grant id with %s', async (_label, over) => {
    await post(VENDOR, grant());
    sendPending.mockClear();
    const { status, body } = await post(VENDOR, grant(over));
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_GRANT_CONFLICT);
    expect(await readGrants()).toHaveLength(1);
    expect(sendPending).not.toHaveBeenCalled();
  });

  it('409s a grant id already used on another vendor', async () => {
    await seedBillingAccount(t.db, OTHER_VENDOR);
    await post(OTHER_VENDOR, grant());
    const { status, body } = await post(VENDOR, grant());
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_GRANT_CONFLICT);
  });

  it('409s a grant id whose licenses a grant made before AECI-1615 already wrote', async () => {
    const [firstId] = await grantLicenseIds(GRANT, 1);
    await seedLicense(t.db, VENDOR, { id: firstId });
    const { status, body } = await post(VENDOR, grant());
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_GRANT_CONFLICT);
    expect(await readGrants()).toHaveLength(0);
  });

  it('a create that loses the race on the grant id is a 409 and writes nothing', async () => {
    const accountId = await seedBillingAccount(t.db, VENDOR);
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db.insert(licenseGrants).values({
        id: GRANT,
        billingAccountId: accountId,
        vendorId: VENDOR,
        kind: 'grant',
        source: 'complimentary',
        quantity: 2,
        endsAt: END_ISO,
        termsVersion: '1.1',
        status: 'pending_acceptance',
      });
    });
    const { status, body } = await post(VENDOR, grant(), racing);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.LICENSE_GRANT_CONFLICT);
    expect(await readGrants()).toHaveLength(1);
    expect(await readAudit()).toHaveLength(0);
    expect(sendPending).not.toHaveBeenCalled();
  });
});

// AECI-1589, ruled 2026-11-03: the generic grant refuses a vendor whose every seat is
// banned. A vendor nobody has claimed stays grantable.
describe('a fully banned vendor is refused', () => {
  beforeEach(async () => {
    await seedBillingAccount(t.db, VENDOR);
  });

  const banAll = () =>
    t.db.update(profiles).set({ bannedAt: OLD_TS }).where(eq(profiles.vendorId, VENDOR));

  it('409s VENDOR_STILL_BANNED when every vendor_admin seat is banned, writing nothing', async () => {
    await seedSeats();
    await banAll();
    const { status, body } = await post(VENDOR, grant());
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.VENDOR_STILL_BANNED);
    expect(await readGrants()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
    expect(sendPending).not.toHaveBeenCalled();
  });

  it('grants a vendor with no seat at all (never claimed)', async () => {
    const { status } = await post(VENDOR, grant());
    expect(status).toBe(201);
    expect(await readGrants()).toHaveLength(1);
  });

  it('grants a vendor with one unbanned seat beside a banned one', async () => {
    await t.db.insert(profiles).values([
      { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
      { id: BANNED_SEAT, role: 'vendor_admin', vendorId: VENDOR, bannedAt: OLD_TS },
    ]);
    const { status } = await post(VENDOR, grant());
    expect(status).toBe(201);
    expect(await readGrants()).toHaveLength(1);
  });

  it('a replay of a grant made before the ban still answers 200 and writes nothing', async () => {
    await seedSeats();
    const first = await post(VENDOR, grant());
    expect(first.status).toBe(201);
    await banAll();
    sendPending.mockClear();

    const again = await post(VENDOR, grant());
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(await readGrants()).toHaveLength(1);
    expect(await readAudit()).toHaveLength(1);
    expect(sendPending).not.toHaveBeenCalled();
  });

  // A last-seat ban that commits between the seat read and the batch: the in-batch
  // sentinel aborts the grant, so nothing lands on a banned vendor.
  it('a last-seat ban landing mid-request aborts the grant: 409 VENDOR_SEATS_CHANGED, nothing written', async () => {
    await seedSeats();
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db
        .update(profiles)
        .set({ bannedAt: '2026-11-03T00:00:00.000Z', banReason: 'abuse' })
        .where(eq(profiles.vendorId, VENDOR));
    });
    const { status, body } = await post(VENDOR, grant({ signed_deal: deal() }), racing);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.VENDOR_SEATS_CHANGED);
    expect(await readGrants()).toHaveLength(0);
    expect(await readLicenses()).toHaveLength(0);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(0);
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
    expect(await readGrants()).toHaveLength(1);
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

// Since AECI-1615 `licenses-granted` goes at activation. A signed deal activates at
// create, so these drive the fan-out through it.
describe('the licenses-granted email at a signed-deal activation', () => {
  beforeEach(async () => {
    await seedBillingAccount(t.db, VENDOR);
  });

  const sentTo = () => sendGranted.mock.calls.map((call) => (call[1] as JsonBody).to);
  const dealGrant = (over: Record<string, unknown> = {}) => grant({ signed_deal: deal(), ...over });

  it('goes once to every unbanned seat, keyed per address and grant', async () => {
    await seedSeats();
    await post(VENDOR, dealGrant({ source: 'invoice', reference: 'PO-9' }));
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
    await post(VENDOR, dealGrant());
    expect(sentTo()).toHaveLength(2);

    sendGranted.mockClear();
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: 'ap@bentley.example' })
      .where(eq(billingAccounts.vendorId, VENDOR));
    await post(VENDOR, dealGrant({ grant_id: '22222222-2222-4222-8222-222222222222' }));
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
    const { status } = await post(VENDOR, dealGrant());
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
    const { status } = await post(VENDOR, dealGrant());
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
    expect(await readGrants()).toHaveLength(1);
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
      vendorSlug: 'bentley',
      products: [{ slug: 'microstation', name: 'MicroStation' }],
      cause: 'revoked',
      reason: 'The invoice was not paid.',
      entity: { type: 'billing_account', id: body.billing_account_id },
    });
    expect(sent[0]!.dedupeKey).toBe(await managedEndedDedupeKey(id, sent[0]!.to));
    expect(JSON.stringify(sent)).not.toContain('Ticket 42');
  });

  it('writes only the plan-end mirror on products: Managed content is untouched', async () => {
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
    // AECI-1614: the one `products` statement sets the mirror and pins `updated_at`.
    const productWrites = sqls.filter((sql) => /"products"/.test(sql));
    expect(productWrites).toHaveLength(1);
    expect(productWrites[0]).toMatch(
      /^update "products" set "updated_at" = "updated_at", "managed_ended_at" = \?|^update "products" set "managed_ended_at" = \?, "updated_at" = "updated_at"/,
    );
    const licenseUpdate = sqls.find((sql) => /^update "licenses"/.test(sql))!;
    expect(licenseUpdate).not.toContain('"assigned_product_id" =');
    const [productAfter] = await t.db.select().from(products);
    expect(productAfter!.managedEndedAt).not.toBeNull();
    expect({ ...productAfter, managedEndedAt: null }).toEqual(productBefore);
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

  // ── the last live license: the mirror guard (AECI-1375; no contest moves, AECI-1663) ──

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

  it('a revoke of the last live license moves no contest (ruling B retired, AECI-1663)', async () => {
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
    expect((await contestRow(contestId)).routedTo).toBe('owner');
    expect((await readAudit()).map((a) => a.action)).toEqual([
      'license.revoked',
      'notification.sent',
    ]);
  });

  it('answers 422 when the mirror guard trips on both attempts, and writes nothing', async () => {
    const id = await license();
    let granted: string | null = null;
    // Attempt 1: a grant lands, so `noLiveLicenseSentinel` trips. The rebuild reads it
    // and carries `liveLicenseRemainsSentinel`. Attempt 2: that grant is revoked.
    const { status, body } = await patch(
      id,
      { action: 'revoke', reason: 'Pilot ended.' },
      racingFactory(t.factory, async (attempt) => {
        if (attempt === 1) granted = await seedLicense(t.db, VENDOR);
        if (attempt === 2) {
          await t.db
            .update(licenses)
            .set({ endedAt: '2026-10-01T00:00:00.000Z', endReason: 'revoked' })
            .where(eq(licenses.id, granted!));
        }
      }),
    );
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(body.error.details).toEqual({ state: 'changed' });
    expect((await licenseRow(id)).endedAt).toBeNull();
    expect(await readAudit()).toHaveLength(0);
  });

  it('a grant that lands mid-revoke rebuilds the batch once, and the mirror stays up', async () => {
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
    // The batch was rebuilt from the fresh read: the grant kept the vendor verified, so
    // the committed row must not claim a flip, and nothing purges the vendor set.
    const revoked = audit.find((a) => a.action === 'license.revoked');
    expect(revoked!.metadata).toMatchObject({ verified_flipped: false });
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(true);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('a revoke that races another revoke for the last two licenses still predicts the flip', async () => {
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
    expect((await contestRow(contestId)).routedTo).toBe('owner');
    const audit = await readAudit();
    // `liveLicenseRemainsSentinel` tripped, so the rebuild saw the last license.
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

// ─── POST /api/admin/vendors/:id/licenses/ban-term (AECI-1589) ──────────────

describe('POST /api/admin/vendors/:id/licenses/ban-term: a pending grant (ruling R1)', () => {
  const P1 = u(40);
  const P2 = u(41);
  const BANNED_1 = u(60);
  const BANNED_2 = u(61);
  const BAN_TS = '2026-11-01T00:00:00.000Z';
  const END_1 = '2027-03-31';
  const END_1_ISO = '2027-03-31T00:00:00.000Z';
  const END_2 = '2027-05-15';
  const END_2_ISO = '2027-05-15T00:00:00.000Z';
  let accountId: string;

  async function postBanTerm(vendorId: string, body: unknown, factory?: DbFactory) {
    const execCtx = fakeExecutionContext();
    const res = await app(factory).request(
      `/api/admin/vendors/${vendorId}/licenses/ban-term`,
      {
        method: 'POST',
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

  const item1 = { ended_license_id: BANNED_1, product_id: P1, ends_at: END_1 };
  const item2 = { ended_license_id: BANNED_2, product_id: P2, ends_at: END_2 };
  const body = (items: unknown[] = [item1, item2], grantId = GRANT) => ({
    grant_id: grantId,
    items,
  });

  /** Nothing written: no grant, no license beyond the two banned rows, no audit row. */
  async function nothingWritten() {
    expect(await readGrants()).toHaveLength(0);
    expect(await readLicenses()).toHaveLength(2);
    expect(await readAudit()).toHaveLength(0);
    expect(sendPending).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
  }

  beforeEach(async () => {
    await seedSeats();
    await t.db.insert(products).values([
      { id: P1, slug: 'p-one', name: 'One', productRole: 'hybrid' },
      { id: P2, slug: 'p-two', name: 'Two', productRole: 'hybrid' },
    ]);
    await t.db.insert(productVendors).values([
      { productId: P1, vendorId: VENDOR },
      { productId: P2, vendorId: VENDOR },
    ]);
    // An annual row keeps its term end; a monthly row whose Stripe read failed has none.
    await seedLicense(t.db, VENDOR, {
      id: BANNED_1,
      productId: P1,
      endsAt: END_1_ISO,
      endedAt: BAN_TS,
      endReason: 'banned',
    });
    await seedLicense(t.db, VENDOR, {
      id: BANNED_2,
      productId: P2,
      source: 'stripe',
      endsAt: null,
      endedAt: BAN_TS,
      endReason: 'banned',
    });
    accountId = await seedBillingAccount(t.db, VENDOR);
  });

  it('201s a pending ban-term grant with its items, and writes no license', async () => {
    const { status, body: res } = await postBanTerm(VENDOR, body());
    expect(status).toBe(201);
    expect(res).toMatchObject({
      vendor_id: VENDOR,
      billing_account_id: accountId,
      grant_id: GRANT,
      replayed: false,
      status: 'pending_acceptance',
      licenses: [],
    });
    expect(res.grant).toMatchObject({
      kind: 'ban_term',
      status: 'pending_acceptance',
      source: 'complimentary',
      quantity: 2,
      // The grant expires only when its latest item's term has passed.
      ends_at: END_2_ISO,
      reference: BAN_TERM_REFERENCE,
      items: [
        { ended_license_id: BANNED_1, product_id: P1, ends_at: END_1_ISO },
        { ended_license_id: BANNED_2, product_id: P2, ends_at: END_2_ISO },
      ],
    });

    expect(await readLicenses()).toHaveLength(2);
    const audits = await readAudit();
    expect(audits.map((a) => a.action)).toEqual(['license_grant.created']);
    expect(audits[0]).toMatchObject({ entityType: 'license_grant', vendorId: VENDOR });

    // Nothing public changed: no purge. The owner seat gets the prompt.
    expect(queueSendBatch).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    expect(sendGranted).not.toHaveBeenCalled();
    expect(sendPending).toHaveBeenCalledTimes(1);
    expect(sendPending.mock.calls[0]![1]).toMatchObject({
      to: 'seat-500@bentley.example',
      dedupeKey: `license-grant-pending:${GRANT}:${SEAT_A}`,
    });
  });

  it('a repeat is a 200 replay: nothing written, no email', async () => {
    const first = await postBanTerm(VENDOR, body());
    expect(first.status).toBe(201);
    sendPending.mockClear();
    const again = await postBanTerm(VENDOR, body());
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.grant).toEqual(first.body.grant);
    expect(await readGrants()).toHaveLength(1);
    expect(await readAudit()).toHaveLength(1);
    expect(sendPending).not.toHaveBeenCalled();
  });

  it('409s the same grant id with another end date', async () => {
    await postBanTerm(VENDOR, body());
    const { status, body: res } = await postBanTerm(
      VENDOR,
      body([item1, { ...item2, ends_at: '2027-06-01' }]),
    );
    expect(status).toBe(409);
    expect(res.error.code).toBe(ApiErrorCode.LICENSE_GRANT_CONFLICT);
  });

  it('409s VENDOR_STILL_BANNED when no unbanned vendor_admin seat remains', async () => {
    await t.db.update(profiles).set({ bannedAt: OLD_TS }).where(eq(profiles.vendorId, VENDOR));
    const { status, body: res } = await postBanTerm(VENDOR, body());
    expect(status).toBe(409);
    expect(res.error.code).toBe(ApiErrorCode.VENDOR_STILL_BANNED);
    await nothingWritten();
  });

  it('400s an ended_license_id the ban did not end on that product', async () => {
    const REVOKED = u(62);
    await seedLicense(t.db, VENDOR, {
      id: REVOKED,
      productId: P1,
      endedAt: BAN_TS,
      endReason: 'revoked',
    });
    const OTHERS = u(63);
    await seedLicense(t.db, OTHER_VENDOR, {
      id: OTHERS,
      productId: P1,
      endedAt: BAN_TS,
      endReason: 'banned',
    });
    const cases: unknown[] = [
      { ...item1, ended_license_id: u(99) },
      { ...item1, ended_license_id: REVOKED },
      { ...item1, ended_license_id: OTHERS },
      { ...item1, ended_license_id: BANNED_2 },
    ];
    for (const bad of cases) {
      const { status, body: res } = await postBanTerm(VENDOR, body([bad, item2]));
      expect(status).toBe(400);
      expect(res.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
      expect(res.error.field).toBe('items.0.ended_license_id');
    }
    expect(await readGrants()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
  });

  it('400s an end date that is not after now', async () => {
    const { status, body: res } = await postBanTerm(
      VENDOR,
      body([item1, { ...item2, ends_at: '2020-01-01' }]),
    );
    expect(status).toBe(400);
    expect(res.error.field).toBe('items.1.ends_at');
    await nothingWritten();
  });

  it('400s a product named twice', async () => {
    const { status, body: res } = await postBanTerm(VENDOR, body([item1, item1]));
    expect(status).toBe(400);
    expect(res.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    await nothingWritten();
  });

  it('404s a product no longer joined to the vendor', async () => {
    await t.db.delete(productVendors).where(eq(productVendors.productId, P2));
    const { status, body: res } = await postBanTerm(VENDOR, body());
    expect(status).toBe(404);
    expect(res.error.details).toMatchObject({ resource: 'product', id: P2 });
    await nothingWritten();
  });

  it('409s LICENSE_PRODUCT_ALREADY_LICENSED when a product already holds a live license', async () => {
    await seedLicense(t.db, OTHER_VENDOR, { productId: P1 });
    const { status, body: res } = await postBanTerm(VENDOR, body());
    expect(status).toBe(409);
    expect(res.error.code).toBe(ApiErrorCode.LICENSE_PRODUCT_ALREADY_LICENSED);
    expect(res.error.details).toEqual({ product_ids: [P1] });
    expect(await readGrants()).toHaveLength(0);
    expect(await readAudit()).toHaveLength(0);
  });

  // A last-seat ban that commits between the seat read and the batch: the in-batch
  // sentinel aborts the grant, so nothing lands on a banned vendor.
  it('a last-seat ban landing mid-request aborts the grant: 409 VENDOR_SEATS_CHANGED, nothing written', async () => {
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db
        .update(profiles)
        .set({ bannedAt: '2026-11-03T00:00:00.000Z', banReason: 'abuse' })
        .where(eq(profiles.vendorId, VENDOR));
    });
    const { status, body: res } = await postBanTerm(VENDOR, body(), racing);
    expect(status).toBe(409);
    expect(res.error.code).toBe(ApiErrorCode.VENDOR_SEATS_CHANGED);
    await nothingWritten();
  });

  // A `banned` row is permanent. Once a later license on its product exists, or a
  // pending ban-term grant names it, the row is spent: a second grant from it would
  // restore the same ban term twice.
  describe('an ended license already restored, replaced or waiting', () => {
    const GRANT_2 = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';

    async function expectSpent(items: unknown[], field: string) {
      const grantsBefore = (await readGrants()).length;
      const auditsBefore = (await readAudit()).length;
      sendPending.mockClear();
      const { status, body: res } = await postBanTerm(VENDOR, body(items, GRANT_2));
      expect(status).toBe(400);
      expect(res.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
      expect(res.error.field).toBe(field);
      expect(res.error.message).toMatch(/already restored or replaced/);
      expect(await readGrants()).toHaveLength(grantsBefore);
      expect(await readAudit()).toHaveLength(auditsBefore);
      expect(sendPending).not.toHaveBeenCalled();
    }

    it('400s a second grant while a pending ban-term grant names the row (AECI-1615)', async () => {
      expect((await postBanTerm(VENDOR, body([item1]))).status).toBe(201);
      await expectSpent([item1], 'items.0.ended_license_id');
    });

    it('a withdrawn pending grant does not spend the row', async () => {
      expect((await postBanTerm(VENDOR, body([item1]))).status).toBe(201);
      expect((await withdraw(GRANT, { action: 'withdraw', reason: 'Wrong date.' })).status).toBe(
        200,
      );
      expect((await postBanTerm(VENDOR, body([item1], GRANT_2))).status).toBe(201);
    });

    it('400s a second grant after the restored license lapsed', async () => {
      await seedLicense(t.db, VENDOR, {
        productId: P1,
        createdAt: '2026-11-02T00:00:00.000Z',
        endedAt: '2027-04-01T00:00:00.000Z',
        endReason: 'lapsed',
      });
      await expectSpent([item1], 'items.0.ended_license_id');
    });

    it('400s when a license created after the ban replaced it on that product', async () => {
      await seedLicense(t.db, VENDOR, {
        productId: P2,
        source: 'stripe',
        createdAt: '2026-11-02T00:00:00.000Z',
        endedAt: '2026-11-03T00:00:00.000Z',
        endReason: 'lapsed',
      });
      await expectSpent([item1, item2], 'items.1.ended_license_id');
    });

    it('a license on the product created before the ban does not spend the row', async () => {
      await seedLicense(t.db, VENDOR, {
        productId: P1,
        createdAt: '2026-10-01T00:00:00.000Z',
        endedAt: '2026-10-15T00:00:00.000Z',
        endReason: 'lapsed',
      });
      expect((await postBanTerm(VENDOR, body([item1]))).status).toBe(201);
    });
  });

  it('404s a vendor with no billing account', async () => {
    const { status, body: res } = await postBanTerm(OTHER_VENDOR, body());
    expect(status).toBe(404);
    expect(res.error.details).toMatchObject({ resource: 'billing_account' });
  });
});

// ─── PATCH /api/admin/license-grants/:id (AECI-1615) ────────────────────────

async function withdraw(grantId: string, body: unknown, factory?: DbFactory) {
  const execCtx = fakeExecutionContext();
  const res = await app(factory).request(
    `/api/admin/license-grants/${grantId}`,
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

describe('PATCH /api/admin/license-grants/:id: withdraw a pending grant', () => {
  beforeEach(async () => {
    await seedBillingAccount(t.db, VENDOR);
  });

  it('withdraws a pending grant: the row, its audit row, and no license', async () => {
    await post(VENDOR, grant());
    const { status, body } = await withdraw(GRANT, {
      action: 'withdraw',
      reason: ' Granted to the wrong vendor. ',
    });
    expect(status).toBe(200);
    expect(body.vendor_id).toBe(VENDOR);
    expect(body.grant).toMatchObject({
      id: GRANT,
      status: 'withdrawn',
      withdraw_reason: 'Granted to the wrong vendor.',
      decided_by: ADMIN,
    });
    const [row] = await readGrants();
    expect(row).toMatchObject({ status: 'withdrawn', decidedBy: ADMIN });
    const actions = (await readAudit()).map((a) => a.action);
    expect(actions).toEqual(['license_grant.created', 'license_grant.withdrawn']);
    expect(await readLicenses()).toHaveLength(0);
  });

  it('422s a grant that is no longer pending, writing nothing', async () => {
    await post(VENDOR, grant({ signed_deal: deal() }));
    const auditsBefore = (await readAudit()).length;
    const { status, body } = await withdraw(GRANT, { action: 'withdraw', reason: 'Too late.' });
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.INVALID_STATE_TRANSITION);
    expect(body.error.details).toMatchObject({ state: 'accepted' });
    expect(await readAudit()).toHaveLength(auditsBefore);
  });

  it('an accept landing mid-request trips the guard: 422, nothing written', async () => {
    await post(VENDOR, grant());
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db
        .update(licenseGrants)
        .set({ status: 'accepted' })
        .where(eq(licenseGrants.id, GRANT));
    });
    const { status, body } = await withdraw(
      GRANT,
      { action: 'withdraw', reason: 'Wrong vendor.' },
      racing,
    );
    expect(status).toBe(422);
    expect(body.error.details).toMatchObject({ state: 'accepted' });
    expect((await readAudit()).map((a) => a.action)).toEqual(['license_grant.created']);
  });

  it('404s an unknown grant', async () => {
    const { status, body } = await withdraw(u(123), { action: 'withdraw', reason: 'x' });
    expect(status).toBe(404);
    expect(body.error.details).toMatchObject({ resource: 'license_grant' });
  });

  it.each([
    ['a blank reason', { action: 'withdraw', reason: '  ' }],
    ['another action', { action: 'accept', reason: 'x' }],
    ['an unknown key', { action: 'withdraw', reason: 'x', extra: 1 }],
  ])('400s %s', async (_label, payload) => {
    await post(VENDOR, grant());
    const { status } = await withdraw(GRANT, payload);
    expect(status).toBe(400);
    const [row] = await readGrants();
    expect(row!.status).toBe('pending_acceptance');
  });
});
