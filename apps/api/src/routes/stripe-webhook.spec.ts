/**
 * `POST /api/webhooks/stripe` (AECI-1500, E9.2) against the in-memory D1 harness, end to
 * end: a real `Stripe-Signature` over the raw body, the real migration-built tables, and a
 * fake Stripe client that serves the subscription each event re-reads. PostHog and the
 * senders are the mocks, so nothing reaches Stripe, Resend or GoTrue.
 */

import { createHmac } from 'node:crypto';

import { LEGAL_AGREEMENT_CURRENT_VERSIONS, LEGAL_AGREEMENT_KNOWN_VERSIONS } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  billingAccounts,
  licenses,
  productVendors,
  products,
  profiles,
  stripeEvents,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import type { StripeClient, StripeResult, StripeSubscription } from '../lib/stripe';
import { submitCount } from '../posthog';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext } from '../test/helpers';
import {
  createStripeWebhookHandler,
  resetStripeSecretWarning,
  STRIPE_SIGNATURE_FAILURE_METRIC,
  STRIPE_WEBHOOK_MAX_BYTES,
  type StripeWebhookHandlerDeps,
} from './webhooks';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const SECRET = 'whsec_stripe_webhook_test';
const ENV: Env = { ENV: 'production', STRIPE_WEBHOOK_SECRET: SECRET };
const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const SEAT_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_PROFILE = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = 'ba-1';
const SUB = 'sub_1';
const OLD_TS = '2020-01-01T00:00:00.000Z';
const PERIOD_END = Date.UTC(2027, 9, 28, 12) / 1000;
const PERIOD_END_ISO = '2027-10-28T12:00:00.000Z';

let t: TestDb;
let stripeSub: StripeSubscription;
let retrieveResult: (() => StripeResult<StripeSubscription>) | null;
let retrieves: number;
let sent: { template: string; to: string; dedupeKey?: string }[];

beforeEach(async () => {
  t = await makeTestDb();
  vi.mocked(submitCount).mockClear();
  resetStripeSecretWarning();
  retrieveResult = null;
  retrieves = 0;
  sent = [];
  stripeSub = subscription();
  await t.db
    .insert(vendors)
    .values({ id: VENDOR_ID, slug: 'acme', companyName: 'Acme', updatedAt: OLD_TS });
  await t.db.insert(billingAccounts).values({ id: ACCOUNT, vendorId: VENDOR_ID, name: 'Acme' });
  await t.db.insert(profiles).values({ id: SEAT_ID, role: 'vendor_admin', vendorId: VENDOR_ID });
  await t.db
    .insert(products)
    .values({ id: 'p-1', slug: 'acme-one', name: 'Acme One', promotionStatus: 'promoted' });
  await t.db.insert(productVendors).values({ productId: 'p-1', vendorId: VENDOR_ID });
});
afterEach(() => t.dispose());

function subscription(over: Partial<StripeSubscription> & { quantity?: number } = {}) {
  const { quantity = 2, ...rest } = over;
  return {
    id: SUB,
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    metadata: {
      billing_account_id: ACCOUNT,
      vendor_id: VENDOR_ID,
      profile_id: OWNER_PROFILE,
      terms_version: '1.0',
    },
    items: {
      data: [
        {
          id: 'si_1',
          quantity,
          price: { id: 'price_1', recurring: { interval: 'year' } },
          current_period_end: PERIOD_END,
        },
      ],
    },
    ...rest,
  } as StripeSubscription;
}

const fakeStripe = {
  retrieveSubscription: async () => {
    retrieves++;
    return retrieveResult ? retrieveResult() : { ok: true, data: stripeSub };
  },
} as unknown as StripeClient;

const recordingSender =
  (template: string) => async (_c: unknown, o: { to: string; dedupeKey?: string }) => {
    sent.push({ template, to: o.to, dedupeKey: o.dedupeKey });
    return 'sent' as const;
  };

const deps: StripeWebhookHandlerDeps = {
  stripeFor: () => fakeStripe,
  fetchSeatEmails: async (_env, ids) => new Map(ids.map((id) => [id, 'seat@acme.example'])),
  sendGranted: recordingSender('licenses-granted') as never,
  sendEnded: recordingSender('managed-ended') as never,
  sendPaymentFailed: recordingSender('payment-failed') as never,
};

