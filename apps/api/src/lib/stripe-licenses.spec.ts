/**
 * The Stripe subscription → license sync (AECI-1500, E9.2) on the real migrations in the
 * in-memory harness: run the sync over a subscription object, read the rows back. The
 * Stripe client, the senders and the seat-email seam are fakes, so nothing here reaches
 * Stripe, Resend or GoTrue.
 */

import { LEGAL_AGREEMENT_CURRENT_VERSIONS, LEGAL_AGREEMENT_KNOWN_VERSIONS } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  billingAccounts,
  integrationFieldChallenges,
  integrations,
  licenses,
  productVendors,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import type { EmailContext } from './email';
import type { LicenseBefore } from './license';
import {
  StripeTransientError,
  type StripeClient,
  type StripeSubscription,
  type StripeSubscriptionStatus,
} from './stripe';
import {
  annualPeriodMovedForward,
  BAN_CANCEL_DEADLINE_MS,
  runStripeSubscriptionSync,
  STRIPE_LICENSE_NAMESPACE,
  stripeBanCancelNowHook,
  stripeLicenseIds,
  type SendManagedEnded,
  type StripeSyncRunOptions,
} from './stripe-licenses';
import { URL_NAMESPACE, uuidv5 } from './uuidv5';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const VENDOR_ID = '11111111-1111-4111-8111-111111111111';
const VENDOR_B_ID = '33333333-3333-4333-8333-333333333333';
const SEAT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = 'ba-1';
const SUB = 'sub_1';
const OLD_TS = '2020-01-01T00:00:00.000Z';
const NOW = new Date('2026-10-28T12:00:00.000Z');
/** 2027-10-28T12:00:00Z, in Unix seconds. */
const PERIOD_END = Date.UTC(2027, 9, 28, 12) / 1000;
const PERIOD_END_ISO = '2027-10-28T12:00:00.000Z';

let t: TestDb;
let pending: Promise<unknown>[];

beforeEach(async () => {
  t = await makeTestDb();
  pending = [];
  await t.db.insert(vendors).values([
    { id: VENDOR_ID, slug: 'acme', companyName: 'Acme', verified: false, updatedAt: OLD_TS },
    { id: VENDOR_B_ID, slug: 'bolt', companyName: 'Bolt', verified: false, updatedAt: OLD_TS },
  ]);
  await t.db
    .insert(billingAccounts)
    .values({ id: ACCOUNT, vendorId: VENDOR_ID, name: 'Acme', billingEmail: 'bill@acme.example' });
  await t.db.insert(profiles).values({ id: SEAT_ID, role: 'vendor_admin', vendorId: VENDOR_ID });
  await t.db.insert(products).values([
    { id: 'p-1', slug: 'acme-one', name: 'Acme One', promotionStatus: 'promoted' },
    { id: 'p-2', slug: 'acme-two', name: 'Acme Two', promotionStatus: 'promoted' },
    { id: 'p-b', slug: 'bolt-one', name: 'Bolt One', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: 'p-1', vendorId: VENDOR_ID },
    { productId: 'p-2', vendorId: VENDOR_ID },
    { productId: 'p-b', vendorId: VENDOR_B_ID },
  ]);
});
afterEach(() => t.dispose());

function subscription(
  over: Partial<StripeSubscription> & {
    quantity?: number;
    interval?: 'year' | 'month';
    periodEnd?: number;
  } = {},
): StripeSubscription {
  const { quantity = 2, interval = 'year', periodEnd = PERIOD_END, ...rest } = over;
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
          price: { id: 'price_1', recurring: { interval } },
          current_period_end: periodEnd,
        },
      ],
    },
    ...rest,
  };
}

async function seedLicense(id: string, over: Partial<typeof licenses.$inferInsert> = {}) {
  await t.db.insert(licenses).values({
    id,
    billingAccountId: ACCOUNT,
    source: 'stripe',
    stripeSubscriptionId: SUB,
    startsAt: OLD_TS,
    endsAt: PERIOD_END_ISO,
    termsVersion: '1.0',
    createdAt: OLD_TS,
    updatedAt: OLD_TS,
    ...over,
  });
}

const allLicenses = () => t.db.select().from(licenses).orderBy(licenses.createdAt, licenses.id);
const licenseOf = async (id: string) =>
  (await t.db.select().from(licenses).where(eq(licenses.id, id)))[0]!;
const vendorOf = async () =>
  (await t.db.select().from(vendors).where(eq(vendors.id, VENDOR_ID)))[0]!;

function ctx(env: Partial<Env> = {}): EmailContext {
  return {
    env: { ...env } as Env,
    executionCtx: { waitUntil: (p) => void pending.push(p) },
    req: { raw: new Request('https://aeci-api/api/webhooks/stripe') },
  };
}

