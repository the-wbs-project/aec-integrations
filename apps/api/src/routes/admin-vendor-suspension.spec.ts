/**
 * Suspend, then terminate (AECI-1623), against the in-memory D1 harness.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  billingAccounts,
  licenses,
  productVendors,
  products,
  profiles,
  vendorAbuseCostEntries,
  vendorSeatInvites,
  vendorSuspensions,
  vendorTerminationRefunds,
  vendors,
  workflowInstances,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { StripeClient } from '../lib/stripe';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { seedLicense } from '../test/licenses';
import {
  createAddAbuseCostEntryHandler,
  createLiftVendorSuspensionHandler,
  createResendSuspensionNoticeHandler,
  createRetryTerminationRefundsHandler,
  createStartSuspensionStage2Handler,
  createSuspendVendorHandler,
  createTerminateVendorHandler,
  createVendorSuspensionStateHandler,
  createVoidAbuseCostEntryHandler,
} from './admin-vendor-suspension';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const VENDOR = u(600);
const OWNER = u(601);
const MEMBER = u(602);
const P1 = u(610);
const OWNED_AT = '2026-05-01T00:00:00.000Z';
const SUB = 'sub_annual';
const SUSPEND = {
  kind: 'breach',
  rule: 'Truthfulness, Vendor Terms',
  evidence: 'The price edit of 2026-11-01.',
  reason: 'Internal: reported by a competitor.',
};

// A notice sent on 2026-08-03 (a Monday) has its 7th business day on 2026-08-12, so its
// window has fully passed at 2026-08-13T05:00Z.
const NOTICE_AT = '2026-08-03T17:00:00.000Z';
const WINDOW_END = '2026-08-13T05:00:00.000Z';
const SUSPENDED_AT = '2026-02-01T09:30:00.000Z';

let t: TestDb;
const SEAT_EMAILS = new Map([
  [OWNER, 'owner@bentley.example'],
  [MEMBER, 'member@bentley.example'],
]);
const fetchEmails = async (_env: unknown, ids: readonly string[]) =>
  new Map(ids.flatMap((i) => (SEAT_EMAILS.has(i) ? [[i, SEAT_EMAILS.get(i)!] as const] : [])));

type Sent = { to: string; stage?: number; dedupeKey?: string; refund?: string };

function fakeStripe(over: Partial<Record<keyof StripeClient, unknown>> = {}) {
  const refunds: { intent: string; amount: number; key: string }[] = [];
  const cancels: string[] = [];
  const order: string[] = [];
  const stripe = {
    retrieveSubscription: vi.fn(async () => ({
      ok: true,
      data: {
        id: SUB,
        status: 'active',
        customer: 'cus_1',
        cancel_at_period_end: false,
        metadata: {},
        items: { data: [] },
      },
    })),
    cancelSubscriptionNow: vi.fn(async (id: string) => {
      cancels.push(id);
      order.push('cancel');
      return { ok: true, data: { id, status: 'canceled' } };
    }),
    listSubscriptions: vi.fn(async () => ({ ok: true, data: { subscriptions: [] } })),
    listOpenCheckoutSessions: vi.fn(async () => ({ ok: true, data: [] })),
    expireCheckoutSession: vi.fn(),
    listPaidInvoices: vi.fn(async () => ({
      ok: true,
      data: [
        {
          id: 'in_1',
          customer: 'cus_1',
          billing_reason: 'subscription_create',
          currency: 'usd',
          parent: { subscription_details: { subscription: SUB } },
          lines: {
            has_more: false,
            data: [
              {
                amount: 25_000,
                period: {
                  start: Date.UTC(2026, 0, 1) / 1000,
                  end: Date.UTC(2027, 0, 1) / 1000,
                },
              },
            ],
          },
          payments: {
            has_more: false,
            data: [
              {
                status: 'paid',
                amount_paid: 25_000,
                payment: { type: 'payment_intent', payment_intent: 'pi_1' },
              },
            ],
          },
        },
      ],
    })),
    retrievePaymentIntent: vi.fn(async () => ({
      ok: true,
      data: { id: 'pi_1', latest_charge: { id: 'ch_1', amount_refunded: 0 } },
    })),
    createRefund: vi.fn(async (p: { payment_intent: string; amount: number }, key: string) => {
      refunds.push({ intent: p.payment_intent, amount: p.amount, key });
      order.push('refund');
      return { ok: true, data: { id: 're_1' } };
    }),
    ...over,
  };
  return { stripe: stripe as unknown as StripeClient, refunds, cancels, order };
}

/** The pre-cost refund of the fake annual at SUSPENDED_AT: 25000 x 334 / 365. */
const GROSS = 22_877;

