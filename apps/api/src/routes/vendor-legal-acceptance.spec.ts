/**
 * AECI-1677: `GET` and `POST /api/vendor/legal-acceptance`, over the in-memory D1. The
 * session is stubbed here; `vendor.authz-matrix.spec.ts` composes the real guard, and
 * `vendor-legal-acceptance.registration.spec.ts` pins the guard order and the write block.
 *
 * A version is put in force by a `legal_versions` row whose effective moment has passed:
 * every version in code is a draft today, so that is the only way one can be.
 */
import {
  AcceptLegalVersionResponseSchema,
  ApiErrorCode,
  LEGAL_POLICY_CURRENT_VERSIONS,
  PLANS_PAGE_CURRENT_VERSION,
  portalAcceptanceLabel,
  VendorLegalAcceptanceResponseSchema,
} from '@aeci/shared';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  legalVersions,
  licenses,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { PORTAL_RECORDS_EVIDENCE } from '../lib/agreement-acceptances';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { wrappedFactory } from '../test/racing-factory';
import {
  createAcceptLegalVersionHandler,
  createVendorLegalAcceptanceHandler,
} from './vendor-legal-acceptance';

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
const OWNER_2 = u(102);
const OTHER_OWNER = u(103);
const NOW = new Date('2027-04-15T00:00:00.000Z');
const PAST = Date.parse('2027-03-31T12:00:00.000Z');
const FUTURE = Date.parse('2027-06-30T12:00:00.000Z');

const seat = (userId: string, vendorId = VENDOR): AuthzVariables['auth'] => ({
  userId,
  email: `${userId.slice(-3)}@bentley.example`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'bentley', companyName: 'Bentley', legalName: 'Bentley Systems, Inc.' },
    { id: OTHER, slug: 'autodesk', companyName: 'Autodesk' },
  ]);
  await t.db.insert(profiles).values([
    {
      id: OWNER,
      role: 'vendor_admin',
      vendorId: VENDOR,
      seatOwner: true,
      displayName: 'Olive Owner',
    },
    {
      id: OWNER_2,
      role: 'vendor_admin',
      vendorId: VENDOR,
      seatOwner: true,
      displayName: 'Ada Admin',
    },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, displayName: 'Mo Member' },
    { id: OTHER_OWNER, role: 'vendor_admin', vendorId: OTHER, seatOwner: true },
  ]);
});
afterEach(() => t.dispose());

async function publish(over: Partial<typeof legalVersions.$inferInsert> = {}) {
  await t.db.insert(legalVersions).values({
    document: 'vendor_terms',
    version: '1.4',
    effectiveAt: PAST,
    summaryJson: JSON.stringify(['The liability cap names the fees paid.']),
    material: true,
    requiresAcceptance: false,
    pdfKey: 'legal/vendor-terms/v1.4.pdf',
    pdfSha256: 'a'.repeat(64),
    pdfBytes: 1000,
    publishedBy: u(900),
    publishedAt: '2027-02-01T00:00:00.000Z',
    ...over,
  });
}

async function acceptanceOf(version: string, document = 'vendor_terms', vendorId = VENDOR) {
  await t.db.insert(agreementAcceptances).values({
    id: crypto.randomUUID(),
    document,
    version,
    source: 'claim',
    email: 'claim@bentley.example',
    vendorId,
    acceptedAt: '2026-11-11T00:00:00.000Z',
  });
}

function app(auth: AuthzVariables['auth'], factory: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get(
    '/api/vendor/legal-acceptance',
    createVendorLegalAcceptanceHandler(factory, () => NOW),
  );
  a.post(
    '/api/vendor/legal-acceptance',
    createAcceptLegalVersionHandler(factory, () => NOW),
  );
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function read(auth = seat(OWNER)) {
  const res = await app(auth).request(
    '/api/vendor/legal-acceptance',
    {},
    TEST_ENV,
    fakeExecutionContext(),
  );
  const body = (await res.json()) as JsonBody;
  if (res.status === 200) VendorLegalAcceptanceResponseSchema.parse(body);
  return { status: res.status, body };
}

const acceptBody = (over: Record<string, unknown> = {}) => ({
  document: 'vendor_terms',
  version: '1.4',
  accepted: true,
  signer_title: 'Head of Partnerships',
  company_legal_name: 'Bentley Systems, Inc.',
  ...over,
});

async function accept(payload: unknown = acceptBody(), auth = seat(OWNER), factory?: DbFactory) {
  const res = await app(auth, factory).request(
    '/api/vendor/legal-acceptance',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.7',
        'user-agent': 'Mozilla/5.0 (Test)',
      },
      body: JSON.stringify(payload),
    },
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { status: res.status, body: (await res.json()) as JsonBody };
}

const portalRows = () =>
  t.db.select().from(agreementAcceptances).where(eq(agreementAcceptances.source, 'portal'));
const acceptedAudit = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, 'agreement.accepted'));