const seatEmails = async (_env: Env, ids: readonly string[]) =>
  new Map(ids.map((id) => [id, 'seat@acme.example']));

function senders() {
  const ended: { to: string; cause: string; products: string[]; dedupeKey?: string }[] = [];
  const granted: { to: string; count: number; source: string; endsAt: string | null }[] = [];
  const sendEnded = vi.fn(async (_c, o) => {
    ended.push({
      to: o.to,
      cause: o.cause,
      products: o.products.map((p: { slug: string }) => p.slug),
      dedupeKey: o.dedupeKey,
    });
    return 'sent' as const;
  }) as unknown as SendManagedEnded;
  const sendGranted = vi.fn(async (_c, o) => {
    granted.push({ to: o.to, count: o.count, source: o.source, endsAt: o.endsAt });
    return 'sent' as const;
  }) as unknown as NonNullable<StripeSyncRunOptions['sendGranted']>;
  return { ended, granted, sendEnded, sendGranted };
}

async function run(
  sub: StripeSubscription,
  over: Partial<StripeSyncRunOptions> = {},
  s = senders(),
) {
  const result = await runStripeSubscriptionSync(ctx(), t.db, sub, {
    source: 'stripe-webhook',
    now: NOW,
    fetchSeatEmails: seatEmails,
    sendEnded: s.sendEnded,
    sendGranted: s.sendGranted,
    ...over,
  });
  await Promise.all(pending);
  pending = [];
  return result;
}

describe('license ids', () => {
  it('mints under the pinned namespace, by subscription and ordinal', async () => {
    expect(await uuidv5('https://aecintegrations.com/stripe/licenses', URL_NAMESPACE)).toBe(
      STRIPE_LICENSE_NAMESPACE,
    );
    const [third] = await stripeLicenseIds(SUB, 2, 1);
    expect(third).toBe(await uuidv5(`stripe-license:${SUB}:3`, STRIPE_LICENSE_NAMESPACE));
  });
});

describe('grant delta', () => {
  it('grants the quantity on an annual subscription, then converges', async () => {
    const s = senders();
    const result = await run(subscription({ quantity: 2 }), {}, s);

    expect(result).toMatchObject({ outcome: 'synced', verifiedFlipped: true });
    const rows = await allLicenses();
    expect(rows.map((r) => r.id).sort()).toEqual((await stripeLicenseIds(SUB, 0, 2)).sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        source: 'stripe',
        stripeSubscriptionId: SUB,
        endsAt: PERIOD_END_ISO,
        termsVersion: '1.0',
        endedAt: null,
      });
    }
    expect((await vendorOf()).verified).toBe(true);
    // Every unbanned seat and the billing email, each once.
    expect(s.granted).toEqual([
      { to: 'seat@acme.example', count: 2, source: 'stripe', endsAt: PERIOD_END_ISO },
      { to: 'bill@acme.example', count: 2, source: 'stripe', endsAt: PERIOD_END_ISO },
    ]);

    const again = senders();
    expect((await run(subscription({ quantity: 2 }), {}, again)).outcome).toBe('no_change');
    expect(await allLicenses()).toHaveLength(2);
    expect(again.granted).toHaveLength(0);
  });

  it('grants only the delta when the quantity rises, with the next ordinal id', async () => {
    await run(subscription({ quantity: 2 }));
    const result = await run(subscription({ quantity: 3 }));
    expect(result.granted).toEqual(await stripeLicenseIds(SUB, 2, 1));
    expect(await allLicenses()).toHaveLength(3);
  });

  it('writes a monthly subscription with no end date', async () => {
    const s = senders();
    await run(subscription({ quantity: 1, interval: 'month' }), {}, s);
    const [row] = await allLicenses();
    expect(row!.endsAt).toBeNull();
    expect(s.granted[0]!.endsAt).toBeNull();
  });

  it('writes nothing for an incomplete subscription', async () => {
    const result = await run(subscription({ status: 'incomplete' }));
    expect(result.outcome).toBe('skipped');
    expect(await allLicenses()).toHaveLength(0);
  });

  it('writes nothing and reports unlinked when no billing account matches', async () => {
    const result = await run(
      subscription({ metadata: { billing_account_id: 'nope' }, customer: 'cus_unknown' }),
    );
    expect(result.outcome).toBe('unlinked');
    expect(await allLicenses()).toHaveLength(0);
  });

  it('finds the account by customer id when the metadata is missing', async () => {
    await t.db
      .update(billingAccounts)
      .set({ stripeCustomerId: 'cus_1' })
      .where(eq(billingAccounts.id, ACCOUNT));
    const result = await run(subscription({ metadata: {} }));
    expect(result.outcome).toBe('synced');
    expect(await allLicenses()).toHaveLength(2);
  });
});

