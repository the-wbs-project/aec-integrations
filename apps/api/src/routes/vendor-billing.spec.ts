/**
 * `GET /api/vendor/billing` (AECI-1387, E5.1) over the in-memory D1, with the session
 * stubbed the way `vendor-billing-acceptances.spec.ts` stubs it. The guard cells (401
 * for anon, the role and ban cells) are in `vendor.authz-matrix.spec.ts`. This file
 * covers what the handler decides: owner seats only, the vendor filter on licenses,
 * the open release request, and which products a pool license may go on.
 */

import { VendorBillingResponseSchema, type VendorBillingResponse } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  billingAccounts,
  licenseReleaseRequests,
  licenses,
  products,
  productVendors,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { StripeClient, StripeSubscription } from '../lib/stripe';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import { createVendorBillingHandler } from './vendor-billing';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OTHER_VENDOR = uuid(2);
const OWNER = uuid(100);
const MEMBER = uuid(101);
const OTHER_OWNER = uuid(102);

// Names chosen so a binary sort and a case-insensitive one disagree: `alpha` < `Beta`.
const P_ALPHA = uuid(10); // ours; only an ENDED license of ours ever sat on it
const P_BETA = uuid(11); // ours; never licensed
const P_LICENSED = uuid(12); // ours; a live license of ours is on it
const P_COOWNED = uuid(13); // co-owned; the OTHER vendor's live license is on it
const P_FOREIGN = uuid(14); // the other vendor's alone

const session = (over: Partial<AuthzVariables['auth']> = {}): AuthzVariables['auth'] => ({
  userId: OWNER,
  email: 'owner@acme.com',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'unclaimed',
  entitlement: null,
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
  await t.db.insert(products).values([
    { id: P_ALPHA, slug: 'alpha', name: 'alpha' },
    { id: P_BETA, slug: 'beta', name: 'Beta' },
    { id: P_LICENSED, slug: 'licensed', name: 'Licensed' },
    { id: P_COOWNED, slug: 'coowned', name: 'Co-owned' },
    { id: P_FOREIGN, slug: 'foreign', name: 'Foreign' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_ALPHA, vendorId: VENDOR, isPrimary: true },
    { productId: P_BETA, vendorId: VENDOR, isPrimary: true },
    { productId: P_LICENSED, vendorId: VENDOR, isPrimary: true },
    { productId: P_COOWNED, vendorId: OTHER_VENDOR, isPrimary: true },
    { productId: P_COOWNED, vendorId: VENDOR, isPrimary: false },
    { productId: P_FOREIGN, vendorId: OTHER_VENDOR, isPrimary: true },
  ]);
});
afterEach(() => t.dispose());

interface Seeded {
  account: string;
  assigned: string;
  pool: string;
  ended: string;
  foreign: string;
  openRequest: string;
}

async function seed(): Promise<Seeded> {
  const account = await seedBillingAccount(t.db, VENDOR);
  await t.db
    .update(billingAccounts)
    .set({ billingEmail: 'billing@acme.com' })
    .where(eq(billingAccounts.id, account));
  const assigned = await seedLicense(t.db, VENDOR, {
    productId: P_LICENSED,
    source: 'invoice',
    endsAt: '2027-06-30T00:00:00.000Z',
  });
  await t.db.update(licenses).set({ reference: 'PO-1234' }).where(eq(licenses.id, assigned));
  const pool = await seedLicense(t.db, VENDOR);
  const ended = await seedLicense(t.db, VENDOR, {
    productId: P_ALPHA,
    endedAt: '2026-05-01T00:00:00.000Z',
    endReason: 'expired',
  });
  const foreign = await seedLicense(t.db, OTHER_VENDOR, { productId: P_COOWNED });

  const openRequest = uuid(500);
  const request = {
    licenseId: assigned,
    vendorId: VENDOR,
    billingAccountId: account,
    productId: P_LICENSED,
    requestedBy: OWNER,
    reason: 'We sold the product line.',
  };
  await t.db.insert(licenseReleaseRequests).values([
    // A decided request on the same license must neither show nor fan the row out.
    { ...request, id: uuid(501), status: 'declined', createdAt: '2026-08-01T00:00:00.000Z' },
    { ...request, id: openRequest, status: 'open', createdAt: '2026-09-01T00:00:00.000Z' },
  ]);
  return { account, assigned, pool, ended, foreign, openRequest };
}

