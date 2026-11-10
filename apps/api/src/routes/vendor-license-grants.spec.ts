/**
 * `POST /api/vendor/license-grants/:id/accept` (AECI-1615, counsel Q5): an owner seat
 * accepts a pending grant, against the in-memory D1 harness. A stub middleware sets the
 * `auth` Variable; the authz matrix (`vendor.authz-matrix.spec.ts`) runs the real guard.
 *
 * What it must hold:
 *   - the accept writes the acceptance row and the licenses in ONE batch, and a batch
 *     that aborts (a race on the status, a seat ban, a product licensed meanwhile) leaves
 *     neither;
 *   - a member seat gets 403; another vendor's grant is 404;
 *   - a stale version is 409 LICENSE_GRANT_VERSION_CHANGED; a grant that is not pending
 *     or is past its end is 422 LICENSE_GRANT_NOT_PENDING;
 *   - a ban-term item whose product took a live license, or left the vendor, meanwhile
 *     lands in the pool, with a warning (ruling R6); a product that leaves between the
 *     read and the batch is 409 LICENSE_GRANT_PRODUCTS_CHANGED, nothing written.
 */

import {
  AcceptLicenseGrantResponseSchema,
  AGREEMENT_CHECKBOX_LABELS,
  ApiErrorCode,
  LEGAL_AGREEMENT_TEXT_SHA256,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  licenseGrants,
  licenses,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { grantLicenseIds } from '../lib/license-grants';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { racingFactory } from '../test/racing-factory';
import { BAN_TERM_REFERENCE, type SendLicensesGranted } from './admin-licenses';
import { createAcceptLicenseGrantHandler } from './vendor-license-grants';

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
const ADMIN = u(900);
const P1 = u(10);
const P2 = u(11);
const GRANT = '11111111-1111-4111-8111-111111111111';
const END_ISO = '2027-06-30T00:00:00.000Z';
const END_2_ISO = '2027-08-31T00:00:00.000Z';

const seat = (userId: string, vendorId: string): AuthzVariables['auth'] => ({
  userId,
  email: `${userId.slice(-3)}@bentley.example`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});

let t: TestDb;
let accountId: string;
let queueSend: ReturnType<typeof vi.fn>;
let queueSendBatch: ReturnType<typeof vi.fn>;
let sendGranted: ReturnType<typeof vi.fn>;
const fetchSeatEmails = vi.fn(
  async (_env: Env, ids: readonly string[]) =>
    new Map(ids.map((id) => [id, `seat-${id.slice(-3)}@bentley.example`])),
);

beforeEach(async () => {
  t = await makeTestDb();
  queueSend = vi.fn(async () => undefined);
  queueSendBatch = vi.fn(async () => undefined);
  sendGranted = vi.fn(async () => 'sent' as const);
  await t.db.insert(vendors).values([
    {
      id: VENDOR,
      slug: 'bentley',
      companyName: 'Bentley',
      legalName: 'Bentley Systems, Inc.',
      verified: false,
    },
    { id: OTHER, slug: 'autodesk', companyName: 'Autodesk', verified: false },
  ]);
  await t.db.insert(profiles).values([
    {
      id: OWNER,
      role: 'vendor_admin',
      vendorId: VENDOR,
      seatOwner: true,
      displayName: 'Olive Owner',
    },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR },
  ]);
  await t.db.insert(products).values([
    { id: P1, slug: 'openroads', name: 'OpenRoads', promotionStatus: 'promoted' },
    { id: P2, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P1, vendorId: VENDOR, isPrimary: true },
    { productId: P2, vendorId: VENDOR, isPrimary: true },
  ]);
  accountId = await seedBillingAccount(t.db, VENDOR);
});
afterEach(() => t.dispose());

async function seedGrant(over: Partial<typeof licenseGrants.$inferInsert> = {}) {
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
    grantedBy: ADMIN,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  });
}

