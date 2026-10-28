/**
 * The owner's Stripe routes (AECI-1501, E9.3) over the in-memory D1, with a fake Stripe
 * client and the session stubbed the way `vendor-billing-email.spec.ts` stubs it. The
 * limiter registration is in `vendor-billing-stripe.registration.spec.ts`. No request
 * leaves the process.
 */

import { ApiErrorCode, LEGAL_AGREEMENT_CURRENT_VERSIONS } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, billingAccounts, licenses, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type {
  StripeClient,
  StripeCreateCheckoutSessionParams,
  StripeResult,
  StripeSubscription,
} from '../lib/stripe';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { seedBillingAccount, seedLicense } from '../test/licenses';
import {
  createAddStripeLicensesHandler,
  createStripeCheckoutHandler,
  createStripePortalHandler,
  managedPlanAgreementMessage,
} from './vendor-billing-stripe';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = uuid(1);
const OWNER = uuid(100);
const MEMBER = uuid(101);
const SITE = 'https://www.aecintegrations.com';
const SUB = 'sub_123';

const ENV: Env = {
  ...TEST_ENV,
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_CHECKOUT_ENABLED: 'true',
  STRIPE_PORTAL_CONFIG_ANNUAL: 'bpc_annual',
  STRIPE_PORTAL_CONFIG_MONTHLY: 'bpc_monthly',
  PUBLIC_SITE_URL: `${SITE}/`,
};

const session = (over: Partial<AuthzVariables['auth']> = {}): AuthzVariables['auth'] => ({
  userId: OWNER,
  email: 'owner@acme.com',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'unclaimed',
  entitlement: null,
  ...over,
});

const ok = <T>(data: T): StripeResult<T> => ({ ok: true, data });
const down = { ok: false, status: 0, reason: 'timeout', message: 'timed out' } as const;

function subscription(over: Partial<StripeSubscription> = {}, interval = 'year' as const) {
  return {
    id: SUB,
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    metadata: {},
    items: {
      data: [
        {
          id: 'si_1',
          quantity: 3,
          price: { id: 'price_a', recurring: { interval } },
          current_period_end: 1_800_000_000,
        },
      ],
    },
    ...over,
  } as StripeSubscription;
}

function fakeStripe(over: Partial<Record<keyof StripeClient, unknown>> = {}) {
  const client = {
    getPriceByLookupKey: vi.fn(async (key: string) =>
      ok({
        id: key === 'managed_annual' ? 'price_annual' : 'price_monthly',
        recurring: { interval: key === 'managed_annual' ? 'year' : 'month' },
      }),
    ),
    createCustomer: vi.fn(async () => ok({ id: 'cus_new' })),
    createCheckoutSession: vi.fn(async (_params: StripeCreateCheckoutSessionParams, _key: string) =>
      ok({
        id: 'cs_1',
        url: 'https://checkout.stripe.com/c/pay/cs_1',
        customer: null,
        metadata: {},
      }),
    ),
    createPortalSession: vi.fn(async (_params: unknown, _key: string) =>
      ok({ id: 'bps_1', url: 'https://billing.stripe.com/p/session/1' }),
    ),
    retrieveSubscription: vi.fn(async () => ok(subscription())),
    updateSubscription: vi.fn(async () => ok(subscription())),
    listSubscriptions: vi.fn(),
  };
  return { ...client, ...over } as typeof client;
}

let t: TestDb;
let stripe: ReturnType<typeof fakeStripe>;
beforeEach(async () => {
  t = await makeTestDb();
  stripe = fakeStripe();
  await t.db.insert(vendors).values([{ id: VENDOR, slug: 'acme', companyName: 'Acme' }]);
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false },
  ]);
});
afterEach(() => t.dispose());

type Route = 'checkout' | 'licenses/add' | 'portal';