async function call(
  auth: AuthzVariables['auth'],
  { env = TEST_ENV, stripe = null }: { env?: Env; stripe?: StripeClient | null } = {},
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  app.get(
    '/api/vendor/billing',
    createVendorBillingHandler(t.factory, () => stripe),
  );
  const res = await app.fetch(
    new Request('http://x/api/vendor/billing'),
    env,
    fakeExecutionContext(),
  );
  return { status: res.status, headers: res.headers, body: (await res.json()) as never };
}

describe('GET /api/vendor/billing', () => {
  it('returns the owner’s account, licenses (live first) and assignable products', async () => {
    const ids = await seed();
    const { status, headers, body } = await call(session());
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe('private, no-store');

    const parsed: VendorBillingResponse = VendorBillingResponseSchema.parse(body);
    expect(parsed.billing_account).toEqual({ id: ids.account, billing_email: 'billing@acme.com' });
    expect(parsed.licenses.map((l) => l.id)).toEqual([ids.assigned, ids.pool, ids.ended]);
    expect(parsed.licenses_truncated).toBe(false);

    expect(parsed.licenses[0]).toEqual({
      id: ids.assigned,
      source: 'invoice',
      starts_at: '2026-01-01T00:00:00.000Z',
      ends_at: '2027-06-30T00:00:00.000Z',
      ended_at: null,
      end_reason: null,
      live: true,
      reference: 'PO-1234',
      assigned_product: { id: P_LICENSED, slug: 'licensed', name: 'Licensed' },
      assigned_at: '2026-01-01T00:00:00.000Z',
      release_at_renewal: false,
      cancel_at_term_end: false,
      open_release_request: { id: ids.openRequest, created_at: '2026-09-01T00:00:00.000Z' },
    });
    expect(parsed.licenses[1]).toMatchObject({
      live: true,
      assigned_product: null,
      open_release_request: null,
    });

    // No Stripe or admin-only fields leave the API.
    const first = (body as { licenses: Record<string, unknown>[] }).licenses[0];
    for (const key of [
      'stripe_subscription_id',
      'cancel_reason',
      'terms_version',
      'granted_by',
      'created_at',
    ]) {
      expect(first).not.toHaveProperty(key);
    }
  });

  it('marks an ended license live:false and keeps its product as history', async () => {
    const ids = await seed();
    const { body } = await call(session());
    const parsed = VendorBillingResponseSchema.parse(body);
    const ended = parsed.licenses.find((l) => l.id === ids.ended);
    expect(ended).toMatchObject({
      live: false,
      ended_at: '2026-05-01T00:00:00.000Z',
      end_reason: 'expired',
      assigned_product: { id: P_ALPHA, slug: 'alpha', name: 'alpha' },
    });
  });

  it('never shows another vendor’s licenses, even on a co-owned product', async () => {
    const ids = await seed();
    const parsed = VendorBillingResponseSchema.parse((await call(session())).body);
    expect(parsed.licenses.map((l) => l.id)).not.toContain(ids.foreign);

    const other = VendorBillingResponseSchema.parse(
      (await call(session({ userId: OTHER_OWNER, vendorId: OTHER_VENDOR }))).body,
    );
    expect(other.licenses.map((l) => l.id)).toEqual([ids.foreign]);
    expect(other.billing_account?.billing_email).toBeNull();
  });

  it('offers only owned products with no live license from any vendor, sorted case-insensitively', async () => {
    await seed();
    const parsed = VendorBillingResponseSchema.parse((await call(session())).body);
    // Not P_LICENSED (ours, live), not P_COOWNED (the co-owner's live license), not
    // P_FOREIGN (not ours). P_ALPHA is back in: its only license has ended.
    expect(parsed.assignable_products).toEqual([
      { id: P_ALPHA, slug: 'alpha', name: 'alpha' },
      { id: P_BETA, slug: 'beta', name: 'Beta' },
    ]);
  });

  it('answers billing_account: null and no licenses when the vendor has no account', async () => {
    const { status, body } = await call(session());
    expect(status).toBe(200);
    const parsed = VendorBillingResponseSchema.parse(body);
    expect(parsed.billing_account).toBeNull();
    expect(parsed.licenses).toEqual([]);
    // Still answerable: nothing is licensed, so every owned product is assignable.
    expect(parsed.assignable_products.map((p) => p.id)).toEqual([
      P_ALPHA,
      P_BETA,
      P_COOWNED,
      P_LICENSED,
    ]);
  });

  it('refuses a member seat with 403', async () => {
    await seed();
    const { status, body } = await call(session({ userId: MEMBER }));
    expect(status).toBe(403);
    expect((body as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'FORBIDDEN',
      message: 'Only a vendor account owner can see billing',
    });
  });

  it('refuses an owner of a different vendor reaching for this one', async () => {
    const { status } = await call(session({ userId: OTHER_OWNER }));
    expect(status).toBe(403);
  });
});

