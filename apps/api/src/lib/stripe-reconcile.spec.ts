/**
 * The daily Stripe reconcile (AECI-1503, E9.5) against the in-memory D1 harness: real
 * migration-built tables, the real sync, and a fake Stripe client. Nothing reaches
 * Stripe, Resend or GoTrue: the senders record, and PostHog is mocked.
 */

import { LEGAL_AGREEMENT_CURRENT_VERSIONS } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  billingAccounts,
  licenses,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import type { EmailContext } from './email';
import {
  createStripeClient,
  type StripeCheckoutSession,
  type StripeClient,
  type StripeResult,
  type StripeSubscription,
  type StripeUpdateSubscriptionParams,
} from './stripe';
import {
  runStripeReconcile,
  StripeReconcileError,
  stripeReconcileAlertKey,
  type StripeReconcileDeps,
} from './stripe-reconcile';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const SEAT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = 'ba-1';
const SUB = 'sub_1';
const NOW = new Date('2026-10-29T01:15:00.000Z');
const PERIOD_END = Date.UTC(2027, 9, 28, 12) / 1000;
const PERIOD_END_ISO = '2027-10-28T12:00:00.000Z';
// Production: the tier the alert sends on. The staging case passes its own env.
const ENV: Env = { ENV: 'production', SUPPORT_EMAIL: 'support@aeci.example' };

let t: TestDb;
let alerts: { to: string | undefined; rows: unknown[]; dedupeKey?: string }[];
let licenseSeq = 0;

beforeEach(async () => {
  t = await makeTestDb();
  alerts = [];
  await t.db.insert(vendors).values({ id: VENDOR_ID, slug: 'acme', companyName: 'Acme' });
  await t.db.insert(billingAccounts).values({ id: ACCOUNT, vendorId: VENDOR_ID, name: 'Acme' });
  await t.db.insert(profiles).values({ id: SEAT_ID, role: 'vendor_admin', vendorId: VENDOR_ID });
});
afterEach(() => t.dispose());

