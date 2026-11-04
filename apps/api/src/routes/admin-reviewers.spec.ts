/**
 * Reviewer ban-management API (AECI-218 / Phase 6.11) on the Drizzle/D1 path
 * (ADR 0016 / AECI-253), against the in-memory D1 harness.
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
  vendorSeatInvites,
  vendors,
  workflowInstances,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { StripeClient, StripeSubscription } from '../lib/stripe';
import { BAN_CANCEL_DEADLINE_MS } from '../lib/stripe-licenses';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { seedLicense } from '../test/licenses';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createBanReviewerHandler,
  createBannedReviewersListHandler,
  type SendVendorBanned,
} from './admin-reviewers';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

const emails = vi.fn(async () => new Map<string, string>());

function listApp() {
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
  a.get('/api/admin/reviewers', createBannedReviewersListHandler(t.factory, emails));
  return a;
}
function patchApp() {
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
  a.patch('/api/admin/reviewers/:id', createBanReviewerHandler(t.factory));
  return a;
}
const patch = (id: string, body: unknown) =>
  patchApp().request(
    `/api/admin/reviewers/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    TEST_ENV,
    fakeExecutionContext(),
  );

describe('PATCH /api/admin/reviewers/:id', () => {
  it('bans an active reviewer (sets banned_at, audits, opens the workflow)', async () => {
    await t.db.insert(profiles).values({ id: u(1) });
    const res = await patch(u(1), { action: 'ban', reason: 'Repeated spam reviews.' });
    expect(res.status).toBe(200);

    const [row] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, u(1)));
    expect(row!.bannedAt).not.toBeNull();
    expect(row!.banReason).toBe('Repeated spam reviews.');
    expect((await t.db.select().from(auditLog)).some((a) => a.action === 'reviewer.banned')).toBe(
      true,
    );
    const [wf] = await t.db.select().from(workflowInstances);
    expect(wf!.workflowType).toBe('reviewer_ban');
    expect(wf!.currentState).toBe('banned');
    expect(wf!.completedAt).toBeNull(); // reversible workflow
  });

  it('unbans a banned reviewer', async () => {
    await t.db
      .insert(profiles)
      .values({ id: u(1), bannedAt: '2026-01-01T00:00:00.000Z', banReason: 'x' });
    const res = await patch(u(1), { action: 'unban' });
    expect(res.status).toBe(200);
    const [row] = await t.db
      .select()
      .from(profiles)
      .where(eq(profiles.id, u(1)));
    expect(row!.bannedAt).toBeNull();
  });

  it('403s banning an admin or yourself', async () => {
    await t.db.insert(profiles).values({ id: u(2), role: 'admin' });
    expect((await patch(u(2), { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      403,
    );
    expect((await patch(ADMIN, { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      403,
    );
  });

  it('422s an already-banned reviewer', async () => {
    await t.db.insert(profiles).values({ id: u(1), bannedAt: '2026-01-01T00:00:00.000Z' });
    expect((await patch(u(1), { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      422,
    );
  });
});

// AECI-524 — the SAME endpoint bans a `vendor_admin` seat (the ban mechanism is
// role-agnostic; only the audit action + metric are role-aware). §7 of
// STAGE_2_VENDOR_PORTAL_SPEC.md: ban is per-seat and never touches
// `vendors.verified`; unban restores portal access without re-granting.
describe('PATCH /api/admin/reviewers/:id — vendor_admin seats (AECI-524)', () => {
  const VENDOR = u(500);
  const SEAT_A = u(501);
  const SEAT_B = u(502);

  beforeEach(async () => {
    await t.db
      .insert(vendors)
      .values({ id: VENDOR, slug: 'autodesk', companyName: 'Autodesk', verified: true });
  });

  it('bans a vendor_admin seat and audits it as vendor_admin.banned', async () => {
    await t.db.insert(profiles).values({ id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR });

    const res = await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' });
    expect(res.status).toBe(200);

    const [row] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(row!.bannedAt).not.toBeNull();
    expect(row!.banReason).toBe('Portal abuse');
    // The grant stays intact — a ban gates access, it does not un-grant the seat.
    expect(row!.role).toBe('vendor_admin');
    expect(row!.vendorId).toBe(VENDOR);

    const actions = (await t.db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toContain('vendor_admin.banned');
    expect(actions).not.toContain('reviewer.banned');

    const [wf] = await t.db.select().from(workflowInstances);
    expect(wf!.currentState).toBe('banned');
    expect(wf!.completedAt).toBeNull(); // reversible workflow
  });

  it('unbans a vendor_admin seat (restores access without re-grant)', async () => {
    await t.db.insert(profiles).values({
      id: SEAT_A,
      role: 'vendor_admin',
      vendorId: VENDOR,
      bannedAt: '2026-07-01T00:00:00.000Z',
      banReason: 'Portal abuse',
    });

    const res = await patch(SEAT_A, { action: 'unban' });
    expect(res.status).toBe(200);

    const [row] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(row!.bannedAt).toBeNull();
    // Unban never re-grants: the seat was and stays a linked vendor_admin.
    expect(row!.role).toBe('vendor_admin');
    expect(row!.vendorId).toBe(VENDOR);
    expect((await t.db.select().from(auditLog)).map((a) => a.action)).toContain(
      'vendor_admin.unbanned',
    );
  });

  it('is per-seat: banning one seat leaves the other seat and vendors.verified untouched', async () => {
    await t.db.insert(profiles).values([
      { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR },
      { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR },
    ]);

    expect((await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' })).status).toBe(200);

    const [a] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    const [b] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_B));
    expect(a!.bannedAt).not.toBeNull();
    expect(b!.bannedAt).toBeNull(); // the other seat is unaffected
    expect(b!.role).toBe('vendor_admin');

    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(vendor!.verified).toBe(true); // vendor-level entitlement is never touched by a ban

    const banRows = (await t.db.select().from(auditLog)).filter(
      (r) => r.action === 'vendor_admin.banned',
    );
    expect(banRows).toHaveLength(1);
    expect(banRows[0]!.entityId).toBe(SEAT_A);
  });
});

// AECI-1374 (E4.5, decision 15, ruled 2026-10-14): the ban of a vendor's LAST
// unbanned seat flags every live license cancel-at-term-end, reason `vendor-banned`,
// in the ban's own batch. Nothing ends. The unban clears only `vendor-banned` flags.
// AECI-1589 (ruled 2026-11-03): the ban of a vendor's last unbanned seat ends every
// license now, cancels Stripe at once and returns the records to AECi, in ONE batch.
describe('PATCH /api/admin/reviewers/:id: the last-seat ban ends everything (AECI-1589)', () => {
  const VENDOR = u(600);
  const SEAT_A = u(601);
  const SEAT_B = u(602);
  const P1 = u(610);
  const P2 = u(611);
  const ENDED_AT = '2026-06-01T00:00:00.000Z';
  const OWNED_AT = '2026-05-01T00:00:00.000Z';
  const ANNUAL_END = '2027-01-31T00:00:00.000Z';
  const SUB = 'sub_monthly';
  /** 2026-12-01T00:00:00Z in Unix seconds: the monthly row's paid-through date. */
  const PERIOD_END = Date.UTC(2026, 11, 1) / 1000;
  const PERIOD_END_ISO = '2026-12-01T00:00:00.000Z';

  let annual: string;
  let monthly: string;
  let unassigned: string;
  let ended: string;

  beforeEach(async () => {
    await t.db.insert(vendors).values({
      id: VENDOR,
      slug: 'bentley',
      companyName: 'Bentley',
      verified: true,
      maintainedBy: 'vendor',
      ownedAt: OWNED_AT,
    });
    await t.db.insert(products).values([
      { id: P1, slug: 'microstation', name: 'MicroStation', promotionStatus: 'promoted' },
      { id: P2, slug: 'openroads', name: 'OpenRoads', promotionStatus: 'promoted' },
    ]);
    await t.db.insert(productVendors).values([
      { productId: P1, vendorId: VENDOR, isPrimary: true },
      { productId: P2, vendorId: VENDOR, isPrimary: true },
    ]);
    await t.db.insert(profiles).values([
      { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
      // An earlier ban: SEAT_A is the last unbanned seat.
      {
        id: SEAT_B,
        role: 'vendor_admin',
        vendorId: VENDOR,
        bannedAt: '2026-09-01T00:00:00.000Z',
        banReason: 'earlier',
      },
    ]);
    annual = await seedLicense(t.db, VENDOR, { productId: P1, endsAt: ANNUAL_END });
    monthly = await seedLicense(t.db, VENDOR, { productId: P2, source: 'stripe' });
    await t.db.update(licenses).set({ stripeSubscriptionId: SUB }).where(eq(licenses.id, monthly));
    unassigned = await seedLicense(t.db, VENDOR, { source: 'invoice', endsAt: ANNUAL_END });
    ended = await seedLicense(t.db, VENDOR, { endedAt: ENDED_AT, endReason: 'lapsed' });
    await t.db
      .update(billingAccounts)
      .set({ billingEmail: 'A@bentley.example' })
      .where(eq(billingAccounts.vendorId, VENDOR));
  });

  type Purge = {
    send: ReturnType<typeof vi.fn<(m: unknown) => Promise<void>>>;
    sendBatch: ReturnType<typeof vi.fn<(m: { body: { tags: string[] } }[]) => Promise<void>>>;
  };
  type FakeStripe = StripeClient & {
    cancels: string[];
    updateSubscription: ReturnType<typeof vi.fn>;
  };
  function fakeStripe(
    status: StripeSubscription['status'] = 'active',
    reachable = true,
    cancelOk = true,
  ): FakeStripe {
    const cancels: string[] = [];
    const sub = {
      id: SUB,
      status,
      customer: 'cus_1',
      cancel_at_period_end: false,
      metadata: {},
      items: {
        data: [
          {
            id: 'si_1',
            quantity: 1,
            price: { id: 'price_m', recurring: { interval: 'month' } },
            current_period_end: PERIOD_END,
          },
        ],
      },
    } as StripeSubscription;
    return {
      cancels,
      retrieveSubscription: vi.fn(async () =>
        reachable
          ? { ok: true as const, data: sub }
          : { ok: false as const, status: 0, reason: 'timeout' as const, message: 'timed out' },
      ),
      cancelSubscriptionNow: vi.fn(async (id: string) => {
        cancels.push(id);
        if (!cancelOk) {
          return { ok: false as const, status: 0, reason: 'network' as const, message: 'down' };
        }
        return { ok: true as const, data: { ...sub, status: 'canceled' as const } };
      }),
      updateSubscription: vi.fn(),
    } as unknown as FakeStripe;
  }

  const SEAT_EMAILS = new Map([
    [SEAT_A, 'a@bentley.example'],
    [SEAT_B, 'b@bentley.example'],
  ]);

  async function act(
    id: string,
    body: unknown,
    opts: {
      stripe?: StripeClient | null;
      /** Sees the recorders before the request, for a spec that must not await it. */
      observe?: (o: { sentBanned: { subscriptionOutcomes: string[] }[]; purge: Purge }) => void;
    } = {},
  ) {
    const sentBanned: {
      to: string;
      products: string[];
      dedupeKey?: string;
      subscriptionOutcomes: string[];
      /** Cancels the fake Stripe had seen when this email went: the order check. */
      cancelsAtSend: number;
    }[] = [];
    const sendBanned = vi.fn(async (_c, o) => {
      sentBanned.push({
        to: o.to,
        products: o.products.map((p: { slug: string }) => p.slug),
        dedupeKey: o.dedupeKey,
        subscriptionOutcomes: [...o.subscriptionOutcomes],
        cancelsAtSend: (opts.stripe as FakeStripe | null | undefined)?.cancels?.length ?? -1,
      });
      return 'sent' as const;
    }) as unknown as SendVendorBanned;
    const purge: Purge = {
      send: vi.fn(async (_m: unknown) => {}),
      sendBatch: vi.fn(async (_m: { body: { tags: string[] } }[]) => {}),
    };
    opts.observe?.({ sentBanned, purge });
    const ownership = {
      send: vi.fn(async (_m: { reason: string; vendorId: string }) => {}),
      sendBatch: vi.fn(async (_m: unknown) => {}),
    };
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
    a.patch(
      '/api/admin/reviewers/:id',
      createBanReviewerHandler(
        t.factory,
        () => (opts.stripe === undefined ? fakeStripe() : opts.stripe),
        async (_env, ids) =>
          new Map(ids.flatMap((i) => (SEAT_EMAILS.has(i) ? [[i, SEAT_EMAILS.get(i)!]] : []))),
        sendBanned,
      ),
    );
    const ctx = fakeExecutionContext();
    const res = await a.request(
      `/api/admin/reviewers/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      },
      {
        ...TEST_ENV,
        CACHE_PURGE_QUEUE: purge as unknown as Env['CACHE_PURGE_QUEUE'],
        OWNERSHIP_SYNC_QUEUE: ownership as unknown as Env['OWNERSHIP_SYNC_QUEUE'],
      },
      ctx,
    );
    await Promise.all(vi.mocked(ctx.waitUntil).mock.calls.map(([p]) => p));
    const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    return { res, json, sentBanned, purge, ownership };
  }
  const BAN = { action: 'ban', reason: 'Portal abuse' };

  const licenseRows = async () => {
    const rows = await t.db.select().from(licenses);
    return new Map(rows.map((r) => [r.id, r]));
  };
  const audits = () => t.db.select().from(auditLog);
  const vendorRow = async () =>
    (await t.db.select().from(vendors).where(eq(vendors.id, VENDOR)))[0]!;

  it('ends every live license banned in ONE batch: annual keeps ends_at, monthly takes Stripe', async () => {
    const stripe = fakeStripe();
    const batch = vi.spyOn(t.db, 'batch');
    const { res } = await act(SEAT_A, BAN, { stripe });
    expect(res.status).toBe(200);
    expect(batch).toHaveBeenCalledTimes(1);

    const rows = await licenseRows();
    for (const id of [annual, monthly, unassigned]) {
      expect(rows.get(id)!.endReason).toBe('banned');
      expect(rows.get(id)!.endedAt).not.toBeNull();
    }
    expect(rows.get(annual)).toMatchObject({ endsAt: ANNUAL_END, assignedProductId: P1 });
    expect(rows.get(monthly)).toMatchObject({ endsAt: PERIOD_END_ISO, assignedProductId: P2 });
    expect(rows.get(ended)).toMatchObject({ endedAt: ENDED_AT, endReason: 'lapsed' });

    const v = await vendorRow();
    expect(v.verified).toBe(false);
    expect(v.ownedAt).toBeNull();
    expect(v.maintainedBy).toBe('aeci');

    const banned = (await audits()).filter((a) => a.action === 'license.banned');
    expect(banned).toHaveLength(3);
    const source = new Map(
      banned.map((a) => {
        const m = a.metadata as { license_id: string; paid_term_end_source: string };
        return [m.license_id, m.paid_term_end_source];
      }),
    );
    expect(source.get(annual)).toBe('ends_at');
    expect(source.get(monthly)).toBe('stripe');
    expect(banned[0]!.metadata).toMatchObject({ source: 'admin-moderation', seat_user_id: SEAT_A });
  });

  it('writes vendor.records_returned with the ban as its cause', async () => {
    await act(SEAT_A, BAN);
    const row = (await audits()).find((a) => a.action === 'vendor.records_returned');
    expect(row).toMatchObject({
      actorId: ADMIN,
      entityType: 'vendor',
      entityId: VENDOR,
      vendorId: VENDOR,
      beforeState: { owned_at: OWNED_AT },
      afterState: { owned_at: null },
    });
    expect(row!.metadata).toMatchObject({
      source: 'admin-moderation',
      cause: 'vendor-banned',
      seat_user_id: SEAT_A,
      product_count: 2,
      licenses_ended: 3,
      stripe_subscriptions: [SUB],
      proposals_discarded: 0,
    });
  });

  it('cancels each live subscription now, after commit, and never updates it', async () => {
    const stripe = fakeStripe() as FakeStripe;
    await act(SEAT_A, BAN, { stripe });
    expect(stripe.cancels).toEqual([SUB]);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('skips a subscription whose pre-read status is already canceled', async () => {
    const stripe = fakeStripe('canceled') as FakeStripe;
    expect((await act(SEAT_A, BAN, { stripe })).res.status).toBe(200);
    expect(stripe.cancels).toEqual([]);
    expect(stripe.updateSubscription).not.toHaveBeenCalled();
  });

  it('bans anyway when Stripe is unreachable: the monthly ends_at stays NULL, source unknown', async () => {
    const { res } = await act(SEAT_A, BAN, { stripe: fakeStripe('active', false) });
    expect(res.status).toBe(200);
    const rows = await licenseRows();
    expect(rows.get(monthly)).toMatchObject({ endReason: 'banned', endsAt: null });
    const row = (await audits()).find(
      (a) =>
        a.action === 'license.banned' &&
        (a.metadata as { license_id: string }).license_id === monthly,
    );
    expect(row!.metadata).toMatchObject({ paid_term_end_source: 'unknown' });
  });

  it('bans anyway with no Stripe client', async () => {
    const { res } = await act(SEAT_A, BAN, { stripe: null });
    expect(res.status).toBe(200);
    expect((await licenseRows()).get(monthly)).toMatchObject({ endReason: 'banned', endsAt: null });
  });

  it('sends one vendor-banned email per address, banned seats and the billing email included', async () => {
    const { sentBanned } = await act(SEAT_A, BAN);
    // SEAT_A and the billing email are one address; SEAT_B was banned before.
    expect(sentBanned.map((s) => s.to).sort()).toEqual(['a@bentley.example', 'b@bentley.example']);
    expect(sentBanned[0]!.products.sort()).toEqual(['microstation', 'openroads']);
    expect(sentBanned[0]!.dedupeKey).toMatch(new RegExp(`^vendor-banned:${VENDOR}:`));
  });

  // The email goes after the cancel, in one waitUntil chain, and states its real outcome.
  it('emails after the cancel, saying the subscription was cancelled', async () => {
    const stripe = fakeStripe() as FakeStripe;
    const { sentBanned } = await act(SEAT_A, BAN, { stripe });
    expect(sentBanned.length).toBeGreaterThan(0);
    for (const sent of sentBanned) {
      expect(sent.cancelsAtSend).toBe(1);
      expect(sent.subscriptionOutcomes).toEqual(['cancelled']);
    }
  });

  it('emails a failed cancel as failed, never as cancelled', async () => {
    const stripe = fakeStripe('active', true, false) as FakeStripe;
    const { res, sentBanned } = await act(SEAT_A, BAN, { stripe });
    expect(res.status).toBe(200);
    expect(stripe.cancels).toEqual([SUB]);
    expect(sentBanned.length).toBeGreaterThan(0);
    for (const sent of sentBanned) expect(sent.subscriptionOutcomes).toEqual(['failed']);
  });

  it('emails an already-ended subscription as unchanged', async () => {
    const canceled = await act(SEAT_A, BAN, { stripe: fakeStripe('canceled') });
    for (const sent of canceled.sentBanned)
      expect(sent.subscriptionOutcomes).toEqual(['unchanged']);
  });

  it('emails a ban with no Stripe client as a failed cancel', async () => {
    const { sentBanned } = await act(SEAT_A, BAN, { stripe: null });
    expect(sentBanned.length).toBeGreaterThan(0);
    for (const sent of sentBanned) expect(sent.subscriptionOutcomes).toEqual(['failed']);
  });

  it('enqueues ONE purge message and the ownership message', async () => {
    const { purge, ownership } = await act(SEAT_A, BAN);
    expect(purge.send).not.toHaveBeenCalled();
    expect(purge.sendBatch).toHaveBeenCalledTimes(1);
    const bodies = purge.sendBatch.mock.calls[0]![0];
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.body.tags).toEqual(
      expect.arrayContaining([
        'product:microstation',
        'product:openroads',
        'index:products',
        'vendor:bentley',
      ]),
    );
    const sent = ownership.send.mock.calls.map(([m]) => m);
    expect(sent).toEqual([expect.objectContaining({ reason: 'records_returned' })]);
  });

  // AECI-1589 review: the ban cancels every subscription on the vendor's Stripe
  // customer, not only the live licenses' ones, and expires its open Checkout pages.
  it("sweeps the billing account's Stripe customer: listed subscriptions and open Checkout sessions", async () => {
    await t.db
      .update(billingAccounts)
      .set({ stripeCustomerId: 'cus_1' })
      .where(eq(billingAccounts.vendorId, VENDOR));
    const stripe = fakeStripe() as FakeStripe;
    const unpaid = { id: 'sub_unpaid', status: 'unpaid' } as StripeSubscription;
    const listSubscriptions = vi.fn(async () => ({
      ok: true as const,
      data: { subscriptions: [{ id: SUB, status: 'active' }, unpaid], truncated: false },
    }));
    const expireCheckoutSession = vi.fn(async (sid: string) => ({
      ok: true as const,
      data: { id: sid },
    }));
    Object.assign(stripe, {
      listSubscriptions,
      listOpenCheckoutSessions: vi.fn(async () => ({ ok: true as const, data: [{ id: 'cs_1' }] })),
      expireCheckoutSession,
    });
    const { sentBanned } = await act(SEAT_A, BAN, { stripe });
    expect(listSubscriptions).toHaveBeenCalledWith({ customer: 'cus_1', maxPages: 1 });
    expect(stripe.cancels).toEqual([SUB, 'sub_unpaid']);
    expect(expireCheckoutSession).toHaveBeenCalledWith('cs_1', 'aeci-ban-expire-cs_1');
    for (const sent of sentBanned) {
      expect(sent.subscriptionOutcomes).toEqual(['cancelled', 'cancelled']);
    }
  });

  describe('a Stripe that never answers', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
    afterEach(() => vi.useRealTimers());

    // The cancel hangs. The purge must not wait for it, and the email goes at the
    // deadline saying the subscription will be cancelled within a day.
    it('still purges at once and emails "failed" within the deadline', async () => {
      const stripe = fakeStripe() as FakeStripe;
      stripe.cancelSubscriptionNow = vi.fn(() => new Promise(() => {})) as never;
      const box: {
        seen: { sentBanned: { subscriptionOutcomes: string[] }[]; purge: Purge } | null;
      } = { seen: null };
      let finished = false;
      const done = act(SEAT_A, BAN, { stripe, observe: (o) => (box.seen = o) }).then((r) => {
        finished = true;
        return r;
      });
      let elapsed = 0;
      let purgedAt: number | null = null;
      let emailedAt: number | null = null;
      while (!finished && elapsed <= BAN_CANCEL_DEADLINE_MS + 5_000) {
        await vi.advanceTimersByTimeAsync(250);
        const o = box.seen;
        if (purgedAt === null && o && o.purge.sendBatch.mock.calls.length > 0) purgedAt = elapsed;
        if (emailedAt === null && o && o.sentBanned.length > 0) emailedAt = elapsed;
        elapsed += 250;
      }
      const { res, sentBanned, purge } = await done;
      expect(res.status).toBe(200);
      expect(purge.sendBatch).toHaveBeenCalledTimes(1);
      expect(purgedAt).not.toBeNull();
      expect(purgedAt!).toBeLessThan(BAN_CANCEL_DEADLINE_MS);
      expect(emailedAt).not.toBeNull();
      expect(emailedAt!).toBeLessThanOrEqual(BAN_CANCEL_DEADLINE_MS);
      expect(sentBanned.length).toBeGreaterThan(0);
      for (const sent of sentBanned) expect(sent.subscriptionOutcomes).toEqual(['failed']);
    });
  });

  it('a ban while another unbanned seat remains touches no license and returns nothing', async () => {
    await t.db
      .update(profiles)
      .set({ bannedAt: null, banReason: null })
      .where(eq(profiles.id, SEAT_B));
    const stripe = fakeStripe() as FakeStripe;
    const { res, sentBanned, ownership } = await act(SEAT_A, BAN, { stripe });
    expect(res.status).toBe(200);
    for (const id of [annual, monthly, unassigned]) {
      expect((await licenseRows()).get(id)!.endedAt).toBeNull();
    }
    expect((await vendorRow()).ownedAt).toBe(OWNED_AT);
    expect((await audits()).filter((a) => a.action.startsWith('license.'))).toEqual([]);
    expect(stripe.cancels).toEqual([]);
    expect(stripe.retrieveSubscription).not.toHaveBeenCalled();
    expect(sentBanned).toEqual([]);
    expect(ownership.send).not.toHaveBeenCalled();
  });

  it('a grant that lands mid-request rolls the whole ban back (409), nothing written', async () => {
    const before = (await audits()).length;
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await seedLicense(t.db, VENDOR, { endsAt: ANNUAL_END });
      return original(stmts);
    }) as never);
    const stripe = fakeStripe() as FakeStripe;
    const { res, json, sentBanned } = await act(SEAT_A, BAN, { stripe });
    expect(res.status).toBe(409);
    expect(json?.error?.code).toBe('VENDOR_SEATS_CHANGED');
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat!.bannedAt).toBeNull();
    expect((await licenseRows()).get(annual)!.endedAt).toBeNull();
    expect((await vendorRow()).ownedAt).toBe(OWNED_AT);
    expect((await audits()).length).toBe(before);
    expect(stripe.cancels).toEqual([]);
    expect(sentBanned).toEqual([]);
  });

  // A lapse or a Stripe `deleted` that ends a license between the read and the batch:
  // its guarded UPDATE matches no row, and the per-row sentinel rolls the ban back.
  it('a license ended between the read and the batch rolls the whole ban back (409), nothing written', async () => {
    const before = await audits();
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db
        .update(licenses)
        .set({ endedAt: '2026-11-02T11:00:00.000Z', endReason: 'lapsed' })
        .where(eq(licenses.id, annual));
      return original(stmts);
    }) as never);
    const stripe = fakeStripe() as FakeStripe;
    const { res, json, sentBanned } = await act(SEAT_A, BAN, { stripe });
    expect(res.status).toBe(409);
    expect(json?.error?.code).toBe('VENDOR_SEATS_CHANGED');
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat!.bannedAt).toBeNull();
    const rows = await licenseRows();
    expect(rows.get(annual)).toMatchObject({ endReason: 'lapsed' });
    for (const id of [monthly, unassigned]) expect(rows.get(id)!.endedAt).toBeNull();
    expect((await vendorRow()).ownedAt).toBe(OWNED_AT);
    expect(await audits()).toEqual(before);
    expect(stripe.cancels).toEqual([]);
    expect(sentBanned).toEqual([]);
  });

  it('a lost seat race rolls the ban back (409)', async () => {
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
      await t.db.insert(profiles).values({ id: u(603), role: 'vendor_admin', vendorId: VENDOR });
      return original(stmts);
    }) as never);
    expect((await act(SEAT_A, BAN)).res.status).toBe(409);
    for (const id of [annual, monthly, unassigned]) {
      expect((await licenseRows()).get(id)!.endedAt).toBeNull();
    }
  });

  describe('the unban', () => {
    it('re-stamps owned_at the ban cleared, records it, and tells the review app', async () => {
      await act(SEAT_A, BAN);
      const { res, ownership } = await act(SEAT_A, { action: 'unban' });
      expect(res.status).toBe(200);
      expect((await vendorRow()).ownedAt).not.toBeNull();
      const row = (await audits()).find((a) => a.action === 'vendor_admin.unbanned');
      expect(row!.metadata).toMatchObject({ ownership_stamped: true });
      const sent = ownership.send.mock.calls.map(([m]) => m);
      expect(sent).toEqual([expect.objectContaining({ reason: 'seat_provisioned' })]);
    });

    it('grants no license', async () => {
      await act(SEAT_A, BAN);
      await act(SEAT_A, { action: 'unban' });
      const live = [...(await licenseRows()).values()].filter((l) => l.endedAt === null);
      expect(live).toEqual([]);
      expect((await audits()).filter((a) => a.action === 'license.granted')).toEqual([]);
    });

    it('does not re-stamp when the vendor is still owned', async () => {
      await t.db
        .update(profiles)
        .set({ bannedAt: null, banReason: null })
        .where(eq(profiles.id, SEAT_B));
      await act(SEAT_A, BAN);
      const { ownership } = await act(SEAT_A, { action: 'unban' });
      expect((await vendorRow()).ownedAt).toBe(OWNED_AT);
      const row = (await audits()).find((a) => a.action === 'vendor_admin.unbanned');
      expect(row!.metadata).not.toHaveProperty('ownership_stamped');
      expect(ownership.send).not.toHaveBeenCalled();
    });

    it('still clears a legacy vendor-banned flag', async () => {
      await t.db
        .update(profiles)
        .set({ bannedAt: null, banReason: null })
        .where(eq(profiles.id, SEAT_B));
      await act(SEAT_A, BAN);
      await t.db
        .update(licenses)
        .set({ cancelAtTermEnd: true, cancelReason: 'vendor-banned' })
        .where(eq(licenses.id, annual));
      expect((await act(SEAT_A, { action: 'unban' })).res.status).toBe(200);
      expect((await licenseRows()).get(annual)).toMatchObject({
        cancelAtTermEnd: false,
        cancelReason: null,
      });
    });
  });

  // AECI-1374 (ruled 2026-10-16): the last-seat ban revokes every pending invite in
  // the same batch, so a pre-ban invite cannot mint an unbanned seat on a banned vendor. Spent and lapsed invites are left as they are.
  describe('pending seat invites', () => {
    const FUTURE = '2099-01-01T00:00:00.000Z';
    const PAST = '2020-01-01T00:00:00.000Z';
    const SPENT = '2026-09-01T00:00:00.000Z';
    const seedInvites = async () => {
      await t.db.insert(vendorSeatInvites).values([
        {
          id: u(701),
          token: 't1',
          vendorId: VENDOR,
          email: 'a@x.com',
          invitedById: SEAT_A,
          expiresAt: FUTURE,
        },
        {
          id: u(702),
          token: 't2',
          vendorId: VENDOR,
          email: 'b@x.com',
          invitedById: SEAT_A,
          expiresAt: FUTURE,
        },
        {
          id: u(703),
          token: 't3',
          vendorId: VENDOR,
          email: 'c@x.com',
          invitedById: SEAT_A,
          expiresAt: FUTURE,
          acceptedAt: SPENT,
        },
        {
          id: u(704),
          token: 't4',
          vendorId: VENDOR,
          email: 'd@x.com',
          invitedById: SEAT_A,
          expiresAt: PAST,
        },
        {
          id: u(705),
          token: 't5',
          vendorId: VENDOR,
          email: 'e@x.com',
          invitedById: SEAT_A,
          expiresAt: FUTURE,
          revokedAt: SPENT,
        },
      ]);
    };
    const inviteRows = async () => {
      const rows = await t.db.select().from(vendorSeatInvites);
      return new Map(rows.map((r) => [r.id, r]));
    };
    const inviteAudits = async () =>
      (await t.db.select().from(auditLog)).filter((r) => r.action === 'vendor_seat.invite_revoked');

    it('the last-seat ban revokes only the pending invites, one audit row each, in the ban batch', async () => {
      await seedInvites();
      const batch = vi.spyOn(t.db, 'batch');
      expect((await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' })).status).toBe(200);
      expect(batch).toHaveBeenCalledTimes(1);

      const rows = await inviteRows();
      const [banned] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
      for (const id of [u(701), u(702)]) expect(rows.get(id)!.revokedAt).toBe(banned!.bannedAt);
      // Accepted, lapsed and already-revoked invites are untouched.
      expect(rows.get(u(703))).toMatchObject({ acceptedAt: SPENT, revokedAt: null });
      expect(rows.get(u(704))!.revokedAt).toBeNull();
      expect(rows.get(u(705))!.revokedAt).toBe(SPENT);

      const audits = await inviteAudits();
      expect(audits.map((a) => a.entityId).sort()).toEqual([u(701), u(702)]);
      for (const a of audits) {
        expect(a).toMatchObject({
          actorId: ADMIN,
          entityType: 'vendor_seat_invite',
          vendorId: VENDOR,
        });
        expect(a.metadata).toMatchObject({
          source: 'admin-moderation',
          reason: 'vendor-banned',
          seat_user_id: SEAT_A,
        });
      }
    });

    it('a ban while another unbanned seat remains revokes no invite', async () => {
      await t.db
        .update(profiles)
        .set({ bannedAt: null, banReason: null })
        .where(eq(profiles.id, SEAT_B));
      await seedInvites();
      expect((await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' })).status).toBe(200);
      const rows = await inviteRows();
      for (const id of [u(701), u(702)]) expect(rows.get(id)!.revokedAt).toBeNull();
      expect(await inviteAudits()).toEqual([]);
    });

    it('a lost seat race rolls the invite revokes back with the ban (409)', async () => {
      await seedInvites();
      const original = t.db.batch.bind(t.db);
      vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
        await t.db.insert(profiles).values({ id: u(603), role: 'vendor_admin', vendorId: VENDOR });
        return original(stmts);
      }) as never);
      expect((await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' })).status).toBe(409);
      const rows = await inviteRows();
      for (const id of [u(701), u(702)]) expect(rows.get(id)!.revokedAt).toBeNull();
      expect(await inviteAudits()).toEqual([]);
    });

    it('an invite created between the read and the batch rolls the ban back (409)', async () => {
      await seedInvites();
      const original = t.db.batch.bind(t.db);
      vi.spyOn(t.db, 'batch').mockImplementationOnce((async (stmts: never) => {
        await t.db.insert(vendorSeatInvites).values({
          id: u(706),
          token: 't6',
          vendorId: VENDOR,
          email: 'f@x.com',
          invitedById: SEAT_A,
          expiresAt: FUTURE,
        });
        return original(stmts);
      }) as never);
      expect((await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' })).status).toBe(409);
      const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
      expect(seat!.bannedAt).toBeNull();
      const rows = await inviteRows();
      for (const id of [u(701), u(702), u(706)]) expect(rows.get(id)!.revokedAt).toBeNull();
      expect(await inviteAudits()).toEqual([]);
    });

    it('the unban restores no invite', async () => {
      await seedInvites();
      await patch(SEAT_A, { action: 'ban', reason: 'Portal abuse' });
      expect((await patch(SEAT_A, { action: 'unban' })).status).toBe(200);
      const rows = await inviteRows();
      for (const id of [u(701), u(702)]) expect(rows.get(id)!.revokedAt).not.toBeNull();
      expect(await inviteAudits()).toHaveLength(2);
    });
  });

  it('a reviewer ban reads and writes no license', async () => {
    await t.db.insert(profiles).values({ id: u(1) });
    expect((await patch(u(1), { action: 'ban', reason: 'Repeated spam reviews.' })).status).toBe(
      200,
    );
    for (const row of (await licenseRows()).values()) expect(row.endReason).not.toBe('banned');
    expect((await vendorRow()).ownedAt).toBe(OWNED_AT);
  });
});

describe('GET /api/admin/reviewers', () => {
  it('lists the currently-banned reviewers', async () => {
    await t.db.insert(profiles).values([
      { id: u(1), bannedAt: '2026-01-02T00:00:00.000Z', banReason: 'a' },
      { id: u(2) }, // not banned
    ]);
    const res = await listApp().request(
      '/api/admin/reviewers',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = (await res.json()) as { total: number; data: Array<{ reviewer_id: string }> };
    expect(body.total).toBe(1);
    expect(body.data[0]!.reviewer_id).toBe(u(1));
  });
});