describe('GET /api/vendor/billing — the Stripe summary (AECI-1501)', () => {
  const SUB = 'sub_123';
  const STRIPE_ENV: Env = {
    ...TEST_ENV,
    STRIPE_SECRET_KEY: 'sk_test_x',
    STRIPE_CHECKOUT_ENABLED: 'true',
    PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
  };

  async function seedStripe(endsAt: string | null, n = 2) {
    for (let i = 0; i < n; i++) {
      const id = await seedLicense(t.db, VENDOR, { source: 'stripe', endsAt });
      await t.db.update(licenses).set({ stripeSubscriptionId: SUB }).where(eq(licenses.id, id));
    }
  }

  const fake = (retrieve: StripeClient['retrieveSubscription']) =>
    ({ retrieveSubscription: vi.fn(retrieve) }) as unknown as StripeClient;

  it('answers stripe: null and makes no Stripe call with no live Stripe license', async () => {
    await seed();
    const stripe = fake(async () => {
      throw new Error('must not be called');
    });
    const { body } = await call(session(), { env: STRIPE_ENV, stripe });
    const parsed = VendorBillingResponseSchema.parse(body);
    expect(parsed.stripe).toBeNull();
    expect(parsed.stripe_checkout_available).toBe(true);
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });

  it('reports stripe_checkout_available: false when the tier flag is off', async () => {
    const { body } = await call(session(), {
      env: { ...STRIPE_ENV, STRIPE_CHECKOUT_ENABLED: 'false' },
    });
    expect(VendorBillingResponseSchema.parse(body).stripe_checkout_available).toBe(false);
  });

  it('refines the D1 view with one Stripe read', async () => {
    await seedStripe('2027-10-28T00:00:00.000Z');
    const stripe = fake(async () => ({
      ok: true,
      data: {
        id: SUB,
        status: 'active',
        customer: 'cus_1',
        cancel_at_period_end: true,
        metadata: {},
        items: {
          data: [
            {
              id: 'si_1',
              quantity: 3,
              price: { id: 'price_a', recurring: { interval: 'year' } },
              current_period_end: 1_824_768_000,
            },
          ],
        },
      } as StripeSubscription,
    }));
    const { status, body } = await call(session(), { env: STRIPE_ENV, stripe });
    expect(status).toBe(200);
    expect(VendorBillingResponseSchema.parse(body).stripe).toEqual({
      interval: 'year',
      quantity: 3,
      current_period_end: new Date(1_824_768_000 * 1000).toISOString(),
      cancel_at_period_end: true,
      synced: true,
    });
    expect(stripe.retrieveSubscription).toHaveBeenCalledTimes(1);
    expect(stripe.retrieveSubscription).toHaveBeenCalledWith(SUB);
  });

  it('answers 200 from D1 with synced: false when Stripe is down', async () => {
    await seedStripe(null);
    const stripe = fake(async () => ({
      ok: false,
      status: 0,
      reason: 'timeout',
      message: 'timed out',
    }));
    const { status, body } = await call(session(), { env: STRIPE_ENV, stripe });
    expect(status).toBe(200);
    const parsed = VendorBillingResponseSchema.parse(body);
    expect(parsed.stripe).toEqual({
      interval: 'month',
      quantity: 2,
      current_period_end: null,
      cancel_at_period_end: false,
      synced: false,
    });
    expect(parsed.licenses).toHaveLength(2);
  });

  it('answers the D1 view with no Stripe key', async () => {
    await seedStripe('2027-10-28T00:00:00.000Z', 1);
    const { body } = await call(session(), { env: TEST_ENV, stripe: null });
    const parsed = VendorBillingResponseSchema.parse(body);
    expect(parsed.stripe).toEqual({
      interval: 'year',
      quantity: 1,
      current_period_end: '2027-10-28T00:00:00.000Z',
      cancel_at_period_end: false,
      synced: false,
    });
    expect(parsed.stripe_checkout_available).toBe(false);
  });
});