function appFor(opts: {
  stripe?: StripeClient | null;
  noticeOutcome?: string;
  sent?: { notice: Sent[]; lifted: Sent[]; terminated: Sent[] };
}) {
  const sent = opts.sent ?? { notice: [], lifted: [], terminated: [] };
  const sendNotice = vi.fn(async (_c: unknown, o: Sent) => {
    sent.notice.push(o);
    return opts.noticeOutcome ?? 'sent';
  }) as never;
  const sendLifted = vi.fn(async (_c: unknown, o: Sent) => {
    sent.lifted.push(o);
    return 'sent';
  }) as never;
  const sendTerminated = vi.fn(async (_c: unknown, o: Sent) => {
    sent.terminated.push(o);
    return 'sent';
  }) as never;
  const stripeFor = () => (opts.stripe === undefined ? fakeStripe().stripe : opts.stripe);
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId: ADMIN,
      email: undefined,
      role: 'admin',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  const base = '/api/admin/vendors/:id';
  a.get(`${base}/suspension`, createVendorSuspensionStateHandler(t.factory, stripeFor));
  a.post(`${base}/suspend`, createSuspendVendorHandler(t.factory, fetchEmails, sendNotice));
  a.post(
    `${base}/suspension/resend-notice`,
    createResendSuspensionNoticeHandler(t.factory, fetchEmails, sendNotice),
  );
  a.post(
    `${base}/suspension/stage-2`,
    createStartSuspensionStage2Handler(t.factory, fetchEmails, sendNotice),
  );
  a.post(`${base}/suspension/cost-log`, createAddAbuseCostEntryHandler(t.factory));
  a.post(`${base}/suspension/cost-log/:entryId/void`, createVoidAbuseCostEntryHandler(t.factory));
  a.post(
    `${base}/suspension/lift`,
    createLiftVendorSuspensionHandler(t.factory, fetchEmails, sendLifted),
  );
  a.post(
    `${base}/suspension/terminate`,
    createTerminateVendorHandler(t.factory, stripeFor, fetchEmails, sendTerminated),
  );
  a.post(
    `${base}/suspension/refunds/retry`,
    createRetryTerminationRefundsHandler(t.factory, stripeFor, fetchEmails, sendTerminated),
  );
  return { a, sent };
}

async function call(
  path: string,
  body: unknown,
  opts: Parameters<typeof appFor>[0] = {},
  method = 'POST',
) {
  const { a, sent } = appFor(opts);
  const purge = { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) };
  const ownership = { send: vi.fn(async () => {}), sendBatch: vi.fn(async () => {}) };
  const ctx = fakeExecutionContext();
  const res = await a.request(
    `/api/admin/vendors/${VENDOR}/${path}`,
    {
      method,
      ...(method === 'POST'
        ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : {}),
    },
    {
      ...TEST_ENV,
      CACHE_PURGE_QUEUE: purge as unknown as Env['CACHE_PURGE_QUEUE'],
      OWNERSHIP_SYNC_QUEUE: ownership as unknown as Env['OWNERSHIP_SYNC_QUEUE'],
    },
    ctx,
  );
  await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map(([p]) => p));
  const json = (await res.json().catch(() => null)) as {
    error?: { code?: string };
    suspension?: {
      id: string;
      window_ends_at: string | null;
      stage_2_ends_at: string | null;
      can_terminate: boolean;
      can_start_stage_2: boolean;
      statement: { refund_cents: number; cost_applied_cents: number } | null;
      cost_log: { id: string; cents: number; logged_at: string }[];
      refunds: { status: string; refund_cents: number }[];
    };
    notice_sent?: boolean;
    open?: { id: string } | null;
    preview?: { available: boolean; gross_cents: number; cost_total_cents: number } | null;
  } | null;
  return { res, json, sent, purge, ownership };
}