describe('surplus', () => {
  beforeEach(async () => {
    await seedLicense('l-old', {
      assignedProductId: 'p-1',
      assignedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await seedLicense('l-new', {
      assignedProductId: 'p-2',
      assignedAt: '2026-06-01T00:00:00.000Z',
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    await seedLicense('l-pool-stripe', { createdAt: '2026-01-03T00:00:00.000Z' });
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR_ID));
  });

  it('ends unassigned first, then the newest assignment, and carries its product over', async () => {
    // A complimentary pool license on the same account receives the carried product.
    await seedLicense('l-comp', {
      source: 'complimentary',
      stripeSubscriptionId: null,
      endsAt: null,
      createdAt: '2026-01-04T00:00:00.000Z',
    });
    const s = senders();
    const result = await run(subscription({ quantity: 1 }), {}, s);

    expect((await licenseOf('l-pool-stripe')).endReason).toBe('released');
    expect((await licenseOf('l-new')).endReason).toBe('released');
    expect((await licenseOf('l-old')).endedAt).toBeNull();
    // Ruling A: the carried product keeps its seniority.
    expect(await licenseOf('l-comp')).toMatchObject({
      assignedProductId: 'p-2',
      assignedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(result.carried).toEqual([
      { productId: 'p-2', fromLicenseId: 'l-new', toLicenseId: 'l-comp' },
    ]);
    // A carried product stays Managed: no email.
    expect(s.ended).toHaveLength(0);
  });

  it('emails managed-ended for a product with nowhere to carry', async () => {
    const s = senders();
    await run(subscription({ quantity: 1 }), {}, s);
    expect(s.ended.map((e) => [e.to, e.cause, e.products])).toEqual([
      ['seat@acme.example', 'released', ['acme-two']],
      ['bill@acme.example', 'released', ['acme-two']],
    ]);
    expect(s.ended[0]!.dedupeKey).toMatch(/^managed-ended:stripe:sub_1:/);
  });
});

describe('term, renewal and the cancel flag', () => {
  beforeEach(async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
  });

  it('a renewal moves ends_at and binds the CURRENT agreement version (ruling R1)', async () => {
    const known = LEGAL_AGREEMENT_KNOWN_VERSIONS.managed_plan as unknown as string[];
    const current = LEGAL_AGREEMENT_CURRENT_VERSIONS as unknown as Record<string, string>;
    known.push('1.1');
    current.managed_plan = '1.1';
    try {
      const next = Date.UTC(2028, 9, 28, 12) / 1000;
      await run(subscription({ quantity: 1, periodEnd: next }), { renewal: true });
      expect(await licenseOf('l-1')).toMatchObject({
        endsAt: '2028-10-28T12:00:00.000Z',
        termsVersion: '1.1',
      });
      const [row] = await t.db.select().from(auditLog);
      expect(row).toMatchObject({ action: 'license.term_changed', actorType: 'system' });
    } finally {
      known.pop();
      current.managed_plan = '1.0';
    }
  });

  it('a non-renewal sync leaves the version alone', async () => {
    const next = Date.UTC(2028, 9, 28, 12) / 1000;
    await run(
      subscription({
        quantity: 1,
        periodEnd: next,
        metadata: { ...subscription().metadata, terms_version: '0.9' },
      }),
    );
    expect((await licenseOf('l-1')).termsVersion).toBe('1.0');
  });

  it('maps cancel_at_period_end to vendor-cancelled, and clears it', async () => {
    await run(subscription({ quantity: 1, cancel_at_period_end: true }));
    expect(await licenseOf('l-1')).toMatchObject({
      cancelAtTermEnd: true,
      cancelReason: 'vendor-cancelled',
    });
    await run(subscription({ quantity: 1, cancel_at_period_end: false }));
    expect(await licenseOf('l-1')).toMatchObject({ cancelAtTermEnd: false, cancelReason: null });
  });

  // AECI-1596: the confirmation, from the one sync both cancel routes pass through.
  describe('the renewal-cancelled email', () => {
    type Cancelled = { to: string; endDay: string; interval: string; dedupeKey?: string };
    function cancelSender() {
      const sent: Cancelled[] = [];
      const sendRenewalCancelled = vi.fn(async (_c, o) => {
        sent.push({ to: o.to, endDay: o.endDay, interval: o.interval, dedupeKey: o.dedupeKey });
        return 'sent' as const;
      }) as unknown as NonNullable<StripeSyncRunOptions['sendRenewalCancelled']>;
      return { sent, sendRenewalCancelled };
    }
    const cancelled = (over: Parameters<typeof subscription>[0] = {}) =>
      subscription({
        quantity: 1,
        cancel_at_period_end: true,
        canceled_at: 1_800_000_000,
        ...over,
      });

    it('sends on the sync that sets the flag, naming the period end', async () => {
      const { sent, sendRenewalCancelled } = cancelSender();
      await run(cancelled(), { sendRenewalCancelled });
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent.map((s) => s.to)).size).toBe(sent.length);
      expect(sent[0]).toMatchObject({
        endDay: PERIOD_END_ISO.slice(0, 10),
        interval: 'year',
      });
      expect(sent[0]?.dedupeKey).toMatch(new RegExp(`^renewal-cancelled:${SUB}:1800000000:`));
    });

    it('sends nothing on a replay, or when the flag clears', async () => {
      const { sent, sendRenewalCancelled } = cancelSender();
      await run(cancelled(), { sendRenewalCancelled });
      const first = sent.length;
      await run(cancelled(), { sendRenewalCancelled });
      expect(sent).toHaveLength(first);
      await run(subscription({ quantity: 1, cancel_at_period_end: false }), {
        sendRenewalCancelled,
      });
      expect(sent).toHaveLength(first);
    });

    it('sends again, under a new key, for a cancel after an undo', async () => {
      const { sent, sendRenewalCancelled } = cancelSender();
      await run(cancelled(), { sendRenewalCancelled });
      const first = sent.length;
      await run(subscription({ quantity: 1 }), { sendRenewalCancelled });
      await run(cancelled({ canceled_at: 1_800_000_500 }), { sendRenewalCancelled });
      expect(sent.length).toBe(first * 2);
      expect(sent.at(-1)?.dedupeKey).toContain(':1800000500:');
    });

    it('covers a monthly cancel, with the period end as the date', async () => {
      await t.db.update(licenses).set({ endsAt: null }).where(eq(licenses.id, 'l-1'));
      const { sent, sendRenewalCancelled } = cancelSender();
      await run(cancelled({ interval: 'month' }), { sendRenewalCancelled });
      expect(sent[0]).toMatchObject({
        endDay: PERIOD_END_ISO.slice(0, 10),
        interval: 'month',
      });
    });

    it('sends nothing when Stripe gives no period end', async () => {
      const { sent, sendRenewalCancelled } = cancelSender();
      const sub = cancelled();
      delete sub.items.data[0]!.current_period_end;
      await run(sub, { sendRenewalCancelled });
      expect(sent).toHaveLength(0);
    });

    it('does not send for a subscription that ends at once', async () => {
      const { sent, sendRenewalCancelled } = cancelSender();
      await run(subscription({ quantity: 1, status: 'canceled' }), { sendRenewalCancelled });
      expect(sent).toHaveLength(0);
    });
  });

  it("a banned vendor's sync never clears or overwrites the ban flag", async () => {
    await t.db
      .update(licenses)
      .set({ cancelAtTermEnd: true, cancelReason: 'vendor-banned' })
      .where(eq(licenses.id, 'l-1'));
    await run(subscription({ quantity: 1, cancel_at_period_end: false }));
    expect(await licenseOf('l-1')).toMatchObject({
      cancelAtTermEnd: true,
      cancelReason: 'vendor-banned',
    });
    await run(subscription({ quantity: 1, cancel_at_period_end: true }));
    expect((await licenseOf('l-1')).cancelReason).toBe('vendor-banned');
  });
});

describe('a dead subscription', () => {
  const contestId = 'contest-1';

  beforeEach(async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    await t.db.update(vendors).set({ verified: true }).where(eq(vendors.id, VENDOR_ID));
    await t.db.insert(integrations).values({
      id: 'i-powered',
      sourceProductId: 'p-1',
      targetProductId: 'p-b',
      mechanismKind: 'iPaaS',
      builtByVendorId: VENDOR_ID,
      claimedAt: OLD_TS,
    });
    t.raw
      .prepare(
        `INSERT INTO integration_field_challenges (id, integration_id, field, current_value, proposed_value, reason, submitter_vendor_id, routed_to, owner_vendor_id, status, created_at, updated_at)
         VALUES (?, 'i-powered', 'name', NULL, 'x', 'r', ?, 'owner', ?, 'open', ?, ?)`,
      )
      .run(contestId, VENDOR_B_ID, VENDOR_ID, OLD_TS, OLD_TS);
  });

  it('deleted subscription ends the last license and moves contests', async () => {
    const s = senders();
    const queue = { sendBatch: vi.fn(async () => {}) };
    const result = await runStripeSubscriptionSync(
      ctx({ CACHE_PURGE_QUEUE: queue as unknown as Env['CACHE_PURGE_QUEUE'] }),
      t.db,
      subscription({ status: 'canceled', quantity: 1 }),
      {
        source: 'stripe-webhook',
        now: NOW,
        fetchSeatEmails: seatEmails,
        sendEnded: s.sendEnded,
        sendGranted: s.sendGranted,
      },
    );
    await Promise.all(pending);

    expect(await licenseOf('l-1')).toMatchObject({
      endReason: 'lapsed',
      endedAt: NOW.toISOString(),
      assignedProductId: 'p-1',
    });
    expect((await vendorOf()).verified).toBe(false);
    expect(result.reroutedContests).toBe(1);
    const [contest] = await t.db
      .select({ routedTo: integrationFieldChallenges.routedTo })
      .from(integrationFieldChallenges)
      .where(eq(integrationFieldChallenges.id, contestId));
    expect(contest!.routedTo).toBe('aeci');
    const actions = (await t.db.select().from(auditLog)).map((a) => a.action).sort();
    expect(actions).toEqual(['integration.contest.rerouted', 'license.lapsed']);
    expect(s.ended.map((e) => e.cause)).toEqual(['lapsed', 'lapsed']);
    const tags = (
      queue.sendBatch.mock.calls[0] as unknown as [{ body: { tags: string[] } }[]]
    )[0][0]!.body.tags;
    expect(tags).toEqual(
      expect.arrayContaining(['product:acme-one', 'index:products', 'vendor:acme']),
    );
  });

  it('a second run on the dead subscription changes nothing', async () => {
    await run(subscription({ status: 'canceled', quantity: 1 }));
    const again = await run(subscription({ status: 'canceled', quantity: 1 }));
    expect(again.outcome).toBe('no_change');
  });
});