/** A pending ban-term grant restoring P1 (until END_ISO) and P2 (until END_2_ISO). */
async function seedBanTermGrant() {
  await seedGrant({
    kind: 'ban_term',
    quantity: 2,
    endsAt: END_2_ISO,
    reference: BAN_TERM_REFERENCE,
    itemsJson: JSON.stringify([
      { ended_license_id: u(60), product_id: P1, ends_at: END_ISO },
      { ended_license_id: u(61), product_id: P2, ends_at: END_2_ISO },
    ]),
  });
}

function app(auth: AuthzVariables['auth'], factory: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post(
    '/api/vendor/license-grants/:id/accept',
    createAcceptLicenseGrantHandler(
      factory,
      fetchSeatEmails,
      sendGranted as unknown as SendLicensesGranted,
    ),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

const body = (over: Record<string, unknown> = {}) => ({
  accepted: true,
  version: '1.1',
  signer_title: 'Head of Partnerships',
  ...over,
});

async function accept(
  payload: unknown = body(),
  opts: { auth?: AuthzVariables['auth']; factory?: DbFactory; grantId?: string } = {},
) {
  const execCtx = fakeExecutionContext();
  const res = await app(opts.auth ?? seat(OWNER, VENDOR), opts.factory).request(
    `/api/vendor/license-grants/${opts.grantId ?? GRANT}/accept`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.7',
        'user-agent': 'Mozilla/5.0 (Test)',
      },
      body: JSON.stringify(payload),
    },
    {
      ...TEST_ENV,
      CACHE_PURGE_QUEUE: { send: queueSend, sendBatch: queueSendBatch },
    } as unknown as Env,
    execCtx,
  );
  const json = (await res.json()) as JsonBody;
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
  return { status: res.status, body: json };
}

const readLicenses = () => t.db.select().from(licenses);
const readAcceptances = () => t.db.select().from(agreementAcceptances);
const readAudit = () => t.db.select().from(auditLog);
const readGrant = async () =>
  (await t.db.select().from(licenseGrants).where(eq(licenseGrants.id, GRANT)))[0]!;

/** The batch never committed: no acceptance, no license, no audit row, no email. */
async function nothingWritten() {
  expect(await readAcceptances()).toHaveLength(0);
  expect((await readLicenses()).filter((l) => l.licenseGrantId === GRANT)).toHaveLength(0);
  expect(await readAudit()).toHaveLength(0);
  expect(sendGranted).not.toHaveBeenCalled();
}