const audits = () => t.db.select().from(auditLog);
const openRow = async () => (await t.db.select().from(vendorSuspensions))[0]!;

async function seedOpen(
  over: Partial<typeof vendorSuspensions.$inferInsert> = {},
): Promise<string> {
  const id = u(700);
  await t.db.insert(vendorSuspensions).values({
    id,
    vendorId: VENDOR,
    kind: 'breach',
    rule: SUSPEND.rule,
    evidence: SUSPEND.evidence,
    reason: SUSPEND.reason,
    suspendedAt: SUSPENDED_AT,
    suspendedBy: ADMIN,
    noticeSentAt: NOTICE_AT,
    ...over,
  });
  return id;
}

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values({
    id: VENDOR,
    slug: 'bentley',
    companyName: 'Bentley',
    verified: true,
    maintainedBy: 'vendor',
    ownedAt: OWNED_AT,
  });
  await t.db
    .insert(products)
    .values({ id: P1, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' });
  await t.db.insert(productVendors).values({ productId: P1, vendorId: VENDOR, isPrimary: true });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR },
  ]);
  const license = await seedLicense(t.db, VENDOR, {
    productId: P1,
    source: 'stripe',
    endsAt: '2027-01-01T00:00:00.000Z',
  });
  await t.db.update(licenses).set({ stripeSubscriptionId: SUB }).where(eq(licenses.id, license));
  await t.db
    .update(billingAccounts)
    .set({ billingEmail: 'billing@bentley.example', stripeCustomerId: 'cus_1' })
    .where(eq(billingAccounts.vendorId, VENDOR));
});
afterEach(() => {
  vi.useRealTimers();
  t.dispose();
});