describe("the ban's cancel (AECI-1589)", () => {
  function fakeStripe(sub: StripeSubscription, cancel: 'ok' | 'fail' = 'ok') {
    const cancels: string[] = [];
    let current = sub;
    const client = {
      retrieveSubscription: vi.fn(async () => ({ ok: true as const, data: current })),
      cancelSubscriptionNow: vi.fn(async (id: string) => {
        cancels.push(id);
        if (cancel === 'fail') {
          return { ok: false as const, status: 0, reason: 'network' as const, message: 'down' };
        }
        current = { ...current, status: 'canceled' };
        return { ok: true as const, data: current };
      }),
      updateSubscription: vi.fn(),
    } as unknown as StripeClient & { updateSubscription: ReturnType<typeof vi.fn> };
    return { client, cancels };
  }

  it('cancels a live subscription now, and never updates it', async () => {
    const { client, cancels } = fakeStripe(subscription());
    const out = await stripeBanCancelNowHook(ctx(), client, {
      vendorId: VENDOR_ID,
      subscriptions: [{ id: SUB, status: 'active' }],
    });
    expect(out).toEqual(['cancelled']);
    expect(cancels).toEqual([SUB]);
    expect(client.updateSubscription).not.toHaveBeenCalled();
  });

  it.each<StripeSubscriptionStatus>(['canceled', 'incomplete_expired'])(
    'skips a subscription whose pre-read status is terminal (%s)',
    async (status) => {
      const { client, cancels } = fakeStripe(subscription({ status }));
      const out = await stripeBanCancelNowHook(ctx(), client, {
        vendorId: VENDOR_ID,
        subscriptions: [{ id: SUB, status }],
      });
      expect(out).toEqual(['unchanged']);
      expect(cancels).toEqual([]);
    },
  );

  // Stripe can still collect on these through the hosted invoice, so the ban cancels them.
  it.each<StripeSubscriptionStatus>(['unpaid', 'paused', 'incomplete', 'past_due', 'trialing'])(
    'cancels a subscription whose pre-read status Stripe can still bill (%s)',
    async (status) => {
      const { client, cancels } = fakeStripe(subscription({ status }));
      const out = await stripeBanCancelNowHook(ctx(), client, {
        vendorId: VENDOR_ID,
        subscriptions: [{ id: SUB, status }],
      });
      expect(out).toEqual(['cancelled']);
      expect(cancels).toEqual([SUB]);
    },
  );

  it('re-reads a subscription the pre-read missed', async () => {
    const { client, cancels } = fakeStripe(subscription({ status: 'canceled' }));
    expect(
      await stripeBanCancelNowHook(ctx(), client, {
        vendorId: VENDOR_ID,
        subscriptions: [{ id: SUB }],
      }),
    ).toEqual(['unchanged']);
    expect(cancels).toEqual([]);
  });

  it('a refusal on a subscription canceled by then counts as done', async () => {
    const client = {
      cancelSubscriptionNow: vi.fn(async () => ({
        ok: false as const,
        status: 400,
        reason: 'http_error' as const,
        message: 'already canceled',
      })),
      retrieveSubscription: vi.fn(async () => ({
        ok: true as const,
        data: subscription({ status: 'canceled' }),
      })),
    } as unknown as StripeClient;
    expect(
      await stripeBanCancelNowHook(ctx(), client, {
        vendorId: VENDOR_ID,
        subscriptions: [{ id: SUB, status: 'active' }],
      }),
    ).toEqual(['unchanged']);
  });

  it('a failure, or no client, warns and never throws', async () => {
    const { client } = fakeStripe(subscription(), 'fail');
    expect(
      await stripeBanCancelNowHook(ctx(), client, {
        vendorId: VENDOR_ID,
        subscriptions: [{ id: SUB, status: 'active' }],
      }),
    ).toEqual(['failed']);
    expect(
      await stripeBanCancelNowHook(ctx(), null, {
        vendorId: VENDOR_ID,
        subscriptions: [{ id: SUB, status: 'active' }],
      }),
    ).toEqual(['failed']);
  });

  describe('a ban-dead subscription', () => {
    beforeEach(async () => {
      await seedLicense('l-1', {
        assignedProductId: 'p-1',
        assignedAt: OLD_TS,
        endedAt: OLD_TS,
        endReason: 'banned',
      });
    });

    it('a live sync grants nothing and cancels it now', async () => {
      const { client, cancels } = fakeStripe(subscription({ quantity: 1 }));
      const s = senders();
      const result = await run(subscription({ quantity: 1 }), { stripe: client }, s);
      expect(result.outcome).toBe('ban-dead');
      expect(cancels).toEqual([SUB]);
      expect(await allLicenses()).toHaveLength(1);
      expect(s.granted).toEqual([]);
      expect(await t.db.select().from(auditLog)).toEqual([]);
    });

    it('commits only the prefix', async () => {
      const { client } = fakeStripe(subscription({ quantity: 1 }));
      const outcomes: string[] = [];
      await run(subscription({ quantity: 1 }), {
        stripe: client,
        prefix: (p) => {
          outcomes.push(p.outcome);
          return { stmts: [], audits: [] };
        },
      });
      expect(outcomes).toEqual(['ban-dead']);
    });

    it('throws when the cancel fails or there is no client, so the caller retries', async () => {
      const { client } = fakeStripe(subscription({ quantity: 1 }), 'fail');
      await expect(run(subscription({ quantity: 1 }), { stripe: client })).rejects.toThrow(
        /ban-dead/,
      );
      await expect(run(subscription({ quantity: 1 }))).rejects.toThrow(/ban-dead/);
      expect(await allLicenses()).toHaveLength(1);
    });

    // The webhook answers `StripeTransientError` with 503, so Stripe retries.
    it('throws StripeTransientError on a failed cancel', async () => {
      const { client } = fakeStripe(subscription({ quantity: 1 }), 'fail');
      const failed = await run(subscription({ quantity: 1 }), { stripe: client }).catch(
        (e: unknown) => e,
      );
      expect(failed).toBeInstanceOf(StripeTransientError);
      expect((failed as StripeTransientError).reason).toBe('ban_dead_cancel_failed');
      const unconfigured = await run(subscription({ quantity: 1 })).catch((e: unknown) => e);
      expect(unconfigured).toBeInstanceOf(StripeTransientError);
      expect((unconfigured as StripeTransientError).reason).toBe('stripe_unconfigured');
    });

    it.each<StripeSubscriptionStatus>(['unpaid', 'paused', 'incomplete'])(
      'a sync of a %s subscription cancels it too',
      async (status) => {
        const sub = subscription({ status, quantity: 1 });
        const { client, cancels } = fakeStripe(sub);
        const result = await run(sub, { stripe: client });
        expect(result.outcome).toBe('ban-dead');
        expect(cancels).toEqual([SUB]);
        expect(await allLicenses()).toHaveLength(1);
      },
    );

    it('a canceled subscription after the ban changes nothing', async () => {
      const s = senders();
      const result = await run(subscription({ status: 'canceled', quantity: 1 }), {}, s);
      expect(result.outcome).toBe('no_change');
      expect(s.ended).toEqual([]);
    });
  });

  // A sync that read before the ban plans only INSERTs. The ban commits in between (here,
  // inside the prefix callback, which runs after the plan and before the batch).
  it('a ban that commits between the read and the batch aborts the grant and re-plans to ban-dead', async () => {
    await seedLicense('l-1', { assignedProductId: 'p-1', assignedAt: OLD_TS });
    const sub = subscription({ quantity: 2 });
    const { client, cancels } = fakeStripe(sub);
    const s = senders();
    const outcomes: string[] = [];
    const result = await run(
      sub,
      {
        stripe: client,
        prefix: async (p) => {
          outcomes.push(p.outcome);
          if (outcomes.length === 1) {
            await t.db
              .update(licenses)
              .set({ endedAt: NOW.toISOString(), endReason: 'banned' })
              .where(eq(licenses.id, 'l-1'));
          }
          return { stmts: [], audits: [] };
        },
      },
      s,
    );
    expect(outcomes).toEqual(['synced', 'ban-dead']);
    expect(result.outcome).toBe('ban-dead');
    expect(cancels).toEqual([SUB]);
    const rows = await allLicenses();
    expect(rows).toHaveLength(1);
    expect(rows.filter((l) => l.endedAt === null)).toEqual([]);
    expect(s.granted).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });
});