const app = () =>
  buildAppWithHandler({
    method: 'post',
    path: '/api/webhooks/stripe',
    handler: createStripeWebhookHandler(t.factory, deps),
  });

function signature(raw: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
}

async function post(body: unknown, opts: { env?: Env; header?: string | null; raw?: string } = {}) {
  const raw = opts.raw ?? JSON.stringify(body);
  const ctx = fakeExecutionContext();
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const header = opts.header === undefined ? signature(raw) : opts.header;
  if (header !== null) headers['stripe-signature'] = header;
  const res = await app().request(
    '/api/webhooks/stripe',
    { method: 'POST', headers, body: raw },
    opts.env ?? ENV,
    ctx,
  );
  // Run the post-commit work the handler scheduled.
  await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map(([p]) => p));
  return res;
}

let nextEvent = 0;
function event(type: string, object: Record<string, unknown>, id = `evt_${++nextEvent}`) {
  return { id, type, created: Math.floor(Date.now() / 1000), data: { object } };
}

const checkoutEvent = (id?: string) =>
  event(
    'checkout.session.completed',
    {
      id: 'cs_test_1',
      mode: 'subscription',
      customer: 'cus_1',
      subscription: SUB,
      customer_details: { email: 'Buyer@Acme.example' },
      metadata: stripeSub.metadata,
    },
    id,
  );

const subEvent = (type: string, id?: string) =>
  event(type, { id: SUB, object: 'subscription' }, id);

const liveLicenses = async () =>
  (await t.db.select().from(licenses)).filter((l) => l.endedAt === null);
const ledger = () => t.db.select().from(stripeEvents);

function signatureFailures(): string[] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === STRIPE_SIGNATURE_FAILURE_METRIC)
    .flatMap((call) => (call[5] as string[]) ?? []);
}

describe('the signature gate', () => {
  it('401s fail-closed when the secret is unset', async () => {
    const res = await post(checkoutEvent(), { env: { ENV: 'production' } });
    expect(res.status).toBe(401);
    expect(signatureFailures()).toEqual(['reason:missing_secret']);
    expect(await ledger()).toHaveLength(0);
  });

  it('401s a bad signature before parsing the body', async () => {
    const res = await post(checkoutEvent(), { header: signature('{}') });
    expect(res.status).toBe(401);
    expect(signatureFailures()).toEqual(['reason:mismatch']);
    expect(retrieves).toBe(0);
  });

  it('401s a stale timestamp', async () => {
    const raw = JSON.stringify(checkoutEvent());
    const res = await post(null, {
      raw,
      header: signature(raw, Math.floor(Date.now() / 1000) - 301),
    });
    expect(res.status).toBe(401);
    expect(signatureFailures()).toEqual(['reason:stale']);
  });

  it('401s a missing header', async () => {
    expect((await post(checkoutEvent(), { header: null })).status).toBe(401);
    expect(signatureFailures()).toEqual(['reason:missing_header']);
  });

  it('413s a body over the cap', async () => {
    const raw = 'x'.repeat(STRIPE_WEBHOOK_MAX_BYTES + 1);
    expect((await post(null, { raw })).status).toBe(413);
  });

  it('400s a signed body that is not a Stripe event', async () => {
    expect((await post(null, { raw: 'not json' })).status).toBe(400);
    expect((await post({ hello: 'world' })).status).toBe(400);
  });
});