describe('POST /suspend', () => {
  it('locks in one audited write, leaves billing alone, and starts the clock on a confirmed send', async () => {
    const { res, json, sent, purge } = await call('suspend', SUSPEND);
    expect(res.status).toBe(200);
    expect(json!.notice_sent).toBe(true);

    const row = await openRow();
    expect(row.suspendedBy).toBe(ADMIN);
    expect(row.noticeSentAt).not.toBeNull();
    expect(json!.suspension!.window_ends_at).not.toBeNull();

    const actions = (await audits()).map((a) => a.action);
    expect(actions).toContain('vendor.suspended');
    expect(actions).toContain('vendor.suspension_notice_sent');
    expect(actions).not.toContain('license.banned');

    // Subscriptions, ownership and the seats are untouched, and no public page changed.
    const live = (await t.db.select().from(licenses)).filter((l) => l.endedAt === null);
    expect(live).toHaveLength(1);
    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(vendor!.ownedAt).toBe(OWNED_AT);
    const seats = await t.db.select().from(profiles).where(eq(profiles.vendorId, VENDOR));
    expect(seats.every((s) => s.bannedAt === null)).toBe(true);
    expect(purge.send).not.toHaveBeenCalled();

    // To owner seats and the billing email only, one per address.
    expect(sent.notice.map((s) => s.to).sort()).toEqual([
      'billing@bentley.example',
      'owner@bentley.example',
    ]);
    expect(sent.notice[0]!.stage).toBe(1);
  });

  it('stays suspended with no clock when the send fails, and a resend starts it', async () => {
    const failed = await call('suspend', SUSPEND, { noticeOutcome: 'failed' });
    expect(failed.res.status).toBe(200);
    expect(failed.json!.notice_sent).toBe(false);
    expect(failed.json!.suspension!.window_ends_at).toBeNull();
    expect((await openRow()).noticeSentAt).toBeNull();
    expect((await audits()).map((a) => a.action)).not.toContain('vendor.suspension_notice_sent');

    const resent = await call('suspension/resend-notice', {});
    expect(resent.json!.notice_sent).toBe(true);
    expect((await openRow()).noticeSentAt).not.toBeNull();
  });

  it.each(['unknown', 'duplicate'])('a %s send starts no clock', async (noticeOutcome) => {
    const { json } = await call('suspend', SUSPEND, { noticeOutcome });
    expect(json!.notice_sent).toBe(false);
    expect((await openRow()).noticeSentAt).toBeNull();
  });

  it('a resend before any confirmed send uses a new key, so a timed-out send cannot wedge it', async () => {
    const first = await call('suspend', SUSPEND, { noticeOutcome: 'unknown' });
    const resent = await call('suspension/resend-notice', {});
    expect(resent.json!.notice_sent).toBe(true);
    const keys = new Set([...first.sent.notice, ...resent.sent.notice].map((s) => s.dedupeKey));
    expect(keys.size).toBe(first.sent.notice.length + resent.sent.notice.length);
  });

  it('a later resend does not move a clock already started', async () => {
    await seedOpen();
    await call('suspension/resend-notice', {});
    expect((await openRow()).noticeSentAt).toBe(NOTICE_AT);
  });

  it('refuses a second open suspension', async () => {
    await seedOpen();
    const { res, json } = await call('suspend', SUSPEND);
    expect(res.status).toBe(409);
    expect(json!.error!.code).toBe('VENDOR_SUSPENSION_STATE');
  });

  it('never sends the internal reason', async () => {
    const { sent } = await call('suspend', SUSPEND);
    expect(JSON.stringify(sent.notice)).not.toContain('Internal: reported');
  });
});

describe('POST /suspension/lift', () => {
  it('closes the suspension and tells the owner seats and billing', async () => {
    await seedOpen();
    const { res, json, sent } = await call('suspension/lift', { reason: 'Cured.' });
    expect(res.status).toBe(200);
    const row = await openRow();
    expect(row.resolution).toBe('lifted');
    expect(row.resolutionReason).toBe('Cured.');
    expect((await audits()).map((a) => a.action)).toContain('vendor.suspension_lifted');
    expect(json!.suspension!.can_terminate).toBe(false);
    expect(sent.lifted.map((s) => s.to).sort()).toEqual([
      'billing@bentley.example',
      'owner@bentley.example',
    ]);
  });

  it('409s with no open suspension', async () => {
    const { res } = await call('suspension/lift', { reason: 'Cured.' });
    expect(res.status).toBe(409);
  });
});

describe('the cost log', () => {
  it('stamps when it was logged, and the server decides the rate', async () => {
    await seedOpen();
    const { json } = await call('suspension/cost-log', {
      kind: 'staff',
      work_date: '2026-02-01',
      description: 'Review the edits',
      minutes: 90,
    });
    const [entry] = json!.suspension!.cost_log;
    expect(entry!.cents).toBe(22_500);
    expect(Date.now() - Date.parse(entry!.logged_at)).toBeLessThan(60_000);
    expect((await audits()).map((a) => a.action)).toContain('vendor.abuse_cost_logged');
  });

  it('refuses an entry dated in the future', async () => {
    await seedOpen();
    const { res } = await call('suspension/cost-log', {
      kind: 'staff',
      work_date: '2999-01-01',
      description: 'Review',
      minutes: 10,
    });
    expect(res.status).toBe(422);
  });

  it('voids an entry instead of deleting it', async () => {
    await seedOpen();
    const added = await call('suspension/cost-log', {
      kind: 'recovery',
      work_date: '2026-02-01',
      description: 'Chargeback won',
      amount_cents: 500,
    });
    const id = added.json!.suspension!.cost_log[0]!.id;
    expect(added.json!.suspension!.cost_log[0]!.cents).toBe(-500);
    await call(`suspension/cost-log/${id}/void`, { reason: 'Wrong vendor.' });
    const [row] = await t.db.select().from(vendorAbuseCostEntries);
    expect(row!.voidedAt).not.toBeNull();
    expect(row!.voidReason).toBe('Wrong vendor.');
  });
});