// AECI-1589 review: ban-dead is the vendor's seat state, not only a `banned` row.
describe('a fully banned vendor (AECI-1589)', () => {
  function cancelOnly() {
    const cancels: string[] = [];
    const client = {
      retrieveSubscription: vi.fn(),
      cancelSubscriptionNow: vi.fn(async (id: string) => {
        cancels.push(id);
        return { ok: true as const, data: subscription({ status: 'canceled' }) };
      }),
    } as unknown as StripeClient;
    return { client, cancels };
  }
  const banSeat = () =>
    t.db
      .update(profiles)
      .set({ bannedAt: '2026-10-27T00:00:00.000Z', banReason: 'abuse' })
      .where(eq(profiles.id, SEAT_ID));

  it('an unpaid subscription whose licenses lapsed before the ban is cancelled, nothing granted', async () => {
    await seedLicense('l-1', {
      assignedProductId: 'p-1',
      assignedAt: OLD_TS,
      endedAt: OLD_TS,
      endReason: 'lapsed',
    });
    await banSeat();
    const { client, cancels } = cancelOnly();
    const result = await run(subscription({ status: 'unpaid', quantity: 1 }), { stripe: client });
    expect(result.outcome).toBe('ban-dead');
    expect(cancels).toEqual([SUB]);
    expect(await allLicenses()).toHaveLength(1);
  });

  it.each<StripeSubscriptionStatus>(['incomplete', 'active'])(
    'a %s subscription with no license yet is cancelled, nothing granted',
    async (status) => {
      await banSeat();
      const { client, cancels } = cancelOnly();
      const s = senders();
      const result = await run(subscription({ status, quantity: 2 }), { stripe: client }, s);
      expect(result.outcome).toBe('ban-dead');
      expect(cancels).toEqual([SUB]);
      expect(await allLicenses()).toEqual([]);
      expect(s.granted).toEqual([]);
    },
  );

  it('a vendor with an unbanned seat, or with no seat at all, still syncs', async () => {
    const { client, cancels } = cancelOnly();
    expect((await run(subscription({ quantity: 1 }), { stripe: client })).outcome).toBe('synced');
    await t.db.delete(profiles).where(eq(profiles.id, SEAT_ID));
    expect((await run(subscription({ quantity: 2 }), { stripe: client })).outcome).toBe('synced');
    expect(cancels).toEqual([]);
  });

  // A ban with no license on this subscription writes no `banned` row the
  // banned-subscription sentinel could see. The seat sentinel aborts the grant.
  it('a ban of the last seat between the read and the batch aborts the grant and re-plans to ban-dead', async () => {
    const { client, cancels } = cancelOnly();
    const outcomes: string[] = [];
    const s = senders();
    const result = await run(
      subscription({ quantity: 2 }),
      {
        stripe: client,
        prefix: async (p) => {
          outcomes.push(p.outcome);
          if (outcomes.length === 1) await banSeat();
          return { stmts: [], audits: [] };
        },
      },
      s,
    );
    expect(outcomes).toEqual(['synced', 'ban-dead']);
    expect(result.outcome).toBe('ban-dead');
    expect(cancels).toEqual([SUB]);
    expect(await allLicenses()).toEqual([]);
    expect(s.granted).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });
});