describe('nothing in force: no prompt, no block', () => {
  it.each([
    ['owner', OWNER],
    ['member', MEMBER],
  ])('the %s seat sees nothing pending, with draft-only acceptances', async (_l, who) => {
    await acceptanceOf('1.3');
    const { status, body } = await read(seat(who));
    expect(status).toBe(200);
    expect(body).toMatchObject({ blocked: false, pending: [], owner_names: [] });
  });

  it('a published version that needs acceptance but is not in force pends nothing', async () => {
    await publish({ effectiveAt: FUTURE, requiresAcceptance: true });
    expect((await read()).body).toMatchObject({ blocked: false, pending: [] });
  });

  it('refuses any accept with 422, writing nothing', async () => {
    const { status, body } = await accept(acceptBody({ version: '1.3' }));
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.LEGAL_ACCEPTANCE_NOT_PENDING);
    expect(await portalRows()).toEqual([]);
  });
});

describe('required mode: a draft-only company and a version in force (ruling 24)', () => {
  beforeEach(async () => {
    await publish();
    await acceptanceOf('1.3');
  });

  it('blocks the owner, with the version, the summary, the fixed copy and the pre-fill', async () => {
    const { body } = await read();
    expect(body).toMatchObject({
      blocked: true,
      can_accept: true,
      owner_names: [],
      signer: { legal_name: 'Bentley Systems, Inc.' },
    });
    expect(body.pending).toEqual([
      {
        document: 'vendor_terms',
        version: '1.4',
        mode: 'required',
        effective_at: '2027-03-31T12:00:00.000Z',
        in_force: true,
        summary: ['The liability cap names the fees paid.'],
        page_path: '/legal/vendor-terms/v1.4',
      },
    ]);
  });

  it('tells a member seat who the owners are, and gives it nothing to accept', async () => {
    const { body } = await read(seat(MEMBER));
    expect(body).toMatchObject({ blocked: true, can_accept: false, signer: null });
    expect(body.owner_names).toEqual(['Ada Admin', 'Olive Owner']);
    expect(body.pending.map((p: JsonBody) => p.mode)).toEqual(['required']);
  });

  it('another vendor is not blocked by this one', async () => {
    await acceptanceOf('1.4', 'vendor_terms', OTHER);
    expect((await read(seat(OTHER_OWNER, OTHER))).body).toMatchObject({ blocked: false });
  });

  it('records the acceptance as a claim is recorded, and opens the portal', async () => {
    const { status, body } = await accept();
    expect(status).toBe(201);
    AcceptLegalVersionResponseSchema.parse(body);
    expect(body).toMatchObject({ document: 'vendor_terms', version: '1.4' });
    expect(body.state).toMatchObject({ blocked: false, pending: [] });

    const [row] = await portalRows();
    const label = portalAcceptanceLabel('vendor_terms', '1.4', 'Bentley');
    expect(row).toMatchObject({
      document: 'vendor_terms',
      version: '1.4',
      source: 'portal',
      email: '100@bentley.example',
      profileId: OWNER,
      vendorId: VENDOR,
      acceptedAt: NOW.toISOString(),
      signerName: 'Olive Owner',
      signerTitle: 'Head of Partnerships',
      companyLegalName: 'Bentley Systems, Inc.',
      checkboxLabel: label,
      checkboxLabelSha256: createHash('sha256').update(label).digest('hex'),
      checkboxDefaultUnticked: true,
      listingAccuracyVersion: LEGAL_POLICY_CURRENT_VERSIONS.listing_accuracy,
      reviewGuidelinesVersion: LEGAL_POLICY_CURRENT_VERSIONS.review_guidelines,
      plansPageVersion: null,
    });
    expect(label).toBe(
      'I have read and accept the Vendor Terms, version 1.4, on behalf of Bentley, and I am authorized to bind that company.',
    );
    // Not until the Privacy Policy names this acceptance (`PORTAL_RECORDS_EVIDENCE`).
    expect(PORTAL_RECORDS_EVIDENCE).toBe(false);
    expect(row).toMatchObject({ ip: null, userAgent: null });

    const [audit] = await acceptedAudit();
    expect(audit).toMatchObject({ entityId: row?.id, vendorId: VENDOR, actorId: OWNER });
    expect(JSON.stringify(audit)).not.toContain('Head of Partnerships');

    // The other owner sees the portal open too: any owner accepts for the company.
    expect((await read(seat(OWNER_2))).body).toMatchObject({ blocked: false });
    expect((await read(seat(MEMBER))).body).toMatchObject({ blocked: false, owner_names: [] });
  });

  it('puts the acceptance and its audit row in one batch, and writes neither if it fails', async () => {
    const sizes: number[] = [];
    const recording = wrappedFactory(t.factory, (_n, run, stmts) => {
      sizes.push((stmts as unknown[]).length);
      return run();
    });
    expect((await accept(acceptBody(), seat(OWNER), recording)).status).toBe(201);
    // The read batch (3), the write batch (2), the state read after (3).
    expect(sizes).toEqual([3, 2, 3]);

    await t.db.delete(agreementAcceptances).where(eq(agreementAcceptances.source, 'portal'));
    await t.db.delete(auditLog);
    const failing = wrappedFactory(t.factory, (n, run) =>
      n === 2 ? Promise.reject(new Error('D1 down')) : run(),
    );
    expect((await accept(acceptBody(), seat(OWNER), failing)).status).toBe(500);
    expect(await portalRows()).toEqual([]);
    expect(await acceptedAudit()).toEqual([]);
  });

  it('refuses a member seat with 403, writing nothing', async () => {
    const { status } = await accept(acceptBody(), seat(MEMBER));
    expect(status).toBe(403);
    expect(await portalRows()).toEqual([]);
  });

  it.each([
    ['a version that is not pending', { version: '1.3' }],
    ['an unknown version', { version: '9.9' }],
    ['the wrong document', { document: 'managed_plan' }],
  ])('refuses %s with 422', async (_l, over) => {
    const { status, body } = await accept(acceptBody(over));
    expect(status).toBe(422);
    expect(body.error.code).toBe(ApiErrorCode.LEGAL_ACCEPTANCE_NOT_PENDING);
    expect(await portalRows()).toEqual([]);
  });

  it('refuses a version already accepted with 422', async () => {
    expect((await accept()).status).toBe(201);
    const again = await accept(acceptBody(), seat(OWNER_2));
    expect(again.status).toBe(422);
    expect(await portalRows()).toHaveLength(1);
  });

  it.each([
    ['an unticked box', { accepted: false }],
    ['no title', { signer_title: '  ' }],
    ['no legal name', { company_legal_name: '' }],
    ['an extra field', { vendor_id: OTHER }],
  ])('refuses %s with 400', async (_l, over) => {
    expect((await accept(acceptBody(over))).status).toBe(400);
    expect(await portalRows()).toEqual([]);
  });

  it('never trusts a vendor from the request: the session vendor is the one accepted for', async () => {
    const { status } = await accept(acceptBody(), seat(OTHER_OWNER, OTHER));
    expect(status).toBe(201);
    const [row] = await portalRows();
    expect(row?.vendorId).toBe(OTHER);
    expect((await read()).body).toMatchObject({ blocked: true });
  });
});