describe('events', () => {
  it('ignores an unknown type with a 200 and no ledger row', async () => {
    const res = await post(event('customer.created', { id: 'cus_1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'ignored' });
    expect(await ledger()).toHaveLength(0);
  });

  it('checkout.session.completed: acceptance, customer link, licenses and the email', async () => {
    const res = await post(checkoutEvent('evt_checkout'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'synced' });

    const [acceptance] = await t.db.select().from(agreementAcceptances);
    expect(acceptance).toMatchObject({
      document: 'managed_plan',
      version: '1.0',
      source: 'checkout',
      email: 'Buyer@Acme.example',
      profileId: OWNER_PROFILE,
      vendorId: VENDOR_ID,
      billingAccountId: ACCOUNT,
      stripeCheckoutSessionId: 'cs_test_1',
      ip: null,
    });
    const [account] = await t.db.select().from(billingAccounts);
    expect(account).toMatchObject({
      stripeCustomerId: 'cus_1',
      billingEmail: 'buyer@acme.example',
    });

    const live = await liveLicenses();
    expect(live).toHaveLength(2);
    expect(live[0]).toMatchObject({ source: 'stripe', endsAt: PERIOD_END_ISO });
    expect(await ledger()).toEqual([
      expect.objectContaining({ id: 'evt_checkout', outcome: 'synced', subscriptionId: SUB }),
    ]);

    const actions = (await t.db.select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual([
      'agreement.accepted',
      'billing_account.email_changed',
      'billing_account.stripe_customer_linked',
      'license.granted',
      'license.granted',
    ]);
    expect(sent.filter((s) => s.template === 'licenses-granted').map((s) => s.to)).toEqual([
      'seat@acme.example',
      'buyer@acme.example',
    ]);
  });

  it('keeps an existing customer id and billing email', async () => {
    await t.db
      .update(billingAccounts)
      .set({ stripeCustomerId: 'cus_1', billingEmail: 'ap@acme.example' })
      .where(eq(billingAccounts.id, ACCOUNT));
    await post(checkoutEvent());
    const [account] = await t.db.select().from(billingAccounts);
    expect(account).toMatchObject({ stripeCustomerId: 'cus_1', billingEmail: 'ap@acme.example' });
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).not.toContain('billing_account.email_changed');
    expect(actions).not.toContain('billing_account.stripe_customer_linked');
  });

  it('records the stale terms version the Checkout page showed (ruling R1)', async () => {
    // The fixture's Checkout page showed '1.0', which is a known but no longer
    // current version (AECI-1428 bumped the agreement to 1.1). Bump "current" one
    // step further so the test holds whatever the map says today.
    const known = LEGAL_AGREEMENT_KNOWN_VERSIONS.managed_plan as unknown as string[];
    const current = LEGAL_AGREEMENT_CURRENT_VERSIONS as unknown as Record<string, string>;
    const wasCurrent = current.managed_plan;
    known.push('9.9');
    current.managed_plan = '9.9';
    try {
      const res = await post(checkoutEvent());
      expect(res.status).toBe(200);
      const [acceptance] = await t.db.select().from(agreementAcceptances);
      expect(acceptance!.version).toBe('1.0');
      expect((await liveLicenses()).every((l) => l.termsVersion === '1.0')).toBe(true);
    } finally {
      known.pop();
      current.managed_plan = wasCurrent;
    }
  });

  it('a replay answers 200 replay and writes nothing twice, with no Stripe call', async () => {
    await post(checkoutEvent('evt_same'));
    const before = { retrieves, sent: sent.length };
    const res = await post(checkoutEvent('evt_same'));
    expect(await res.json()).toMatchObject({ outcome: 'replay' });
    expect(retrieves).toBe(before.retrieves);
    expect(sent).toHaveLength(before.sent);
    expect(await liveLicenses()).toHaveLength(2);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
  });

  it('a replay that slips past the ledger read trips the primary key and answers replay', async () => {
    await post(checkoutEvent('evt_race'));
    // Simulate the race: the pre-read misses, the batch's INSERT is what catches it.
    const spy = vi.spyOn(t.db, 'select');
    spy.mockImplementationOnce(
      () =>
        ({
          from: () => ({ where: () => ({ limit: async () => [] }) }),
        }) as never,
    );
    const res = await post(checkoutEvent('evt_race'));
    spy.mockRestore();
    expect(await res.json()).toMatchObject({ outcome: 'replay' });
    expect(await liveLicenses()).toHaveLength(2);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(1);
  });

  // AECI-1500: the reconcile can record the Checkout acceptance before a late
  // `checkout.session.completed`. The event must still commit, not 500 for three days.
  const backfilledAcceptance = {
    id: '55555555-5555-4555-8555-555555555555',
    document: 'managed_plan',
    version: '1.0',
    source: 'checkout',
    email: 'buyer@acme.example',
    vendorId: VENDOR_ID,
    billingAccountId: ACCOUNT,
    stripeCheckoutSessionId: 'cs_test_1',
    acceptedAt: '2026-10-28T00:00:00.000Z',
  };

  it('acceptance already backfilled by the reconcile, then the webhook arrives: it syncs and adds no second row', async () => {
    await t.db.insert(agreementAcceptances).values(backfilledAcceptance);

    const res = await post(checkoutEvent('evt_late'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'synced' });

    expect(await t.db.select().from(agreementAcceptances)).toEqual([
      expect.objectContaining({ id: backfilledAcceptance.id }),
    ]);
    expect(await liveLicenses()).toHaveLength(2);
    expect(await ledger()).toEqual([
      expect.objectContaining({ id: 'evt_late', outcome: 'synced' }),
    ]);
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).not.toContain('agreement.accepted');
  });

  it('a backfill that lands between the read and the batch trips the session key, and the sync re-plans', async () => {
    const batch = t.db.batch.bind(t.db);
    let raced = false;
    const spy = vi.spyOn(t.db, 'batch').mockImplementation((async (stmts: unknown[]) => {
      // The sync's batch (ledger, acceptance, link, email, licenses): the reconcile
      // records the same session first.
      if (!raced && stmts.length > 3) {
        raced = true;
        await t.db.insert(agreementAcceptances).values(backfilledAcceptance);
      }
      return batch(stmts as never);
    }) as never);
    const res = await post(checkoutEvent('evt_mid'));
    spy.mockRestore();

    expect(raced).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'synced' });
    expect(await t.db.select().from(agreementAcceptances)).toEqual([
      expect.objectContaining({ id: backfilledAcceptance.id }),
    ]);
    expect(await liveLicenses()).toHaveLength(2);
    expect(await ledger()).toEqual([expect.objectContaining({ id: 'evt_mid', outcome: 'synced' })]);
  });

  it('invoice.paid on a renewal moves the term and binds the current version', async () => {
    await post(checkoutEvent());
    const known = LEGAL_AGREEMENT_KNOWN_VERSIONS.managed_plan as unknown as string[];
    const current = LEGAL_AGREEMENT_CURRENT_VERSIONS as unknown as Record<string, string>;
    known.push('1.1');
    current.managed_plan = '1.1';
    try {
      const next = Date.UTC(2028, 9, 28, 12) / 1000;
      stripeSub = subscription();
      stripeSub.items.data[0]!.current_period_end = next;
      const res = await post(
        event('invoice.paid', {
          id: 'in_2',
          billing_reason: 'subscription_cycle',
          parent: { subscription_details: { subscription: SUB } },
        }),
      );
      expect(await res.json()).toMatchObject({ outcome: 'synced' });
      for (const l of await liveLicenses()) {
        expect(l).toMatchObject({ endsAt: '2028-10-28T12:00:00.000Z', termsVersion: '1.1' });
      }
    } finally {
      known.pop();
      current.managed_plan = '1.0';
    }
  });

  it('invoice.paid after an add grants the new quantity', async () => {
    await post(checkoutEvent());
    stripeSub = subscription({ quantity: 3 });
    await post(
      event('invoice.paid', {
        id: 'in_3',
        billing_reason: 'subscription_update',
        subscription: SUB,
      }),
    );
    expect(await liveLicenses()).toHaveLength(3);
  });

  it('invoice.payment_failed emails the billing email and every seat, and changes no license', async () => {
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: 'ap@acme.example' })
      .where(eq(billingAccounts.id, ACCOUNT));
    await post(checkoutEvent());
    const before = await t.db.select().from(licenses);
    sent = [];
    const res = await post(
      event('invoice.payment_failed', {
        id: 'in_failed',
        customer: 'cus_1',
        parent: { subscription_details: { subscription: SUB, metadata: stripeSub.metadata } },
      }),
    );
    expect(await res.json()).toMatchObject({ outcome: 'notified' });
    expect(sent.map((s) => [s.template, s.to])).toEqual([
      ['payment-failed', 'seat@acme.example'],
      ['payment-failed', 'ap@acme.example'],
    ]);
    expect(sent[0]!.dedupeKey).toMatch(/^payment-failed:in_failed:/);
    expect(await t.db.select().from(licenses)).toEqual(before);
  });

  it('customer.subscription.updated maps the cancel flag', async () => {
    await post(checkoutEvent());
    stripeSub = subscription({ cancel_at_period_end: true });
    await post(subEvent('customer.subscription.updated'));
    for (const l of await liveLicenses()) {
      expect(l).toMatchObject({ cancelAtTermEnd: true, cancelReason: 'vendor-cancelled' });
    }
  });

  it('customer.subscription.deleted ends every license', async () => {
    await post(checkoutEvent());
    stripeSub = subscription({ status: 'canceled' });
    const res = await post(subEvent('customer.subscription.deleted'));
    expect(await res.json()).toMatchObject({ outcome: 'synced' });
    expect(await liveLicenses()).toHaveLength(0);
    const ended = await t.db.select().from(licenses);
    expect(ended.every((l) => l.endReason === 'lapsed')).toBe(true);
    const [vendor] = await t.db.select().from(vendors);
    expect(vendor!.verified).toBe(false);
  });

  it('out of order: deleted before completed grants nothing and still records the acceptance', async () => {
    stripeSub = subscription({ status: 'canceled' });
    const deleted = await post(subEvent('customer.subscription.deleted'));
    expect(await deleted.json()).toMatchObject({ outcome: 'no_change' });
    const completed = await post(checkoutEvent());
    expect(completed.status).toBe(200);
    expect(await t.db.select().from(licenses)).toHaveLength(0);
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(1);
    expect(sent.filter((s) => s.template === 'licenses-granted')).toHaveLength(0);
  });

  it('out of order: invoice.paid before completed grants once', async () => {
    await post(
      event('invoice.paid', {
        id: 'in_1',
        billing_reason: 'subscription_create',
        subscription: SUB,
      }),
    );
    await post(checkoutEvent());
    expect(await liveLicenses()).toHaveLength(2);
    // One grant, so one email per address. The billing email was still empty when
    // invoice.paid granted, so only the seat got it.
    expect(sent.filter((s) => s.template === 'licenses-granted').map((s) => s.to)).toEqual([
      'seat@acme.example',
    ]);
  });

  it('answers 503 on a transient Stripe failure and writes no ledger row, so the retry applies', async () => {
    retrieveResult = () => ({ ok: false, status: 0, reason: 'timeout', message: 'timed out' });
    const res = await post(checkoutEvent('evt_retry'));
    expect(res.status).toBe(503);
    expect(await ledger()).toHaveLength(0);
    retrieveResult = null;
    const retry = await post(checkoutEvent('evt_retry'));
    expect(await retry.json()).toMatchObject({ outcome: 'synced' });
  });

  it('answers 200 skipped with a ledger row when the re-read 404s, so Stripe stops redelivering', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    retrieveResult = () => ({
      ok: false,
      status: 404,
      reason: 'http_error',
      message: 'No such subscription',
      code: 'resource_missing',
    });
    const res = await post(subEvent('customer.subscription.deleted', 'evt_gone'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'skipped' });
    expect(await ledger()).toEqual([
      expect.objectContaining({ id: 'evt_gone', outcome: 'skipped', subscriptionId: SUB }),
    ]);
    expect(warn).toHaveBeenCalledWith('aeci.stripe.webhook_permanent', {
      eventId: 'evt_gone',
      subscriptionId: SUB,
      status: 404,
      code: 'resource_missing',
    });
    warn.mockRestore();
  });

  it.each([500, 429])('answers 503 on a %i re-read and writes no ledger row', async (status) => {
    retrieveResult = () => ({ ok: false, status, reason: 'http_error', message: 'try again' });
    const res = await post(subEvent('customer.subscription.updated', `evt_${status}`));
    expect(res.status).toBe(503);
    expect(await ledger()).toHaveLength(0);
  });

  it('answers 200 unlinked for a subscription no account matches', async () => {
    stripeSub = subscription({ metadata: {}, customer: 'cus_other' });
    const res = await post(subEvent('customer.subscription.updated', 'evt_unlinked'));
    expect(await res.json()).toMatchObject({ outcome: 'unlinked' });
    expect(await ledger()).toEqual([expect.objectContaining({ outcome: 'unlinked' })]);
  });
});