describe("the ban's Stripe pass over the vendor's customers (AECI-1589)", () => {
  type Sub = { id: string; status: StripeSubscriptionStatus };
  function customerStripe(
    listed: Sub[],
    sessions: string[],
    over: { listFails?: boolean; expireFails?: boolean } = {},
  ) {
    const cancels: string[] = [];
    const expired: { id: string; key: string }[] = [];
    const client = {
      retrieveSubscription: vi.fn(async (id: string) => ({
        ok: true as const,
        data: subscription({ id, status: listed.find((l) => l.id === id)?.status ?? 'active' }),
      })),
      cancelSubscriptionNow: vi.fn(async (id: string) => {
        cancels.push(id);
        return { ok: true as const, data: subscription({ id, status: 'canceled' }) };
      }),
      listSubscriptions: vi.fn(async () =>
        over.listFails
          ? { ok: false as const, status: 0, reason: 'network' as const, message: 'down' }
          : {
              ok: true as const,
              data: {
                subscriptions: listed.map((l) => subscription({ id: l.id, status: l.status })),
                truncated: false,
              },
            },
      ),
      listOpenCheckoutSessions: vi.fn(async () => ({
        ok: true as const,
        data: sessions.map((id) => ({ id })),
      })),
      expireCheckoutSession: vi.fn(async (id: string, key: string) => {
        expired.push({ id, key });
        return over.expireFails
          ? { ok: false as const, status: 500, reason: 'http_error' as const, message: 'no' }
          : { ok: true as const, data: { id } };
      }),
    } as unknown as StripeClient & {
      listSubscriptions: ReturnType<typeof vi.fn>;
    };
    return { client, cancels, expired };
  }

  it('cancels every cancellable subscription on the customer, live license or not', async () => {
    const { client, cancels } = customerStripe(
      [
        { id: SUB, status: 'active' },
        { id: 'sub_unpaid', status: 'unpaid' },
        { id: 'sub_incomplete', status: 'incomplete' },
        { id: 'sub_gone', status: 'incomplete_expired' },
      ],
      [],
    );
    const out = await stripeBanCancelNowHook(ctx(), client, {
      vendorId: VENDOR_ID,
      subscriptions: [{ id: SUB, status: 'active' }],
      customerIds: ['cus_1'],
    });
    expect(client.listSubscriptions).toHaveBeenCalledWith({ customer: 'cus_1', maxPages: 1 });
    // The pre-read one once, then the listed ones; the terminal one is left out.
    expect(cancels).toEqual([SUB, 'sub_unpaid', 'sub_incomplete']);
    expect(out).toEqual(['cancelled', 'cancelled', 'cancelled']);
  });

  it("expires the customer's open Checkout sessions", async () => {
    const { client, expired } = customerStripe([], ['cs_1', 'cs_2']);
    const out = await stripeBanCancelNowHook(ctx(), client, {
      vendorId: VENDOR_ID,
      subscriptions: [],
      customerIds: ['cus_1'],
    });
    expect(out).toEqual([]);
    expect(expired).toEqual([
      { id: 'cs_1', key: 'aeci-ban-expire-cs_1' },
      { id: 'cs_2', key: 'aeci-ban-expire-cs_2' },
    ]);
  });

  it('a failed expiry or a failed list warns and never throws; the pre-read cancel still runs', async () => {
    const { client, cancels, expired } = customerStripe([], ['cs_1'], {
      listFails: true,
      expireFails: true,
    });
    const out = await stripeBanCancelNowHook(ctx(), client, {
      vendorId: VENDOR_ID,
      subscriptions: [{ id: SUB, status: 'active' }],
      customerIds: ['cus_1'],
    });
    expect(out).toEqual(['cancelled']);
    expect(cancels).toEqual([SUB]);
    expect(expired).toHaveLength(1);
  });

  describe('the deadline', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('a Stripe that never answers reports every unsettled subscription failed at the deadline', async () => {
      const client = {
        retrieveSubscription: vi.fn(() => new Promise(() => {})),
        cancelSubscriptionNow: vi.fn(() => new Promise(() => {})),
        listSubscriptions: vi.fn(() => new Promise(() => {})),
        listOpenCheckoutSessions: vi.fn(() => new Promise(() => {})),
        expireCheckoutSession: vi.fn(() => new Promise(() => {})),
      } as unknown as StripeClient;
      let settled: string[] | null = null;
      void stripeBanCancelNowHook(ctx(), client, {
        vendorId: VENDOR_ID,
        subscriptions: [{ id: SUB, status: 'active' }, { id: 'sub_2' }],
      }).then((out) => {
        settled = out;
      });
      await vi.advanceTimersByTimeAsync(BAN_CANCEL_DEADLINE_MS - 1);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toEqual(['failed', 'failed']);
      // Nothing starts after the deadline: the second subscription was never reached.
      expect(client.cancelSubscriptionNow).toHaveBeenCalledTimes(1);
    });
  });
});