describe('optional mode', () => {
  it('prompts a covered owner for a newer Vendor Terms version that needs acceptance', async () => {
    await publish();
    await publish({ version: '1.5', effectiveAt: FUTURE, requiresAcceptance: true });
    await acceptanceOf('1.4');
    expect((await read()).body).toMatchObject({
      blocked: false,
      pending: [expect.objectContaining({ version: '1.5', mode: 'optional', in_force: false })],
    });
    // A member seat is not prompted.
    expect((await read(seat(MEMBER))).body).toMatchObject({ blocked: false, pending: [] });
    const { status, body } = await accept(acceptBody({ version: '1.5' }));
    expect(status).toBe(201);
    expect(body.state.pending).toEqual([]);
  });

  describe('the Managed plan agreement', () => {
    beforeEach(async () => {
      await publish({ document: 'managed_plan', version: '1.2', pdfKey: 'legal/m/v1.2.pdf' });
      await publish({
        document: 'managed_plan',
        version: '1.3',
        effectiveAt: FUTURE,
        requiresAcceptance: true,
        pdfKey: 'legal/m/v1.3.pdf',
      });
      await acceptanceOf('1.2', 'managed_plan');
    });

    it('is not shown without a live monthly card subscription', async () => {
      await seedLicense(t.db, VENDOR, { source: 'complimentary' });
      expect((await read()).body.pending).toEqual([]);
      expect((await accept(acceptBody({ document: 'managed_plan', version: '1.3' }))).status).toBe(
        422,
      );
    });

    it('is shown to an owner with one, and records the click and the Plans page', async () => {
      const id = await seedLicense(t.db, VENDOR, { source: 'stripe' });
      await t.db.update(licenses).set({ stripeSubscriptionId: 'sub_1' }).where(eq(licenses.id, id));
      expect((await read()).body.pending).toEqual([
        expect.objectContaining({ document: 'managed_plan', version: '1.3', mode: 'optional' }),
      ]);
      const { status } = await accept(acceptBody({ document: 'managed_plan', version: '1.3' }));
      expect(status).toBe(201);
      const [row] = await portalRows();
      expect(row).toMatchObject({
        document: 'managed_plan',
        version: '1.3',
        billingAccountId: await seedBillingAccount(t.db, VENDOR),
        checkboxLabel: portalAcceptanceLabel('managed_plan', '1.3', 'Bentley'),
        plansPageVersion: PLANS_PAGE_CURRENT_VERSION,
        listingAccuracyVersion: null,
      });
      // The click changes no subscription.
      const [license] = await t.db.select().from(licenses).where(eq(licenses.id, id));
      expect(license).toMatchObject({ endedAt: null, cancelAtTermEnd: false });
    });
  });
});
