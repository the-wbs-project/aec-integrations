/**
 * `GET /api/vendor/billing/acceptances` (AECI-1362) over the in-memory D1, with the
 * session stubbed the way `seat-invites.spec.ts` stubs it. The guard itself (401 for
 * anon, the role and ban cells) is in `vendor.authz-matrix.spec.ts`. This file covers
 * what the handler decides: owner seats only, the vendor filter, and the evidence
 * columns never leaving the API.
 */

import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  VendorAgreementAcceptancesResponseSchema,
} from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { billingAccounts, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { agreementAcceptanceStatements } from '../lib/agreement-acceptances';
import type { BatchTuple } from '../lib/audit';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { createVendorBillingAcceptancesHandler } from './vendor-billing-acceptances';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const ACCOUNT = uuid(10);
const OWNER = uuid(100);
const MEMBER = uuid(101);
const OTHER_OWNER = uuid(102);

const session = (over: Partial<AuthzVariables['auth']> = {}): AuthzVariables['auth'] => ({
  userId: OWNER,
  email: 'owner@acme.com',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'verified',
  entitlement: { status: 'active', periodEnd: null },
  ...over,
});

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'acme', companyName: 'Acme' },
    { id: OTHER_VENDOR, slug: 'globex', companyName: 'Globex' },
  ]);
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false },
    { id: OTHER_OWNER, role: 'vendor_admin', vendorId: OTHER_VENDOR, seatOwner: true },
  ]);
  await t.db.insert(billingAccounts).values({ id: ACCOUNT, vendorId: VENDOR, name: 'Acme' });
});
afterEach(() => t.dispose());

async function seed(): Promise<{ claimId: string; checkoutId: string; foreignId: string }> {
  const claim = agreementAcceptanceStatements(t.db, {
    document: 'vendor_terms',
    version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
    source: 'claim',
    email: 'owner@acme.com',
    vendorId: VENDOR,
    acceptedAt: '2026-10-01T00:00:00.000Z',
    requestHeaders: new Headers({ 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'UA/1' }),
    actorType: 'user',
  });
  const checkout = agreementAcceptanceStatements(t.db, {
    document: 'managed_plan',
    version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
    source: 'checkout',
    email: 'billing@acme.com',
    vendorId: VENDOR,
    billingAccountId: ACCOUNT,
    stripeCheckoutSessionId: 'cs_test_1',
    acceptedAt: '2026-10-05T00:00:00.000Z',
    actorType: 'system',
  });
  const foreign = agreementAcceptanceStatements(t.db, {
    document: 'vendor_terms',
    version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
    source: 'claim',
    email: 'someone@globex.com',
    vendorId: OTHER_VENDOR,
    acceptedAt: '2026-10-09T00:00:00.000Z',
    actorType: 'user',
  });
  await t.db.batch([...claim.stmts, ...checkout.stmts, ...foreign.stmts] as BatchTuple);
  return {
    claimId: claim.acceptanceId,
    checkoutId: checkout.acceptanceId,
    foreignId: foreign.acceptanceId,
  };
}

async function call(auth: AuthzVariables['auth']) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.get('/api/vendor/billing/acceptances', createVendorBillingAcceptancesHandler(t.factory));
  const res = await app.fetch(
    new Request('http://x/api/vendor/billing/acceptances'),
    TEST_ENV,
    fakeExecutionContext(),
  );
  return { status: res.status, headers: res.headers, body: (await res.json()) as never };
}

describe('GET /api/vendor/billing/acceptances', () => {
  it('returns the owner’s vendor rows, newest first, without IP or user agent', async () => {
    const ids = await seed();
    const { status, headers, body } = await call(session());
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe('private, no-store');

    const parsed = VendorAgreementAcceptancesResponseSchema.parse(body);
    expect(parsed.acceptances.map((a) => a.id)).toEqual([ids.checkoutId, ids.claimId]);
    expect(parsed.acceptances[0]).toMatchObject({
      document: 'managed_plan',
      source: 'checkout',
      billing_account_id: ACCOUNT,
      stripe_checkout_session_id: 'cs_test_1',
    });
    for (const row of (body as { acceptances: Record<string, unknown>[] }).acceptances) {
      expect(row).not.toHaveProperty('ip');
      expect(row).not.toHaveProperty('user_agent');
      expect(row).not.toHaveProperty('vendor_id');
    }
    expect(JSON.stringify(body)).not.toContain('203.0.113.7');
  });

  it('refuses a non-owner seat with 403', async () => {
    await seed();
    const { status, body } = await call(session({ userId: MEMBER }));
    expect(status).toBe(403);
    expect((body as { error: { code: string } }).error.code).toBe('FORBIDDEN');
  });

  it('refuses an owner of a different vendor reaching for this one', async () => {
    // A session claiming VENDOR for a profile that owns OTHER_VENDOR: the owner re-read
    // pins the profile to the session vendor.
    const { status } = await call(session({ userId: OTHER_OWNER }));
    expect(status).toBe(403);
  });

  it('shows another vendor’s owner only its own rows', async () => {
    const ids = await seed();
    const { body } = await call(session({ userId: OTHER_OWNER, vendorId: OTHER_VENDOR }));
    const parsed = VendorAgreementAcceptancesResponseSchema.parse(body);
    expect(parsed.acceptances.map((a) => a.id)).toEqual([ids.foreignId]);
  });

  it('answers an empty list when the vendor has accepted nothing', async () => {
    const { status, body } = await call(session());
    expect(status).toBe(200);
    expect(body).toEqual({ acceptances: [] });
  });
});