async function call(
  route: Route,
  body: unknown = {},
  { auth = session(), env = ENV }: { auth?: AuthzVariables['auth']; env?: Env } = {},
) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  const stripeFor = () => stripe as unknown as StripeClient;
  app.post('/api/vendor/billing/checkout', createStripeCheckoutHandler(t.factory, stripeFor));
  app.post(
    '/api/vendor/billing/licenses/add',
    createAddStripeLicensesHandler(t.factory, stripeFor),
  );
  app.post('/api/vendor/billing/portal', createStripePortalHandler(t.factory, stripeFor));
  const res = await app.fetch(
    new Request(`http://x/api/vendor/billing/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    fakeExecutionContext(),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: res.status, body: (await res.json()) as any };
}

/** A live Stripe license: annual rows carry the period end, monthly rows `NULL`. */
async function seedStripeLicense(interval: 'year' | 'month', subscriptionId = SUB) {
  const id = await seedLicense(t.db, VENDOR, {
    source: 'stripe',
    endsAt: interval === 'year' ? '2027-10-28T00:00:00.000Z' : null,
  });
  await t.db
    .update(licenses)
    .set({ stripeSubscriptionId: subscriptionId })
    .where(eq(licenses.id, id));
  return id;
}

async function linkCustomer(account: string, id = 'cus_1') {
  await t.db
    .update(billingAccounts)
    .set({ stripeCustomerId: id })
    .where(eq(billingAccounts.id, account));
}

const storedCustomer = async (account: string) =>
  (await t.db.select().from(billingAccounts).where(eq(billingAccounts.id, account)))[0]!
    .stripeCustomerId;

describe('POST /api/vendor/billing/checkout', () => {
  it('creates the customer once, records it with an audit row, and opens Checkout', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);

    const first = await call('checkout', { quantity: 2, interval: 'year' });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });

    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
    expect(stripe.createCustomer).toHaveBeenCalledWith(
      { name: `Account ${VENDOR}`, metadata: { billing_account_id: account, vendor_id: VENDOR } },
      `aeci-customer-${account}`,
    );
    expect(await storedCustomer(account)).toBe('cus_new');
    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'billing_account.stripe_customer_linked',
      entityType: 'billing_account',
      entityId: account,
      actorId: OWNER,
      vendorId: VENDOR,
    });
    expect(audits[0]!.afterState).toEqual({ stripe_customer_id: 'cus_new' });

    // The second checkout reuses the stored customer.
    const second = await call('checkout', { quantity: 1, interval: 'year' });
    expect(second.status).toBe(200);
    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
    expect(stripe.createCheckoutSession.mock.calls[1]![0]).toMatchObject({ customer: 'cus_new' });
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it('sends the Checkout params: price, quantity, tax, consent, metadata, codes, URLs', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);
    await linkCustomer(account);

    const { status } = await call('checkout', { quantity: 3, interval: 'month' });
    expect(status).toBe(200);
    expect(stripe.getPriceByLookupKey).toHaveBeenCalledWith('managed_monthly');
    expect(stripe.createCustomer).not.toHaveBeenCalled();

    const [params, key] = stripe.createCheckoutSession.mock.calls[0]! as unknown as [
      StripeCreateCheckoutSessionParams,
      string,
    ];
    const metadata = {
      billing_account_id: account,
      vendor_id: VENDOR,
      profile_id: OWNER,
      terms_version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
    };
    expect(params).toEqual({
      mode: 'subscription',
      customer: 'cus_1',
      line_items: [{ price: 'price_monthly', quantity: 3 }],
      success_url: `${SITE}/vendor/acme/billing?checkout=success`,
      cancel_url: `${SITE}/vendor/acme/billing?checkout=cancelled`,
      client_reference_id: account,
      metadata,
      subscription_data: { metadata },
      consent_collection: { terms_of_service: 'required' },
      custom_text: {
        terms_of_service_acceptance: { message: managedPlanAgreementMessage(SITE) },
      },
      automatic_tax: { enabled: true },
      tax_id_collection: { enabled: true },
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      allow_promotion_codes: true,
    });
    expect(managedPlanAgreementMessage(SITE)).toContain(`(${SITE}/legal/managed-plan-agreement)`);
    expect(key).toMatch(new RegExp(`^aeci-checkout-${account}-${OWNER}-month-3-\\d+$`));
  });

  it('answers 409 STRIPE_SUBSCRIPTION_EXISTS for a live subscription in the same interval', async () => {
    await seedStripeLicense('year');
    const { status, body } = await call('checkout', { quantity: 1, interval: 'year' });
    expect(status).toBe(409);
    expect(body.error).toMatchObject({
      code: ApiErrorCode.STRIPE_SUBSCRIPTION_EXISTS,
      details: { interval: 'year' },
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });

  it('answers 409 LICENSE_INTERVAL_MISMATCH for a live subscription in the other interval', async () => {
    await seedStripeLicense('month');
    const { status, body } = await call('checkout', { quantity: 1, interval: 'year' });
    expect(status).toBe(409);
    expect(body.error).toMatchObject({
      code: ApiErrorCode.LICENSE_INTERVAL_MISMATCH,
      details: { interval: 'month' },
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('ignores ended Stripe licenses and non-Stripe licenses', async () => {
    const ended = await seedStripeLicense('year');
    await t.db
      .update(licenses)
      .set({ endedAt: '2026-01-01T00:00:00.000Z', endReason: 'lapsed' })
      .where(eq(licenses.id, ended));
    await seedLicense(t.db, VENDOR, { source: 'invoice', endsAt: '2027-01-01T00:00:00.000Z' });
    const { status } = await call('checkout', { quantity: 1, interval: 'month' });
    expect(status).toBe(200);
  });

  it('refuses a member seat with 403 before touching Stripe', async () => {
    await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await call(
      'checkout',
      { quantity: 1, interval: 'year' },
      { auth: session({ userId: MEMBER }) },
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe('FORBIDDEN');
    expect(stripe.getPriceByLookupKey).not.toHaveBeenCalled();
  });

  it.each([
    ['the flag is off', { STRIPE_CHECKOUT_ENABLED: 'false' }],
    ['the key is unset', { STRIPE_SECRET_KEY: undefined }],
    ['the site URL is unset', { PUBLIC_SITE_URL: undefined }],
  ])('answers 503 STRIPE_UNAVAILABLE when %s', async (_label, over) => {
    await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await call(
      'checkout',
      { quantity: 1, interval: 'year' },
      { env: { ...ENV, ...over } },
    );
    expect(status).toBe(503);
    expect(body.error.code).toBe(ApiErrorCode.STRIPE_UNAVAILABLE);
    expect(stripe.getPriceByLookupKey).not.toHaveBeenCalled();
  });

  it('rejects a bad body with 400', async () => {
    await seedBillingAccount(t.db, VENDOR);
    for (const body of [
      { quantity: 0, interval: 'year' },
      { quantity: 1.5, interval: 'year' },
      { quantity: 1, interval: 'week' },
      { quantity: 1, interval: 'year', extra: true },
    ]) {
      expect((await call('checkout', body)).status).toBe(400);
    }
  });

  it('answers 503 DEPENDENCY_FAILURE and records nothing when the customer create fails', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);
    stripe = fakeStripe({ createCustomer: vi.fn(async () => down) });
    const { status, body } = await call('checkout', { quantity: 1, interval: 'year' });
    expect(status).toBe(503);
    expect(body.error.code).toBe(ApiErrorCode.DEPENDENCY_FAILURE);
    expect(await storedCustomer(account)).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('keeps the customer id another writer stored first, and writes no second audit row', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);
    // The webhook (or a racing checkout) links the account between our read and our batch.
    stripe = fakeStripe({
      createCustomer: vi.fn(async () => {
        await linkCustomer(account, 'cus_other');
        return ok({ id: 'cus_new' });
      }),
    });
    const { status } = await call('checkout', { quantity: 1, interval: 'year' });
    expect(status).toBe(200);
    expect(await storedCustomer(account)).toBe('cus_other');
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(stripe.createCheckoutSession.mock.calls[0]![0]).toMatchObject({
      customer: 'cus_other',
    });
  });

  it('answers 404 when the vendor has no billing account', async () => {
    const { status } = await call('checkout', { quantity: 1, interval: 'year' });
    expect(status).toBe(404);
  });
});

describe('POST /api/vendor/billing/licenses/add', () => {
  it('raises Stripe’s quantity by n with always_invoice, and writes no license', async () => {
    await seedStripeLicense('year');
    const before = await t.db.select().from(licenses);

    const { status, body } = await call('licenses/add', { quantity: 2 });
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, pending: true });

    expect(stripe.retrieveSubscription).toHaveBeenCalledWith(SUB);
    // Stripe says 3 (D1 has 1 live row): the base is Stripe's quantity.
    expect(stripe.updateSubscription).toHaveBeenCalledWith(
      SUB,
      { item: { id: 'si_1', quantity: 5 }, proration_behavior: 'always_invoice' },
      `aeci-add-${SUB}-3-2`,
    );
    expect(await t.db.select().from(licenses)).toEqual(before);
  });

  it('answers 409 STRIPE_SUBSCRIPTION_REQUIRED with no live Stripe subscription', async () => {
    await seedLicense(t.db, VENDOR, { source: 'invoice' });
    const { status, body } = await call('licenses/add', { quantity: 1 });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.STRIPE_SUBSCRIPTION_REQUIRED);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('answers 409 when Stripe says the subscription is no longer active', async () => {
    await seedStripeLicense('year');
    stripe = fakeStripe({
      retrieveSubscription: vi.fn(async () => ok(subscription({ status: 'canceled' }))),
    });
    const { status, body } = await call('licenses/add', { quantity: 1 });
    expect(status).toBe(409);
    expect(body.error).toMatchObject({
      code: ApiErrorCode.STRIPE_SUBSCRIPTION_REQUIRED,
      details: { status: 'canceled' },
    });
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('refuses a member seat with 403', async () => {
    await seedStripeLicense('year');
    const { status } = await call(
      'licenses/add',
      { quantity: 1 },
      { auth: session({ userId: MEMBER }) },
    );
    expect(status).toBe(403);
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
  });

  it('answers 503 STRIPE_UNAVAILABLE when the tier is off', async () => {
    await seedStripeLicense('year');
    const { status, body } = await call(
      'licenses/add',
      { quantity: 1 },
      { env: { ...ENV, STRIPE_CHECKOUT_ENABLED: 'false' } },
    );
    expect(status).toBe(503);
    expect(body.error.code).toBe(ApiErrorCode.STRIPE_UNAVAILABLE);
  });
});

describe('POST /api/vendor/billing/portal', () => {
  it.each([
    ['year', 'bpc_annual'],
    ['month', 'bpc_monthly'],
  ] as const)('picks the %s config and returns to the Billing tab', async (interval, config) => {
    const account = await seedBillingAccount(t.db, VENDOR);
    await linkCustomer(account);
    await seedStripeLicense(interval);
    stripe = fakeStripe({
      retrieveSubscription: vi.fn(async () => ok(subscription({}, interval as 'year'))),
    });

    const { status, body } = await call('portal');
    expect(status).toBe(200);
    expect(body).toEqual({ url: 'https://billing.stripe.com/p/session/1' });
    const [params, key] = stripe.createPortalSession.mock.calls[0]! as unknown as [unknown, string];
    expect(params).toEqual({
      customer: 'cus_1',
      configuration: config,
      return_url: `${SITE}/vendor/acme/billing`,
    });
    expect(key).toMatch(new RegExp(`^aeci-portal-${account}-\\d+$`));
  });

  // AECI-1501: a lapsed card customer still reaches past invoices and receipts.
  it('opens the annual config (cancel off) for a customer with no live subscription', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);
    await linkCustomer(account);
    const { status, body } = await call('portal');
    expect(status).toBe(200);
    expect(body).toEqual({ url: 'https://billing.stripe.com/p/session/1' });
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    const [params] = stripe.createPortalSession.mock.calls[0]! as unknown as [unknown];
    expect(params).toEqual({
      customer: 'cus_1',
      configuration: 'bpc_annual',
      return_url: `${SITE}/vendor/acme/billing`,
    });
  });

  it('answers 409 STRIPE_SUBSCRIPTION_REQUIRED with no Stripe customer at all', async () => {
    await seedBillingAccount(t.db, VENDOR);
    const { status, body } = await call('portal');
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.STRIPE_SUBSCRIPTION_REQUIRED);
    expect(stripe.createPortalSession).not.toHaveBeenCalled();
  });

  it('answers 503 STRIPE_UNAVAILABLE when the interval’s config id is unset', async () => {
    const account = await seedBillingAccount(t.db, VENDOR);
    await linkCustomer(account);
    await seedStripeLicense('year');
    const { status, body } = await call(
      'portal',
      {},
      {
        env: { ...ENV, STRIPE_PORTAL_CONFIG_ANNUAL: undefined },
      },
    );
    expect(status).toBe(503);
    expect(body.error.code).toBe(ApiErrorCode.STRIPE_UNAVAILABLE);
    expect(stripe.createPortalSession).not.toHaveBeenCalled();
  });

  it('refuses a member seat with 403', async () => {
    const { status } = await call('portal', {}, { auth: session({ userId: MEMBER }) });
    expect(status).toBe(403);
  });
});