describe('POST /suspension/terminate: the window', () => {
  const TERMINATE = { manual_payments: [], expected_gross_cents: GROSS, expected_cost_cents: 0 };

  it('refuses with no confirmed notice, however long it has been', async () => {
    await seedOpen({ noticeSentAt: null });
    const { res, json } = await call('suspension/terminate', TERMINATE);
    expect(res.status).toBe(409);
    expect(json!.error!.code).toBe('VENDOR_SUSPENSION_WINDOW_OPEN');
  });

  it('refuses one minute before 7 business days have passed, and allows it after', async () => {
    await seedOpen();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(WINDOW_END) - 60_000);
    const early = await call('suspension/terminate', TERMINATE);
    expect(early.res.status).toBe(409);
    expect((await openRow()).resolution).toBeNull();

    vi.setSystemTime(Date.parse(WINDOW_END));
    const onTime = await call('suspension/terminate', TERMINATE);
    expect(onTime.res.status).toBe(200);
    expect((await openRow()).resolution).toBe('terminated');
  });

  it('counts business days: a federal holiday pushes the end out', async () => {
    // Sent Monday 2026-11-02: Wednesday the 11th is Veterans Day, so the 7th business day
    // is Thursday the 12th and the 12th itself is still inside the window.
    await seedOpen({ noticeSentAt: '2026-11-02T17:00:00.000Z' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-12T20:00:00.000Z'));
    expect((await call('suspension/terminate', TERMINATE)).res.status).toBe(409);
  });

  describe('the false-claim path', () => {
    it('refuses until stage 2 has run its own 7 business days', async () => {
      await seedOpen({ kind: 'false_claim' });
      vi.useFakeTimers({ toFake: ['Date'] });

      // Stage 1 cannot be skipped.
      vi.setSystemTime(Date.parse(WINDOW_END) - 60_000);
      const tooSoon = await call('suspension/stage-2', { finding: 'The domain is not theirs.' });
      expect(tooSoon.res.status).toBe(409);
      expect(tooSoon.json!.error!.code).toBe('VENDOR_SUSPENSION_WINDOW_OPEN');

      // Stage 1 has elapsed, but a false-claim suspension still needs stage 2.
      vi.setSystemTime(Date.parse(WINDOW_END));
      expect((await call('suspension/terminate', TERMINATE)).res.status).toBe(409);

      // Stage 2 sends its own notice on Thursday 2026-08-13 and its own clock starts.
      vi.setSystemTime(Date.parse('2026-08-13T17:00:00.000Z'));
      const started = await call('suspension/stage-2', { finding: 'The domain is not theirs.' });
      expect(started.res.status).toBe(200);
      expect(started.sent.notice.every((s) => s.stage === 2)).toBe(true);
      expect(started.json!.suspension!.stage_2_ends_at).toBe('2026-08-25T05:00:00.000Z');

      vi.setSystemTime(Date.parse('2026-08-25T04:59:00.000Z'));
      const early = await call('suspension/terminate', TERMINATE);
      expect(early.res.status).toBe(409);

      vi.setSystemTime(Date.parse('2026-08-25T05:00:00.000Z'));
      expect((await call('suspension/terminate', TERMINATE)).res.status).toBe(200);
    });

    it('a stage 2 notice that fails starts no clock', async () => {
      await seedOpen({ kind: 'false_claim' });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse(WINDOW_END));
      const started = await call(
        'suspension/stage-2',
        { finding: 'The domain is not theirs.' },
        { noticeOutcome: 'failed' },
      );
      expect(started.json!.notice_sent).toBe(false);
      expect(started.json!.suspension!.stage_2_ends_at).toBeNull();
      vi.setSystemTime(Date.parse('2027-01-01T00:00:00.000Z'));
      expect((await call('suspension/terminate', TERMINATE)).res.status).toBe(409);
    });

    it('a breach can become a false-claim finding after stage 1', async () => {
      await seedOpen();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse(WINDOW_END));
      await call('suspension/stage-2', { finding: 'The domain is not theirs.' });
      expect((await openRow()).kind).toBe('false_claim');
      expect((await call('suspension/terminate', TERMINATE)).res.status).toBe(409);
    });
  });
});