describe('POST /api/vendor/license-grants/:id/accept', () => {
  it('writes the acceptance and the licenses together, in one batch', async () => {
    await seedGrant();
    const { status, body: res } = await accept();
    expect(status).toBe(200);
    expect(AcceptLicenseGrantResponseSchema.parse(res)).toBeTruthy();
    const ids = await grantLicenseIds(GRANT, 2);
    expect(res).toMatchObject({ grant_id: GRANT, status: 'accepted', license_ids: ids });
    expect(res.warnings).toEqual([]);

    const [acceptance] = await readAcceptances();
    expect(acceptance).toMatchObject({
      id: res.acceptance_id,
      document: 'managed_plan',
      version: '1.1',
      source: 'grant',
      method: 'portal_checkbox',
      email: '100@bentley.example',
      profileId: OWNER,
      vendorId: VENDOR,
      billingAccountId: accountId,
      licenseGrantId: GRANT,
      grantEndsAt: END_ISO,
      textSha256: LEGAL_AGREEMENT_TEXT_SHA256.managed_plan['1.1'],
      // Ruling 16: the Billing tab's box, which always starts unticked.
      checkboxLabelSha256: AGREEMENT_CHECKBOX_LABELS.managed_plan.sha256,
      checkboxDefaultUnticked: true,
      seatRole: 'owner',
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Test)',
      signerName: 'Olive Owner',
      signerTitle: 'Head of Partnerships',
      companyLegalName: 'Bentley Systems, Inc.',
      dealReference: null,
    });

    const rows = await readLicenses();
    expect(rows.map((r) => r.id).sort()).toEqual([...ids].sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        billingAccountId: accountId,
        source: 'complimentary',
        endsAt: END_ISO,
        endedAt: null,
        assignedProductId: null,
        licenseGrantId: GRANT,
        termsVersion: '1.1',
        grantedBy: ADMIN,
      });
    }
    expect(await readGrant()).toMatchObject({
      status: 'accepted',
      acceptanceId: acceptance!.id,
      decidedBy: OWNER,
    });

    const audits = await readAudit();
    expect(audits.map((a) => a.action)).toEqual([
      'agreement.accepted',
      'license.granted',
      'license.granted',
      'license_grant.accepted',
    ]);
    for (const a of audits) expect(a.vendorId).toBe(VENDOR);
    // The audit rows carry no email, IP, user agent or signer.
    const text = JSON.stringify(audits);
    for (const secret of ['100@bentley.example', '203.0.113.7', 'Mozilla', 'Olive Owner']) {
      expect(text).not.toContain(secret);
    }

    // The first live license flips the mirror and purges the vendor set.
    const [v] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(v!.verified).toBe(true);
    expect(queueSend).toHaveBeenCalledWith({
      tags: expect.arrayContaining(['vendor:bentley']),
      source: 'vendor',
    });
  });

  it('starts the licenses at the requested start when it is still ahead', async () => {
    await seedGrant({ startsAt: '2027-01-01T00:00:00.000Z' });
    await accept();
    for (const row of await readLicenses()) expect(row.startsAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('starts the licenses now when the requested start has passed', async () => {
    await seedGrant({ startsAt: '2020-01-01T00:00:00.000Z' });
    const before = Date.now();
    await accept();
    for (const row of await readLicenses()) {
      expect(Date.parse(row.startsAt)).toBeGreaterThanOrEqual(before - 1000);
    }
  });

  it('sends licenses-granted with the grant key, after the commit', async () => {
    await seedGrant({ source: 'invoice', reference: 'PO-9' });
    await accept();
    expect(sendGranted).toHaveBeenCalledTimes(2);
    expect(sendGranted.mock.calls[0]![1]).toMatchObject({
      count: 2,
      source: 'invoice',
      reference: 'PO-9',
      endsAt: END_ISO,
    });
    expect((sendGranted.mock.calls[0]![1] as JsonBody).dedupeKey).toMatch(
      new RegExp(`^licenses-granted:${GRANT}:`),
    );
  });

  it('403s a member seat, writing nothing', async () => {
    await seedGrant();
    const { status, body: res } = await accept(body(), { auth: seat(MEMBER, VENDOR) });
    expect(status).toBe(403);
    expect(res.error.code).toBe('FORBIDDEN');
    expect((await readGrant()).status).toBe('pending_acceptance');
    await nothingWritten();
  });

  it("404s another vendor's grant, the same as an unknown one", async () => {
    await t.db
      .insert(profiles)
      .values({ id: u(102), role: 'vendor_admin', vendorId: OTHER, seatOwner: true });
    await seedGrant();
    const theirs = await accept(body(), { auth: seat(u(102), OTHER) });
    const unknown = await accept(body(), { grantId: u(999) });
    expect(theirs.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(theirs.body.error.details).toMatchObject({ resource: 'license_grant' });
    await nothingWritten();
  });

  it('409s LICENSE_GRANT_VERSION_CHANGED on a version the grant does not pin', async () => {
    await seedGrant({ termsVersion: '1.0' });
    const { status, body: res } = await accept(body({ version: '1.1' }));
    expect(status).toBe(409);
    expect(res.error.code).toBe(ApiErrorCode.LICENSE_GRANT_VERSION_CHANGED);
    expect(res.error.details).toMatchObject({ terms_version: '1.0' });
    await nothingWritten();
  });

  it('accepts a superseded version when it is the one the grant pinned', async () => {
    await seedGrant({ termsVersion: '1.0' });
    const { status } = await accept(body({ version: '1.0' }));
    expect(status).toBe(200);
    const [acceptance] = await readAcceptances();
    expect(acceptance).toMatchObject({
      version: '1.0',
      textSha256: LEGAL_AGREEMENT_TEXT_SHA256.managed_plan['1.0'],
    });
  });

  it.each(['accepted', 'withdrawn', 'expired'])(
    '422s LICENSE_GRANT_NOT_PENDING on a %s grant',
    async (state) => {
      await seedGrant({ status: state });
      const { status, body: res } = await accept();
      expect(status).toBe(422);
      expect(res.error.code).toBe(ApiErrorCode.LICENSE_GRANT_NOT_PENDING);
      expect(res.error.details).toMatchObject({ state });
      await nothingWritten();
    },
  );

  it('422s a pending grant past its end date (the sweep has not run yet)', async () => {
    await seedGrant({ endsAt: '2026-01-01T00:00:00.000Z' });
    const { status, body: res } = await accept();
    expect(status).toBe(422);
    expect(res.error.details).toMatchObject({ state: 'expired' });
    await nothingWritten();
  });

  it.each([
    ['the box not ticked', { accepted: false }],
    ['no title', { signer_title: '  ' }],
    ['no version', { version: undefined }],
    ['an unknown key', { product_id: P1 }],
  ])('400s %s', async (_label, over) => {
    await seedGrant();
    const { status } = await accept(body(over));
    expect(status).toBe(400);
    await nothingWritten();
  });

  // The sentinel: a withdraw (or a second accept) that commits between the read and the
  // batch. The acceptance and the licenses are in the same batch, so neither lands.
  it('a withdraw landing mid-request trips the sentinel: 422, neither acceptance nor licenses', async () => {
    await seedGrant();
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db
        .update(licenseGrants)
        .set({ status: 'withdrawn' })
        .where(eq(licenseGrants.id, GRANT));
    });
    const { status, body: res } = await accept(body(), { factory: racing });
    expect(status).toBe(422);
    expect(res.error.code).toBe(ApiErrorCode.LICENSE_GRANT_NOT_PENDING);
    expect(res.error.details).toMatchObject({ state: 'withdrawn' });
    await nothingWritten();
  });

  it('a second accept of the same grant writes nothing more', async () => {
    await seedGrant();
    expect((await accept()).status).toBe(200);
    sendGranted.mockClear();
    const auditsBefore = (await readAudit()).length;
    const again = await accept();
    expect(again.status).toBe(422);
    expect(await readAcceptances()).toHaveLength(1);
    expect(await readLicenses()).toHaveLength(2);
    expect(await readAudit()).toHaveLength(auditsBefore);
    expect(sendGranted).not.toHaveBeenCalled();
  });

  it('a last-seat ban landing mid-request aborts: 409 VENDOR_SEATS_CHANGED, nothing written', async () => {
    await seedGrant();
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db
        .update(profiles)
        .set({ bannedAt: '2026-11-10T00:00:00.000Z' })
        .where(eq(profiles.vendorId, VENDOR));
    });
    const { status, body: res } = await accept(body(), { factory: racing });
    expect(status).toBe(409);
    expect(res.error.code).toBe(ApiErrorCode.VENDOR_SEATS_CHANGED);
    expect((await readGrant()).status).toBe('pending_acceptance');
    await nothingWritten();
  });
});