function subscription(
  over: Partial<StripeSubscription> & { quantity?: number; id?: string } = {},
): StripeSubscription {
  const { quantity = 2, ...rest } = over;
  return {
    id: SUB,
    status: 'active',
    customer: 'cus_1',
    cancel_at_period_end: false,
    metadata: { billing_account_id: ACCOUNT, vendor_id: VENDOR_ID, terms_version: '1.0' },
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

/** A live Stripe license on the account, in step with an annual subscription. */
async function seedStripeLicense(
  subscriptionId = SUB,
  over: Partial<typeof licenses.$inferInsert> = {},
): Promise<string> {
  const id = `77777777-7777-4777-8777-${String(++licenseSeq).padStart(12, '0')}`;
  await t.db.insert(licenses).values({
    id,
    billingAccountId: ACCOUNT,
    source: 'stripe',
    startsAt: '2026-01-01T00:00:00.000Z',
    endsAt: PERIOD_END_ISO,
    stripeSubscriptionId: subscriptionId,
    termsVersion: '1.0',
    ...over,
  });
  return id;
}

interface FakeStripe {
  client: StripeClient;
  listed: StripeSubscription[];
  byId: Map<string, StripeSubscription>;
  retrieves: string[];
  updates: { id: string; params: StripeUpdateSubscriptionParams }[];
  failRetrieve: Set<string>;
  /** Checkout sessions by subscription id. A subscription with none is `not_found`. */
  sessions: Map<string, StripeCheckoutSession>;
  sessionLookups: string[];
}

function fakeStripe(listed: StripeSubscription[], extra: StripeSubscription[] = []): FakeStripe {
  const f: FakeStripe = {
    listed,
    byId: new Map([...listed, ...extra].map((s) => [s.id, s])),
    retrieves: [],
    updates: [],
    failRetrieve: new Set(),
    sessions: new Map(),
    sessionLookups: [],
    client: undefined as never,
  };
  f.client = {
    listSubscriptions: async () => ({
      ok: true,
      data: { subscriptions: f.listed, truncated: false },
    }),
    retrieveSubscription: async (id: string): Promise<StripeResult<StripeSubscription>> => {
      f.retrieves.push(id);
      if (f.failRetrieve.has(id)) {
        return { ok: false, status: 500, reason: 'http_error', message: 'boom' };
      }
      const sub = f.byId.get(id);
      return sub
        ? { ok: true, data: sub }
        : { ok: false, status: 404, reason: 'not_found', message: 'gone' };
    },
    updateSubscription: async (id: string, params: StripeUpdateSubscriptionParams) => {
      f.updates.push({ id, params });
      const before = f.byId.get(id)!;
      const after: StripeSubscription = {
        ...before,
        cancel_at_period_end: params.cancel_at_period_end ?? before.cancel_at_period_end,
        metadata: { ...before.metadata, ...params.metadata },
      };
      f.byId.set(id, after);
      return { ok: true, data: after };
    },
    findCheckoutSessionForSubscription: async (
      id: string,
    ): Promise<StripeResult<StripeCheckoutSession>> => {
      f.sessionLookups.push(id);
      const session = f.sessions.get(id);
      return session
        ? { ok: true, data: session }
        : { ok: false, status: 404, reason: 'not_found', message: 'none' };
    },
  } as unknown as StripeClient;
  return f;
}

function emailContext(env: Env = ENV): { c: EmailContext; settle: () => Promise<void> } {
  const executionCtx = fakeExecutionContext();
  const c: EmailContext = {
    env,
    executionCtx,
    req: { raw: new Request('https://aeci-api/cron/stripe-reconcile') },
  };
  return {
    c,
    settle: async () => {
      await Promise.all(vi.mocked(executionCtx.waitUntil).mock.calls.map(([p]) => p));
    },
  };
}

function deps(stripe: StripeClient | null): StripeReconcileDeps {
  return {
    stripe,
    now: NOW,
    fetchSeatEmails: async (_env, ids) => new Map(ids.map((id) => [id, 'seat@acme.example'])),
    sendGranted: (async () => 'sent') as never,
    sendEnded: (async () => 'sent') as never,
    sendAlert: async (_c, o) => {
      alerts.push({ to: o.to, rows: [...o.rows], dedupeKey: o.dedupeKey });
      return 'sent';
    },
  };
}

async function reconcile(stripe: StripeClient | null, env: Env = ENV) {
  const { c, settle } = emailContext(env);
  const result = await runStripeReconcile(c, t.db, deps(stripe));
  await settle();
  return result;
}

const liveLicenses = async () =>
  (await t.db.select().from(licenses)).filter((l) => l.endedAt === null);

describe('runStripeReconcile', () => {
  it('with no Stripe client records a skipped run and changes nothing', async () => {
    await seedStripeLicense();
    const result = await reconcile(null);
    expect(result).toEqual({ outcome: 'skipped', reason: 'stripe_unconfigured' });
    expect(await liveLicenses()).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });

  it('a no-op run changes nothing and sends no alert', async () => {
    await seedStripeLicense();
    await seedStripeLicense();
    const stripe = fakeStripe([subscription({ quantity: 2 })]);

    const result = await reconcile(stripe.client);

    expect(result).toMatchObject({
      outcome: 'ok',
      counts: { listed: 1, synced: 1, retrieved: 0, changed: 0, granted: 0, ended: 0 },
      alert: null,
    });
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    expect(stripe.retrieves).toEqual([]);
    expect(stripe.updates).toEqual([]);
  });

  it('a missed invoice.paid grants the licenses and alerts SUPPORT_EMAIL once', async () => {
    await seedStripeLicense();
    const stripe = fakeStripe([subscription({ quantity: 3 })]);

    const result = await reconcile(stripe.client);

    expect(result).toMatchObject({
      outcome: 'ok',
      counts: { synced: 1, changed: 1, granted: 2, ended: 0 },
      alert: 'sent',
    });
    const live = (await liveLicenses()).filter((l) => l.stripeSubscriptionId === SUB);
    expect(live).toHaveLength(3);
    expect(live.every((l) => l.endsAt === PERIOD_END_ISO)).toBe(true);
    const granted = (await t.db.select().from(auditLog)).filter(
      (a) => a.action === 'license.granted',
    );
    expect(granted).toHaveLength(2);
    expect(granted[0]!.metadata).toMatchObject({ source: 'stripe-reconcile' });
    expect(alerts).toEqual([
      {
        to: 'support@aeci.example',
        rows: [
          {
            subscriptionId: SUB,
            vendorName: 'Acme',
            vendorId: VENDOR_ID,
            status: 'active',
            granted: 2,
            ended: 0,
            banCancelCleared: false,
            banCancelApplied: false,
            acceptanceBackfilled: false,
            billingEmailBackfilled: false,
          },
        ],
        dedupeKey: stripeReconcileAlertKey('2026-10-29', [SUB]),
      },
    ]);
  });

  it('converges: a second run (a queue retry) changes nothing and sends no alert', async () => {
    const stripe = fakeStripe([subscription({ quantity: 2 })]);
    await reconcile(stripe.client);
    const auditsAfterFirst = (await t.db.select().from(auditLog)).length;
    alerts = [];

    const again = await reconcile(stripe.client);

    expect(again).toMatchObject({ outcome: 'ok', counts: { changed: 0 }, alert: null });
    expect(await liveLicenses()).toHaveLength(2);
    expect(await t.db.select().from(auditLog)).toHaveLength(auditsAfterFirst);
    expect(alerts).toHaveLength(0);
  });

  it('a missed deletion ends the licenses of a subscription the list no longer returns', async () => {
    await seedStripeLicense('sub_gone');
    await seedStripeLicense('sub_gone');
    const stripe = fakeStripe([], [subscription({ id: 'sub_gone', status: 'canceled' })]);

    const result = await reconcile(stripe.client);

    expect(stripe.retrieves).toEqual(['sub_gone']);
    expect(result).toMatchObject({
      outcome: 'ok',
      counts: { listed: 0, synced: 1, retrieved: 1, changed: 1, ended: 2 },
      alert: 'sent',
    });
    const rows = await t.db.select().from(licenses);
    expect(rows.every((l) => l.endedAt !== null && l.endReason === 'lapsed')).toBe(true);
    expect(alerts[0]?.rows).toEqual([expect.objectContaining({ status: 'canceled', ended: 2 })]);
  });

  it('skips a listed subscription that is not ours and holds no license', async () => {
    const foreign = subscription({ id: 'sub_other_product', metadata: {} });
    const stripe = fakeStripe([foreign]);

    const result = await reconcile(stripe.client);

    expect(result).toMatchObject({ outcome: 'ok', counts: { listed: 1, synced: 0 } });
    expect(await t.db.select().from(licenses)).toHaveLength(0);
  });

  it('syncs every page of the list walk (pagination through the real client)', async () => {
    // Page 1 holds sub_a; page 2 holds sub_b. Both are ours, quantity 1, with no
    // licenses yet, so each grants one.
    const pages = [
      { data: [subscription({ id: 'sub_a', quantity: 1 })], has_more: true },
      { data: [subscription({ id: 'sub_b', quantity: 1 })], has_more: false },
    ];
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      // The acceptance lookups find no session: these subscriptions are only listed.
      const page = url.includes('/v1/checkout/sessions')
        ? { data: [], has_more: false }
        : pages[urls.push(url) - 1]!;
      return new Response(JSON.stringify({ object: 'list', ...page }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const client = createStripeClient({ secretKey: 'sk_test_x', fetchImpl });

    const result = await reconcile(client);

    expect(urls).toHaveLength(2);
    // The default status (every subscription not canceled): no `status` parameter.
    expect(urls[0]).not.toContain('status=');
    expect(urls[1]).toContain('starting_after=sub_a');
    expect(result).toMatchObject({ outcome: 'ok', counts: { listed: 2, synced: 2, granted: 2 } });
    const live = await liveLicenses();
    expect(new Set(live.map((l) => l.stripeSubscriptionId))).toEqual(new Set(['sub_a', 'sub_b']));
  });

  describe('the ban cancel (ruling on the E9.2 open question)', () => {
    const banned = () =>
      subscription({
        quantity: 1,
        cancel_at_period_end: true,
        metadata: {
          billing_account_id: ACCOUNT,
          vendor_id: VENDOR_ID,
          terms_version: '1.0',
          aeci_ban_cancel: 'true',
        },
      });

    it('clears a ban-set cancel once no live license on the account carries vendor-banned', async () => {
      await seedStripeLicense();
      const stripe = fakeStripe([banned()]);

      const result = await reconcile(stripe.client);

      expect(stripe.updates).toEqual([
        { id: SUB, params: { cancel_at_period_end: false, metadata: { aeci_ban_cancel: '' } } },
      ]);
      expect(result).toMatchObject({
        outcome: 'ok',
        counts: { banCancelsCleared: 1, changed: 1, granted: 0, ended: 0 },
      });
      expect(alerts[0]?.rows).toEqual([expect.objectContaining({ banCancelCleared: true })]);
    });

    it('leaves the cancel while a live license still carries vendor-banned', async () => {
      await seedStripeLicense(SUB, { cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
      const stripe = fakeStripe([banned()]);

      const result = await reconcile(stripe.client);

      expect(stripe.updates).toEqual([]);
      expect(result).toMatchObject({ counts: { banCancelsCleared: 0, changed: 0 } });
      const [row] = await t.db.select().from(licenses);
      expect(row).toMatchObject({ cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
    });

    it('sets the ban cancel and marker the ban hook failed to set, on a vendor still banned', async () => {
      await seedStripeLicense(SUB, { cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
      const stripe = fakeStripe([subscription({ quantity: 1 })]);

      const result = await reconcile(stripe.client);

      expect(stripe.updates).toEqual([
        {
          id: SUB,
          params: { cancel_at_period_end: true, metadata: { aeci_ban_cancel: 'true' } },
        },
      ]);
      expect(stripe.byId.get(SUB)).toMatchObject({
        cancel_at_period_end: true,
        metadata: { aeci_ban_cancel: 'true' },
      });
      expect(result).toMatchObject({
        outcome: 'ok',
        counts: { banCancelsApplied: 1, banCancelsCleared: 0, changed: 1 },
      });
      expect(alerts[0]?.rows).toEqual([
        expect.objectContaining({ banCancelApplied: true, banCancelCleared: false }),
      ]);
      // The sync never overwrites the ban's flag with the vendor's own cancel reason.
      const [row] = await t.db.select().from(licenses);
      expect(row).toMatchObject({ cancelAtTermEnd: true, cancelReason: 'vendor-banned' });

      // A second run sees the marker and changes nothing.
      alerts = [];
      const again = await reconcile(stripe.client);
      expect(stripe.updates).toHaveLength(1);
      expect(again).toMatchObject({ counts: { banCancelsApplied: 0, changed: 0 } });
    });

    // A Dashboard "Don't cancel" or Customer Portal "Renew" clears the cancel and keeps
    // the metadata, so the marker alone must not stop the run re-applying it.
    it('re-applies the cancel when the marker survived an undo in Stripe on a vendor still banned', async () => {
      await seedStripeLicense(SUB, { cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
      const stripe = fakeStripe([{ ...banned(), cancel_at_period_end: false }]);

      const result = await reconcile(stripe.client);

      expect(stripe.updates).toEqual([
        {
          id: SUB,
          params: { cancel_at_period_end: true, metadata: { aeci_ban_cancel: 'true' } },
        },
      ]);
      expect(stripe.byId.get(SUB)).toMatchObject({ cancel_at_period_end: true });
      expect(result).toMatchObject({
        outcome: 'ok',
        counts: { banCancelsApplied: 1, banCancelsCleared: 0, changed: 1 },
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.rows).toEqual([expect.objectContaining({ banCancelApplied: true })]);
      const [row] = await t.db.select().from(licenses);
      expect(row).toMatchObject({ cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
    });

    it('leaves an unbanned vendor with no cancel alone', async () => {
      await seedStripeLicense(SUB, { cancelAtTermEnd: false });
      const stripe = fakeStripe([subscription({ quantity: 1 })]);

      const result = await reconcile(stripe.client);

      expect(stripe.updates).toEqual([]);
      expect(result).toMatchObject({ counts: { banCancelsApplied: 0, changed: 0 } });
    });

    it('fails the subscription, so the queue retries, when the ban hook fails again', async () => {
      await seedStripeLicense(SUB, { cancelAtTermEnd: true, cancelReason: 'vendor-banned' });
      const stripe = fakeStripe([subscription({ quantity: 1 })]);
      stripe.failRetrieve.add(SUB);

      await expect(reconcile(stripe.client)).rejects.toThrow(/apply ban cancel sub_1/);
      expect(stripe.updates).toEqual([]);
    });

    it("never clears the vendor's own cancel, which has no marker", async () => {
      await seedStripeLicense(SUB, { cancelAtTermEnd: true, cancelReason: 'vendor-cancelled' });
      const stripe = fakeStripe([subscription({ quantity: 1, cancel_at_period_end: true })]);

      await reconcile(stripe.client);

      expect(stripe.updates).toEqual([]);
      const [row] = await t.db.select().from(licenses);
      expect(row).toMatchObject({ cancelAtTermEnd: true, cancelReason: 'vendor-cancelled' });
    });
  });

  // AECI-1503: staging's webhook endpoint is unreachable by design, so its reconcile
  // would alert every day. The alert is production-and-demo; the counts still land.
  describe('the alert, by tier', () => {
    it('on staging builds no alert, and the run still reports its counts', async () => {
      const stripe = fakeStripe([subscription({ quantity: 2 })]);

      const result = await reconcile(stripe.client, { ...ENV, ENV: 'staging' });

      expect(result).toMatchObject({
        outcome: 'ok',
        counts: { synced: 1, changed: 1, granted: 2 },
        alert: 'suppressed',
      });
      expect(alerts).toHaveLength(0);
      expect(await liveLicenses()).toHaveLength(2);
    });

    it('on local development builds no alert either', async () => {
      const stripe = fakeStripe([subscription({ quantity: 1 })]);
      const result = await reconcile(stripe.client, { ...ENV, ENV: 'development' });
      expect(result).toMatchObject({ counts: { changed: 1 }, alert: 'suppressed' });
      expect(alerts).toHaveLength(0);
    });

    it('on demo sends it', async () => {
      const stripe = fakeStripe([subscription({ quantity: 1 })]);
      const result = await reconcile(stripe.client, { ...ENV, ENV: 'demo' });
      expect(result).toMatchObject({ counts: { changed: 1 }, alert: 'sent' });
      expect(alerts).toHaveLength(1);
    });
  });

  describe('the missing checkout acceptance (AECI-1503)', () => {
    const CREATED = Date.UTC(2026, 9, 20, 9) / 1000;
    const CREATED_ISO = '2026-10-20T09:00:00.000Z';
    const session = (over: Partial<StripeCheckoutSession> = {}): StripeCheckoutSession => ({
      id: 'cs_1',
      url: null,
      mode: 'subscription',
      customer: 'cus_1',
      customer_details: { email: 'owner@acme.example' },
      subscription: SUB,
      metadata: {
        billing_account_id: ACCOUNT,
        vendor_id: VENDOR_ID,
        profile_id: SEAT_ID,
        terms_version: '1.0',
      },
      ...over,
    });
    const acceptances = () => t.db.select().from(agreementAcceptances);

    it('looks the session up and records the acceptance as the webhook does', async () => {
      await seedStripeLicense();
      await seedStripeLicense();
      const stripe = fakeStripe([subscription({ quantity: 2, created: CREATED })]);
      stripe.sessions.set(SUB, session());

      const result = await reconcile(stripe.client);

      expect(stripe.sessionLookups).toEqual([SUB]);
      // A missed webhook, so it counts as a change and alerts.
      expect(result).toMatchObject({
        counts: { acceptancesBackfilled: 1, changed: 1, granted: 0 },
        alert: 'sent',
      });
      expect(alerts[0]?.rows).toEqual([expect.objectContaining({ acceptanceBackfilled: true })]);
      const rows = await acceptances();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        document: 'managed_plan',
        version: '1.0',
        source: 'checkout',
        email: 'owner@acme.example',
        profileId: SEAT_ID,
        vendorId: VENDOR_ID,
        billingAccountId: ACCOUNT,
        stripeCheckoutSessionId: 'cs_1',
        acceptedAt: CREATED_ISO,
      });
      const audits = (await t.db.select().from(auditLog)).filter(
        (a) => a.action === 'agreement.accepted',
      );
      expect(audits).toHaveLength(1);
    });

    it("sets the empty billing email to the buyer's, with its audit row in the same batch", async () => {
      await seedStripeLicense();
      const stripe = fakeStripe([subscription({ quantity: 1, created: CREATED })]);
      stripe.sessions.set(SUB, session({ customer_details: { email: 'Owner@Acme.example ' } }));

      const result = await reconcile(stripe.client);

      expect(result).toMatchObject({
        counts: { billingEmailsBackfilled: 1, acceptancesBackfilled: 1, changed: 1 },
      });
      expect(alerts[0]?.rows).toEqual([
        expect.objectContaining({ billingEmailBackfilled: true, acceptanceBackfilled: true }),
      ]);
      const [account] = await t.db.select().from(billingAccounts);
      expect(account?.billingEmail).toBe('owner@acme.example');
      const audits = (await t.db.select().from(auditLog)).filter(
        (a) => a.action === 'billing_account.email_changed',
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actorType: 'system',
        entityId: ACCOUNT,
        metadata: { source: 'stripe-reconcile' },
      });
    });

    it('leaves a billing email the account already has alone', async () => {
      await seedStripeLicense();
      await t.db
        .update(billingAccounts)
        .set({ billingEmail: 'billing@acme.example' })
        .where(eq(billingAccounts.id, ACCOUNT));
      const stripe = fakeStripe([subscription({ quantity: 1, created: CREATED })]);
      stripe.sessions.set(SUB, session());

      const result = await reconcile(stripe.client);

      expect(result).toMatchObject({
        counts: { billingEmailsBackfilled: 0, acceptancesBackfilled: 1 },
      });
      const [account] = await t.db.select().from(billingAccounts);
      expect(account?.billingEmail).toBe('billing@acme.example');
    });

    it('is idempotent: a second run finds the row and asks Stripe nothing', async () => {
      await seedStripeLicense();
      const stripe = fakeStripe([subscription({ quantity: 1, created: CREATED })]);
      stripe.sessions.set(SUB, session());
      await reconcile(stripe.client);
      stripe.sessionLookups.length = 0;

      const again = await reconcile(stripe.client);

      expect(stripe.sessionLookups).toEqual([]);
      expect(again).toMatchObject({ counts: { acceptancesBackfilled: 0 } });
      expect(await acceptances()).toHaveLength(1);
    });

    it('never records a second row for a session that already has one', async () => {
      await seedStripeLicense();
      // The session's row predates the window, e.g. an older checkout on this account.
      await t.db.insert(agreementAcceptances).values({
        id: 'acc-1',
        document: 'managed_plan',
        version: '1.0',
        source: 'checkout',
        email: 'owner@acme.example',
        billingAccountId: ACCOUNT,
        stripeCheckoutSessionId: 'cs_1',
        acceptedAt: '2026-01-01T00:00:00.000Z',
      });
      const stripe = fakeStripe([subscription({ quantity: 1, created: CREATED })]);
      stripe.sessions.set(SUB, session());

      const result = await reconcile(stripe.client);

      expect(stripe.sessionLookups).toEqual([SUB]);
      expect(result).toMatchObject({ counts: { acceptancesBackfilled: 0 } });
      expect(await acceptances()).toHaveLength(1);
    });

    it('records the webhook-time acceptance as present and makes no lookup', async () => {
      await seedStripeLicense();
      await t.db.insert(agreementAcceptances).values({
        id: 'acc-1',
        document: 'managed_plan',
        version: '1.0',
        source: 'checkout',
        email: 'owner@acme.example',
        billingAccountId: ACCOUNT,
        stripeCheckoutSessionId: 'cs_1',
        acceptedAt: '2026-10-20T09:00:04.000Z',
      });
      const stripe = fakeStripe([subscription({ quantity: 1, created: CREATED })]);

      await reconcile(stripe.client);

      expect(stripe.sessionLookups).toEqual([]);
    });

    it('a failed lookup leaves the acceptance out and still syncs the licenses', async () => {
      const stripe = fakeStripe([subscription({ quantity: 1, created: CREATED })]);
      stripe.client.findCheckoutSessionForSubscription = async () => ({
        ok: false,
        status: 0,
        reason: 'timeout',
        message: 'timed out',
      });

      const result = await reconcile(stripe.client);

      expect(result).toMatchObject({ counts: { granted: 1, acceptancesBackfilled: 0, failed: 0 } });
      expect(await acceptances()).toHaveLength(0);
    });
  });

  // AECI-1503: a missed renewal binds the current agreement version, as the webhook's
  // `invoice.paid` (`subscription_cycle`) path does.
  it('a missed annual renewal moves ends_at and binds the current terms version', async () => {
    const OLD_END = '2026-10-28T12:00:00.000Z';
    const id = await seedStripeLicense(SUB, { endsAt: OLD_END, termsVersion: '0.9' });
    const stripe = fakeStripe([subscription({ quantity: 1 })]);

    const result = await reconcile(stripe.client);

    expect(result).toMatchObject({ counts: { changed: 1, granted: 0, ended: 0 } });
    const [row] = await t.db.select().from(licenses).where(eq(licenses.id, id));
    expect(row).toMatchObject({
      endsAt: PERIOD_END_ISO,
      termsVersion: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
    });
  });

  it('a sync with the period unchanged leaves the terms version alone', async () => {
    const id = await seedStripeLicense(SUB, { termsVersion: '0.9' });
    const stripe = fakeStripe([subscription({ quantity: 1 })]);

    await reconcile(stripe.client);

    const [row] = await t.db.select().from(licenses).where(eq(licenses.id, id));
    expect(row).toMatchObject({ endsAt: PERIOD_END_ISO, termsVersion: '0.9' });
  });

  it('syncs the rest, alerts, then throws so the queue retries when one subscription fails', async () => {
    await seedStripeLicense('sub_gone');
    const stripe = fakeStripe(
      [subscription({ quantity: 1 })],
      [subscription({ id: 'sub_gone', status: 'canceled' })],
    );
    stripe.failRetrieve.add('sub_gone');
    const { c, settle } = emailContext();

    const error = await runStripeReconcile(c, t.db, deps(stripe.client)).catch((e: unknown) => e);
    await settle();

    expect(error).toBeInstanceOf(StripeReconcileError);
    expect((error as StripeReconcileError).message).toContain('sub_gone');
    expect((error as StripeReconcileError).result.counts).toMatchObject({
      synced: 1,
      failed: 1,
      granted: 1,
    });
    expect(alerts).toHaveLength(1);
    // The failed one is untouched; the retry will end it.
    const [gone] = await t.db
      .select()
      .from(licenses)
      .where(eq(licenses.stripeSubscriptionId, 'sub_gone'));
    expect(gone?.endedAt).toBeNull();
  });

  it('throws before any write when the list walk fails', async () => {
    await seedStripeLicense();
    const client = {
      listSubscriptions: async () => ({
        ok: false,
        status: 503,
        reason: 'http_error',
        message: 'down',
      }),
    } as unknown as StripeClient;

    await expect(reconcile(client)).rejects.toThrow(/list subscriptions/);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