describe('POST /suspension/terminate: the work', () => {
  const TERMINATE = { manual_payments: [], expected_gross_cents: GROSS, expected_cost_cents: 0 };

  beforeEach(async () => {
    await seedOpen();
  });

  it('bans every seat, ends the subscriptions, returns the records, in one batch', async () => {
    const f = fakeStripe();
    const { res, purge, ownership } = await call('suspension/terminate', TERMINATE, {
      stripe: f.stripe,
    });
    expect(res.status).toBe(200);

    const seats = await t.db.select().from(profiles).where(eq(profiles.vendorId, VENDOR));
    expect(seats.every((s) => s.bannedAt !== null)).toBe(true);
    const flows = await t.db.select().from(workflowInstances);
    expect(flows.filter((w) => w.workflowType === 'reviewer_ban')).toHaveLength(2);

    const [license] = await t.db.select().from(licenses);
    expect(license!.endReason).toBe('banned');
    expect(license!.endedAt).not.toBeNull();

    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(vendor!.ownedAt).toBeNull();

    const actions = (await audits()).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'vendor.terminated',
        'vendor.records_returned',
        'license.banned',
        'vendor_admin.banned',
        'vendor.termination_refund_paid',
      ]),
    );
    const returned = (await audits()).find((a) => a.action === 'vendor.records_returned');
    expect(returned!.metadata).toMatchObject({ cause: 'vendor-terminated' });

    expect(f.cancels).toEqual([SUB]);
    expect(purge.send.mock.calls.length + purge.sendBatch.mock.calls.length).toBe(1);
    expect(ownership.send).toHaveBeenCalledTimes(1);
  });

  it('refunds the exact pro-rata amount, once, under the row id, after the cancel', async () => {
    const f = fakeStripe();
    await call('suspension/terminate', TERMINATE, { stripe: f.stripe });
    const [row] = await t.db.select().from(vendorTerminationRefunds);
    expect(f.refunds).toEqual([
      { intent: 'pi_1', amount: GROSS, key: `aeci-termination-refund-${row!.id}` },
    ]);
    expect(row!.status).toBe('succeeded');
    expect(row!.stripeRefundId).toBe('re_1');
    expect(f.order).toEqual(['cancel', 'refund']);
  });

  it('takes the logged cost off the refund, with recoveries credited', async () => {
    const id = u(700);
    await t.db.insert(vendorAbuseCostEntries).values([
      {
        suspensionId: id,
        kind: 'staff',
        workDate: '2026-02-01',
        description: 'Review the edits',
        minutes: 60,
        loggedAt: '2026-02-01T10:00:00.000Z',
        loggedBy: ADMIN,
      },
      {
        suspensionId: id,
        kind: 'recovery',
        workDate: '2026-02-02',
        description: 'Chargeback won',
        amountCents: 5_000,
        loggedAt: '2026-02-02T10:00:00.000Z',
        loggedBy: ADMIN,
      },
      {
        suspensionId: id,
        kind: 'staff',
        workDate: '2026-02-02',
        description: 'Voided entry',
        minutes: 600,
        loggedAt: '2026-02-02T11:00:00.000Z',
        loggedBy: ADMIN,
        voidedAt: '2026-02-02T12:00:00.000Z',
      },
    ]);
    const f = fakeStripe();
    const { json, sent } = await call(
      'suspension/terminate',
      { ...TERMINATE, expected_cost_cents: 10_000 },
      { stripe: f.stripe },
    );
    expect(f.refunds[0]!.amount).toBe(GROSS - 10_000);
    expect(json!.suspension!.statement!.cost_applied_cents).toBe(10_000);
    expect(sent.terminated[0]!.refund).toBe('paid');
  });

  it('never refunds a negative: a cost above the refund pays nothing and still states it', async () => {
    await t.db.insert(vendorAbuseCostEntries).values({
      suspensionId: u(700),
      kind: 'third_party',
      workDate: '2026-02-01',
      description: 'Claim from a third party',
      amountCents: 99_000,
      loggedAt: '2026-02-01T10:00:00.000Z',
      loggedBy: ADMIN,
    });
    const f = fakeStripe();
    const { json, sent } = await call(
      'suspension/terminate',
      { ...TERMINATE, expected_cost_cents: 99_000 },
      { stripe: f.stripe },
    );
    expect(f.refunds).toEqual([]);
    expect(json!.suspension!.statement!.refund_cents).toBe(0);
    expect(json!.suspension!.statement!.cost_applied_cents).toBe(GROSS);
    expect(await t.db.select().from(vendorTerminationRefunds)).toEqual([]);
    expect(sent.terminated.length).toBeGreaterThan(0);
  });

  it('prorates net of an earlier refund', async () => {
    const f = fakeStripe({
      retrievePaymentIntent: vi.fn(async () => ({
        ok: true,
        data: { id: 'pi_1', latest_charge: { id: 'ch_1', amount_refunded: 25_000 } },
      })),
    });
    const { json } = await call(
      'suspension/terminate',
      { ...TERMINATE, expected_gross_cents: 0 },
      { stripe: f.stripe },
    );
    expect(f.refunds).toEqual([]);
    expect(json!.suspension!.statement!.refund_cents).toBe(0);
  });

  it('writes nothing when Stripe cannot be read: the refund needs the amount', async () => {
    const f = fakeStripe({
      listPaidInvoices: vi.fn(async () => ({
        ok: false,
        status: 0,
        reason: 'timeout',
        message: 'timed out',
      })),
    });
    const { res, json } = await call('suspension/terminate', TERMINATE, { stripe: f.stripe });
    expect(res.status).toBe(503);
    expect(json!.error!.code).toBe('VENDOR_TERMINATION_STRIPE_UNAVAILABLE');
    expect((await openRow()).resolution).toBeNull();
    expect(f.cancels).toEqual([]);
    const seats = await t.db.select().from(profiles).where(eq(profiles.vendorId, VENDOR));
    expect(seats.every((s) => s.bannedAt === null)).toBe(true);
  });

  it('fails closed on a null Stripe client when the vendor has a Stripe customer', async () => {
    const { res } = await call('suspension/terminate', TERMINATE, { stripe: null });
    expect(res.status).toBe(503);
  });

  it('409s when the number the operator confirmed has changed', async () => {
    const { res, json } = await call(
      'suspension/terminate',
      { ...TERMINATE, expected_gross_cents: GROSS + 1 },
      { stripe: fakeStripe().stripe },
    );
    expect(res.status).toBe(409);
    expect(json!.error!.code).toBe('VENDOR_TERMINATION_REFUND_CHANGED');
    expect((await openRow()).resolution).toBeNull();
  });

  it('a refund that fails is recorded, the statement says so, and a retry pays it', async () => {
    const failing = fakeStripe({
      createRefund: vi.fn(async () => ({
        ok: false,
        status: 402,
        reason: 'http_error',
        message: 'no funds',
      })),
    });
    const first = await call('suspension/terminate', TERMINATE, { stripe: failing.stripe });
    expect(first.res.status).toBe(200);
    expect(first.sent.terminated[0]!.refund).toBe('pending');
    const [failed] = await t.db.select().from(vendorTerminationRefunds);
    expect(failed!.status).toBe('failed');
    expect((await audits()).map((a) => a.action)).toContain('vendor.termination_refund_failed');

    const f = fakeStripe();
    const retry = await call('suspension/refunds/retry', {}, { stripe: f.stripe });
    expect(retry.res.status).toBe(200);
    expect(f.refunds[0]!.key).toBe(`aeci-termination-refund-${failed!.id}`);
    expect(retry.sent.terminated[0]!.refund).toBe('paid');
    const [paid] = await t.db.select().from(vendorTerminationRefunds);
    expect(paid!.status).toBe('succeeded');
  });

  it('an invoice-paid subscription needs its amount typed, and the refund row is manual', async () => {
    const invoice = await seedLicense(t.db, VENDOR, {
      source: 'invoice',
      endsAt: '2027-01-01T00:00:00.000Z',
    });
    await t.db
      .update(licenses)
      .set({ startsAt: '2026-01-01T00:00:00.000Z' })
      .where(eq(licenses.id, invoice));
    const f = fakeStripe();
    const missing = await call('suspension/terminate', TERMINATE, { stripe: f.stripe });
    expect(missing.res.status).toBe(422);

    const { res, sent } = await call(
      'suspension/terminate',
      { ...TERMINATE, manual_payments: [{ license_id: invoice, paid_cents: 25_000 }] },
      { stripe: f.stripe },
    );
    expect(res.status).toBe(200);
    const rows = await t.db.select().from(vendorTerminationRefunds);
    expect(rows.map((r) => r.status).sort()).toEqual(['manual', 'succeeded']);
    expect(f.refunds).toHaveLength(1);
    expect(sent.terminated[0]!.refund).toBe('paid');
    expect((sent.terminated[0] as { manualRefundCents?: number }).manualRefundCents).toBe(
      rows.find((r) => r.status === 'manual')!.refundCents,
    );
  });

  it('revokes pending invites in the batch', async () => {
    await t.db.insert(vendorSeatInvites).values({
      id: u(800),
      vendorId: VENDOR,
      email: 'new@bentley.example',
      token: 'tok-1',
      invitedById: OWNER,
      expiresAt: '2999-01-01T00:00:00.000Z',
    });
    await call('suspension/terminate', TERMINATE, { stripe: fakeStripe().stripe });
    const [invite] = await t.db.select().from(vendorSeatInvites);
    expect(invite!.revokedAt).not.toBeNull();
  });

  it('a second terminate finds no open suspension', async () => {
    await call('suspension/terminate', TERMINATE, { stripe: fakeStripe().stripe });
    const again = await call('suspension/terminate', TERMINATE, { stripe: fakeStripe().stripe });
    expect(again.res.status).toBe(409);
    expect(again.json!.error!.code).toBe('VENDOR_SUSPENSION_STATE');
  });
});

describe('GET /suspension', () => {
  it('previews the refund and the log total', async () => {
    await seedOpen();
    await t.db.insert(vendorAbuseCostEntries).values({
      suspensionId: u(700),
      kind: 'staff',
      workDate: '2026-02-01',
      description: 'Review',
      minutes: 10,
      loggedAt: '2026-02-01T10:00:00.000Z',
      loggedBy: ADMIN,
    });
    const { json } = await call('suspension', null, { stripe: fakeStripe().stripe }, 'GET');
    expect(json!.open!.id).toBe(u(700));
    expect(json!.preview).toMatchObject({
      available: true,
      gross_cents: GROSS,
      cost_total_cents: 2_500,
    });
  });

  it('says the preview is unavailable when Stripe cannot be read', async () => {
    await seedOpen();
    const { json } = await call('suspension', null, { stripe: null }, 'GET');
    expect(json!.preview!.available).toBe(false);
  });

  it('has no preview with nothing open', async () => {
    const { json } = await call('suspension', null, {}, 'GET');
    expect(json!.open).toBeNull();
    expect(json!.preview).toBeNull();
  });
});