describe('accepting a ban-term grant (rulings R1 and R6)', () => {
  it('assigns each item to its product, with its own end date, and purges each product', async () => {
    await seedBanTermGrant();
    const { status, body: res } = await accept();
    expect(status).toBe(200);
    expect(res.warnings).toEqual([]);
    const ids = await grantLicenseIds(GRANT, 2);
    const rows = await readLicenses();
    expect(rows.find((r) => r.id === ids[0])).toMatchObject({
      assignedProductId: P1,
      endsAt: END_ISO,
      reference: BAN_TERM_REFERENCE,
      licenseGrantId: GRANT,
    });
    expect(rows.find((r) => r.id === ids[1])).toMatchObject({
      assignedProductId: P2,
      endsAt: END_2_ISO,
    });
    expect(queueSendBatch).toHaveBeenCalledTimes(1);
    const [batch] = queueSendBatch.mock.calls[0]! as [{ body: { tags: string[] } }[]];
    expect(new Set(batch[0]!.body.tags)).toEqual(
      new Set(['product:openroads', 'product:microstation', 'index:products', 'vendor:bentley']),
    );
    // One email per end date per address, keyed apart.
    const keys = sendGranted.mock.calls.map((call) => (call[1] as JsonBody).dedupeKey as string);
    expect(
      keys.some((k) => k.startsWith(`licenses-granted:${GRANT}:${END_ISO.toLowerCase()}:`)),
    ).toBe(true);
    expect(new Set(keys).size).toBe(sendGranted.mock.calls.length);
  });

  it('lands an item whose product took a live license meanwhile in the pool, with a warning', async () => {
    await seedBanTermGrant();
    await seedLicense(t.db, OTHER, { productId: P2 });
    const { status, body: res } = await accept();
    expect(status).toBe(200);
    expect(res.warnings).toEqual([
      expect.objectContaining({ code: 'product_already_licensed', product_id: P2 }),
    ]);
    const ids = await grantLicenseIds(GRANT, 2);
    const rows = await readLicenses();
    expect(rows.find((r) => r.id === ids[0])!.assignedProductId).toBe(P1);
    expect(rows.find((r) => r.id === ids[1])).toMatchObject({
      assignedProductId: null,
      endsAt: END_2_ISO,
      endedAt: null,
    });
    const accepted = (await readAudit()).find((a) => a.action === 'license_grant.accepted')!;
    expect(accepted.metadata).toMatchObject({ pooled_product_ids: [P2] });
  });

  it('skips an item whose own term passed while the grant waited', async () => {
    await seedGrant({
      kind: 'ban_term',
      quantity: 2,
      endsAt: END_2_ISO,
      reference: BAN_TERM_REFERENCE,
      itemsJson: JSON.stringify([
        { ended_license_id: u(60), product_id: P1, ends_at: '2026-01-01T00:00:00.000Z' },
        { ended_license_id: u(61), product_id: P2, ends_at: END_2_ISO },
      ]),
    });
    const { status, body: res } = await accept();
    expect(status).toBe(200);
    const ids = await grantLicenseIds(GRANT, 2);
    expect(res.license_ids).toEqual([ids[1]]);
    const rows = await readLicenses();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assignedProductId: P2 });
    const accepted = (await readAudit()).find((a) => a.action === 'license_grant.accepted')!;
    expect(accepted.metadata).toMatchObject({ lapsed_item_product_ids: [P1] });
  });

  it('a product licensed between the read and the batch fails the whole batch: 409, nothing written', async () => {
    await seedBanTermGrant();
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await seedLicense(t.db, OTHER, { productId: P1 });
    });
    const { status, body: res } = await accept(body(), { factory: racing });
    expect(status).toBe(409);
    expect(res.error.code).toBe(ApiErrorCode.PRODUCT_ALREADY_LICENSED);
    expect((await readGrant()).status).toBe('pending_acceptance');
    await nothingWritten();
  });

  it('lands an item whose product left the vendor meanwhile in the pool, with a warning', async () => {
    await seedBanTermGrant();
    await t.db.delete(productVendors).where(eq(productVendors.productId, P2));
    const { status, body: res } = await accept();
    expect(status).toBe(200);
    expect(res.warnings).toEqual([
      expect.objectContaining({ code: 'product_not_owned', product_id: P2 }),
    ]);
    const ids = await grantLicenseIds(GRANT, 2);
    const rows = await readLicenses();
    expect(rows.find((r) => r.id === ids[0])!.assignedProductId).toBe(P1);
    expect(rows.find((r) => r.id === ids[1])).toMatchObject({
      assignedProductId: null,
      endsAt: END_2_ISO,
      endedAt: null,
    });
    const accepted = (await readAudit()).find((a) => a.action === 'license_grant.accepted')!;
    expect(accepted.metadata).toMatchObject({ not_owned_product_ids: [P2] });
    expect(accepted.metadata).not.toHaveProperty('pooled_product_ids');
  });

  it('a product that leaves the vendor between the read and the batch fails the whole batch: 409, nothing written', async () => {
    await seedBanTermGrant();
    const racing = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db.delete(productVendors).where(eq(productVendors.productId, P1));
    });
    const { status, body: res } = await accept(body(), { factory: racing });
    expect(status).toBe(409);
    expect(res.error.code).toBe(ApiErrorCode.LICENSE_GRANT_PRODUCTS_CHANGED);
    expect((await readGrant()).status).toBe('pending_acceptance');
    await nothingWritten();
  });
});