describe('annualPeriodMovedForward (AECI-1503)', () => {
  const row = (over: Partial<LicenseBefore> = {}): LicenseBefore => ({
    id: 'l1',
    billingAccountId: 'ba',
    source: 'stripe',
    startsAt: '2026-01-01T00:00:00.000Z',
    endsAt: '2026-10-28T12:00:00.000Z',
    endedAt: null,
    endReason: null,
    reference: null,
    stripeSubscriptionId: 'sub_1',
    assignedProductId: null,
    assignedAt: null,
    releaseAtRenewal: false,
    cancelAtTermEnd: false,
    cancelReason: null,
    ...over,
  });
  const NEXT = '2027-10-28T12:00:00.000Z';

  it('is true when a live license on the subscription ends before the new period end', () => {
    expect(annualPeriodMovedForward('sub_1', NEXT, [row()])).toBe(true);
  });

  it('is false for the same period, a monthly subscription, another subscription or an ended row', () => {
    expect(annualPeriodMovedForward('sub_1', '2026-10-28T12:00:00.000Z', [row()])).toBe(false);
    expect(annualPeriodMovedForward('sub_1', null, [row({ endsAt: null })])).toBe(false);
    expect(annualPeriodMovedForward('sub_2', NEXT, [row()])).toBe(false);
    expect(
      annualPeriodMovedForward('sub_1', NEXT, [row({ endedAt: '2026-10-28T12:00:00.000Z' })]),
    ).toBe(false);
  });
});
