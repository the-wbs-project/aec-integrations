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
import type { StripeClient, StripeSubscription, StripeUpdateSubscriptionParams } from './stripe';
import {
  BAN_CANCEL_METADATA_KEY,
  runStripeSubscriptionSync,
  STRIPE_LICENSE_NAMESPACE,
  stripeBanCancelHook,
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

  it('leaves every flag alone while the ban hook owns the cancel', async () => {
    await run(
      subscription({
        quantity: 1,
        cancel_at_period_end: true,
        metadata: { ...subscription().metadata, [BAN_CANCEL_METADATA_KEY]: 'true' },
      }),
    );
    expect(await licenseOf('l-1')).toMatchObject({ cancelAtTermEnd: false, cancelReason: null });
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

describe('the ban hook (M1)', () => {
  function fakeStripe(sub: StripeSubscription) {
    const updates: { id: string; params: StripeUpdateSubscriptionParams; key: string }[] = [];
    const client = {
      retrieveSubscription: vi.fn(async () => ({ ok: true as const, data: sub })),
      updateSubscription: vi.fn(
        async (id: string, params: StripeUpdateSubscriptionParams, key: string) => {
          updates.push({ id, params, key });
          return { ok: true as const, data: sub };
        },
      ),
    } as unknown as StripeClient;
    return { client, updates };
  }

  it('the ban sets cancel_at_period_end with the marker', async () => {
    const { client, updates } = fakeStripe(subscription());
    const out = await stripeBanCancelHook(ctx(), client, {
      vendorId: VENDOR_ID,
      subscriptionIds: [SUB],
      ban: true,
      now: NOW.toISOString(),
    });
    expect(out).toEqual(['set']);
    expect(updates[0]!.params).toEqual({
      cancel_at_period_end: true,
      metadata: { [BAN_CANCEL_METADATA_KEY]: 'true' },
    });
  });

  it("the ban leaves an owner's own cancel alone, and the unban cannot undo it", async () => {
    const owners = fakeStripe(subscription({ cancel_at_period_end: true }));
    expect(
      await stripeBanCancelHook(ctx(), owners.client, {
        vendorId: VENDOR_ID,
        subscriptionIds: [SUB],
        ban: true,
        now: NOW.toISOString(),
      }),
    ).toEqual(['unchanged']);
    expect(
      await stripeBanCancelHook(ctx(), owners.client, {
        vendorId: VENDOR_ID,
        subscriptionIds: [SUB],
        ban: false,
        now: NOW.toISOString(),
      }),
    ).toEqual(['unchanged']);
    expect(owners.updates).toHaveLength(0);
  });

  it('the unban clears only a cancel the ban marked', async () => {
    const marked = fakeStripe(
      subscription({
        cancel_at_period_end: true,
        metadata: { [BAN_CANCEL_METADATA_KEY]: 'true' },
      }),
    );
    const out = await stripeBanCancelHook(ctx(), marked.client, {
      vendorId: VENDOR_ID,
      subscriptionIds: [SUB],
      ban: false,
      now: NOW.toISOString(),
    });
    expect(out).toEqual(['cleared']);
    expect(marked.updates[0]!.params).toEqual({
      cancel_at_period_end: false,
      metadata: { [BAN_CANCEL_METADATA_KEY]: '' },
    });
  });

  it('a Stripe failure warns and never throws', async () => {
    const client = {
      retrieveSubscription: vi.fn(async () => ({
        ok: false as const,
        status: 0,
        reason: 'timeout' as const,
        message: 'timed out',
      })),
    } as unknown as StripeClient;
    expect(
      await stripeBanCancelHook(ctx(), client, {
        vendorId: VENDOR_ID,
        subscriptionIds: [SUB],
        ban: true,
        now: NOW.toISOString(),
      }),
    ).toEqual(['failed']);
  });
});
