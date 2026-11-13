/**
 * The daily Stripe reconcile (AECI-1503, E9.5) against the in-memory D1 harness: real
 * migration-built tables, the real sync, and a fake Stripe client. Nothing reaches
 * Stripe, Resend or GoTrue: the senders record, and PostHog is mocked.
 */

import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_IN_FORCE_MAPS,
  legalEffectiveAtMs,
  PLANS_PAGE_CURRENT_VERSION,
  plansPageSha256,
  type LegalInForceMaps,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  billingAccounts,
  legalVersions,
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
  /** `cancelSubscriptionNow` calls (AECI-1589). */
  cancels: string[];
  failCancel: boolean;
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
    cancels: [],
    failCancel: false,
    failRetrieve: new Set(),
    sessions: new Map(),
    sessionLookups: [],
    client: undefined as never,
  };
  f.client = {
    // Stripe's default list leaves canceled subscriptions out.
    listSubscriptions: async () => ({
      ok: true,
      data: {
        subscriptions: f.listed
          .map((s) => f.byId.get(s.id) ?? s)
          .filter((s) => s.status !== 'canceled'),
        truncated: false,
      },
    }),
    cancelSubscriptionNow: async (id: string): Promise<StripeResult<StripeSubscription>> => {
      f.cancels.push(id);
      if (f.failCancel) return { ok: false, status: 0, reason: 'network', message: 'down' };
      const after = { ...f.byId.get(id)!, status: 'canceled' as const };
      f.byId.set(id, after);
      return { ok: true, data: after };
    },
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

async function reconcile(
  stripe: StripeClient | null,
  env: Env = ENV,
  over: Partial<StripeReconcileDeps> = {},
) {
  const { c, settle } = emailContext(env);
  const result = await runStripeReconcile(c, t.db, { ...deps(stripe), ...over });
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
            banCancelledNow: false,
            acceptanceBackfilled: false,
            billingEmailBackfilled: false,
            termsBound: null,
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

  // AECI-1589: the ban ends every license `banned` and cancels the subscription now,
  // after commit. When that cancel failed, the run finds the subscription ban-dead.
  describe('a ban-dead subscription (AECI-1589)', () => {
    async function seedBannedLicense(): Promise<void> {
      await seedStripeLicense(SUB, {
        endedAt: '2026-10-28T00:00:00.000Z',
        endReason: 'banned',
      });
    }

    it('cancels it now, grants nothing, counts banCancelsNow and alerts', async () => {
      await seedBannedLicense();
      const stripe = fakeStripe([subscription({ quantity: 1 })]);

      const result = await reconcile(stripe.client);

      expect(stripe.cancels).toEqual([SUB]);
      expect(stripe.updates).toEqual([]);
      expect(result).toMatchObject({
        outcome: 'ok',
        counts: { banCancelsNow: 1, changed: 1, granted: 0, ended: 0 },
      });
      expect(await liveLicenses()).toEqual([]);
      expect(alerts[0]?.rows).toEqual([expect.objectContaining({ banCancelledNow: true })]);

      // The second run: Stripe lists it no more and D1 holds no live license on it.
      alerts = [];
      const again = await reconcile(stripe.client);
      expect(stripe.cancels).toEqual([SUB]);
      expect(again).toMatchObject({ counts: { banCancelsNow: 0, changed: 0 } });
      expect(alerts).toHaveLength(0);
    });

    it('fails the subscription, so the queue retries, when the cancel fails again', async () => {
      await seedBannedLicense();
      const stripe = fakeStripe([subscription({ quantity: 1 })]);
      stripe.failCancel = true;
      stripe.failRetrieve.add(SUB);

      await expect(reconcile(stripe.client)).rejects.toThrow(/ban-dead subscription sub_1/);
      expect(await liveLicenses()).toEqual([]);
    });

    it('leaves a live subscription with no banned license alone', async () => {
      await seedStripeLicense(SUB, { cancelAtTermEnd: false });
      const stripe = fakeStripe([subscription({ quantity: 1 })]);

      const result = await reconcile(stripe.client);

      expect(stripe.cancels).toEqual([]);
      expect(result).toMatchObject({ counts: { banCancelsNow: 0, changed: 0 } });
    });

    // AECI-1596: a cancel the webhook missed still gets its confirmation.
    it('sends renewal-cancelled for a cancel only the reconcile saw', async () => {
      await seedStripeLicense(SUB);
      const stripe = fakeStripe([subscription({ quantity: 1, cancel_at_period_end: true })]);
      const sendRenewalCancelled = vi.fn(async () => 'sent' as const);

      const { c, settle } = emailContext();
      await runStripeReconcile(c, t.db, {
        ...deps(stripe.client),
        sendRenewalCancelled: sendRenewalCancelled as never,
      });
      await settle();

      expect(sendRenewalCancelled).toHaveBeenCalled();
    });

    it("leaves the vendor's own cancel, with live licenses, untouched", async () => {
      await seedStripeLicense(SUB, { cancelAtTermEnd: true, cancelReason: 'vendor-cancelled' });
      const stripe = fakeStripe([subscription({ quantity: 1, cancel_at_period_end: true })]);

      await reconcile(stripe.client);

      expect(stripe.cancels).toEqual([]);
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
        // AECI-1619: this session predates the plans_version metadata.
        plansPageVersion: null,
        plansPageSha256: null,
      });
      const audits = (await t.db.select().from(auditLog)).filter(
        (a) => a.action === 'agreement.accepted',
      );
      expect(audits).toHaveLength(1);
    });

    it('records the session plans_version and its snapshot hash, as the webhook does (AECI-1619)', async () => {
      await seedStripeLicense();
      const stripe = fakeStripe([subscription({ quantity: 1, created: CREATED })]);
      const base = session();
      stripe.sessions.set(
        SUB,
        session({ metadata: { ...base.metadata, plans_version: PLANS_PAGE_CURRENT_VERSION } }),
      );

      await reconcile(stripe.client);

      const [row] = await acceptances();
      expect(row).toMatchObject({
        stripeCheckoutSessionId: 'cs_1',
        plansPageVersion: PLANS_PAGE_CURRENT_VERSION,
        plansPageSha256: plansPageSha256(PLANS_PAGE_CURRENT_VERSION),
      });
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

// ─── AECI-1690: the monthly catch-up ─────────────────────────────────────────

describe('runStripeReconcile: the monthly agreement-version catch-up (AECI-1690)', () => {
  const MOMENT = legalEffectiveAtMs('2027-03-01');
  const MAPS = {
    ...LEGAL_IN_FORCE_MAPS,
    agreementCurrent: { ...LEGAL_IN_FORCE_MAPS.agreementCurrent, managed_plan: '1.1' },
    agreementUpcoming: { managed_plan: { version: '1.2', effectiveOn: '2027-03-01' } },
  } satisfies LegalInForceMaps;
  const RUN_AT = new Date(MOMENT + 3 * 86_400_000);

  function monthly(startMs: number): StripeSubscription {
    const start = Math.floor(startMs / 1000);
    const sub = subscription({ quantity: 1 });
    sub.metadata = { ...sub.metadata, terms_version: '1.1' };
    sub.items.data[0] = {
      ...sub.items.data[0]!,
      price: { id: 'price_m', recurring: { interval: 'month' } },
      current_period_start: start,
      current_period_end: start + 30 * 86_400,
    };
    return sub;
  }

  async function publish(requiresAcceptance: boolean) {
    await t.db.insert(legalVersions).values({
      document: 'managed_plan',
      version: '1.2',
      effectiveAt: MOMENT,
      summaryJson: '[]',
      material: true,
      requiresAcceptance,
      pdfKey: 'legal/managed-plan-agreement/v1.2.pdf',
      pdfSha256: '0'.repeat(64),
      pdfBytes: 10,
      publishedBy: 'admin',
      publishedAt: '2026-12-01T00:00:00.000Z',
    });
  }

  const versionOf = async (id: string) =>
    (await t.db.select().from(licenses).where(eq(licenses.id, id)))[0]!.termsVersion;
  const run = (stripe: StripeClient) => reconcile(stripe, ENV, { now: RUN_AT, legalMaps: MAPS });

  it("is a no-op with today's data: no version above the bound, nothing changes", async () => {
    const id = await seedStripeLicense(SUB, { endsAt: null, termsVersion: '1.1' });
    const stripe = fakeStripe([monthly(NOW.getTime())]);
    const result = await reconcile(stripe.client);
    expect(result).toMatchObject({ counts: { changed: 0, termsBound: 0 } });
    expect(await versionOf(id)).toBe('1.1');
    expect(stripe.updates).toEqual([]);
  });

  it('never binds a draft mid-period: a monthly license on 1.0 waits for its next charge', async () => {
    const id = await seedStripeLicense(SUB, { endsAt: null, termsVersion: '1.0' });
    const stripe = fakeStripe([monthly(NOW.getTime())]);
    expect(await reconcile(stripe.client)).toMatchObject({ counts: { changed: 0 } });
    expect(await versionOf(id)).toBe('1.0');
  });

  it('binds a version a missed monthly invoice.paid should have bound, once', async () => {
    await publish(false);
    const id = await seedStripeLicense(SUB, { endsAt: null, termsVersion: '1.1' });
    const stripe = fakeStripe([monthly(MOMENT + 86_400_000)]);

    const first = await run(stripe.client);
    expect(first).toMatchObject({ counts: { changed: 1, termsBound: 1, granted: 0 } });
    expect(await versionOf(id)).toBe('1.2');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.rows[0]).toMatchObject({ termsBound: '1.2' });

    // Idempotent: a second run (a queue retry) finds the licenses bound.
    const second = await run(stripe.client);
    expect(second).toMatchObject({ counts: { changed: 0, termsBound: 0 } });
    expect(stripe.updates).toEqual([]);
  });

  it('a period that started before the moment binds nothing', async () => {
    await publish(false);
    const id = await seedStripeLicense(SUB, { endsAt: null, termsVersion: '1.1' });
    const stripe = fakeStripe([monthly(MOMENT - 1000)]);
    expect(await run(stripe.client)).toMatchObject({ counts: { changed: 0 } });
    expect(await versionOf(id)).toBe('1.1');
  });

  async function acceptAt(acceptedAt: string) {
    await t.db.insert(agreementAcceptances).values({
      id: crypto.randomUUID(),
      document: 'managed_plan',
      version: '1.2',
      source: 'portal',
      email: 'owner@acme.example',
      vendorId: VENDOR_ID,
      acceptedAt,
    });
  }

  it('D1: an acceptance after the period start waits for the next period; nothing binds mid-period', async () => {
    await publish(true);
    const id = await seedStripeLicense(SUB, { endsAt: null, termsVersion: '1.1' });
    const periodStart = MOMENT + 86_400_000;
    const stripe = fakeStripe([monthly(periodStart)]);

    expect(await run(stripe.client)).toMatchObject({ counts: { changed: 0, termsBound: 0 } });
    expect(await versionOf(id)).toBe('1.1');

    // The owner accepts mid-period: the reconcile does not bind it in this period.
    await acceptAt(RUN_AT.toISOString());
    expect(await run(stripe.client)).toMatchObject({ counts: { changed: 0, termsBound: 0 } });
    expect(await versionOf(id)).toBe('1.1');

    // The next period started after the acceptance. Its invoice.paid was missed, so the
    // reconcile completes that bind.
    const next = periodStart + 30 * 86_400_000;
    stripe.byId.set(SUB, monthly(next));
    const later = await reconcile(stripe.client, ENV, {
      now: new Date(next + 3 * 86_400_000),
      legalMaps: MAPS,
    });
    expect(later).toMatchObject({ counts: { termsBound: 1 } });
    expect(await versionOf(id)).toBe('1.2');
    // Never a Stripe write for terms: no cancel, no pause, no metadata.
    expect(stripe.updates).toEqual([]);
    expect(stripe.cancels).toEqual([]);
  });

  it('completes a missed charge whose acceptance came before the period start', async () => {
    await publish(true);
    await acceptAt(new Date(MOMENT).toISOString());
    const id = await seedStripeLicense(SUB, { endsAt: null, termsVersion: '1.1' });
    const stripe = fakeStripe([monthly(MOMENT + 86_400_000)]);
    expect(await run(stripe.client)).toMatchObject({ counts: { termsBound: 1 } });
    expect(await versionOf(id)).toBe('1.2');
  });

  it("a new subscription's first period is not a renewal: a checkout straddling the moment keeps its version", async () => {
    await publish(false);
    // Checkout opened at 11:50 UTC on the effective day stamped 1.1. Payment at 12:05
    // started the period after the moment, and the webhook granted the license then.
    const paidAt = MOMENT + 5 * 60_000;
    const id = await seedStripeLicense(SUB, {
      endsAt: null,
      termsVersion: '1.1',
      startsAt: new Date(paidAt + 2000).toISOString(),
    });
    const stripe = fakeStripe([monthly(paidAt)]);
    expect(await run(stripe.client)).toMatchObject({ counts: { changed: 0, termsBound: 0 } });
    expect(await versionOf(id)).toBe('1.1');
  });

  it('runs only on an active subscription with a known monthly interval', async () => {
    await publish(false);
    const id = await seedStripeLicense(SUB, { endsAt: null, termsVersion: '1.1' });
    const pastDue = { ...monthly(MOMENT + 86_400_000), status: 'past_due' as const };
    expect(await run(fakeStripe([pastDue]).client)).toMatchObject({ counts: { termsBound: 0 } });
    const unknown = monthly(MOMENT + 86_400_000);
    unknown.items.data[0] = { ...unknown.items.data[0]!, price: { id: 'price_x' } };
    expect(await run(fakeStripe([unknown]).client)).toMatchObject({ counts: { termsBound: 0 } });
    expect(await versionOf(id)).toBe('1.1');
  });
});
