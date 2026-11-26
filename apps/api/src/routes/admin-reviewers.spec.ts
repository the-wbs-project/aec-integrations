/**
 * Reviewer ban-management API (AECI-218 / Phase 6.11) on the Drizzle/D1 path
 * (ADR 0016 / AECI-253), against the in-memory D1 harness.
 */

import { BAN_REJECTION_REASON } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  licenses,
  products,
  profiles,
  reviewResponses,
  reviewUpdates,
  reviews,
  vendors,
  vendorSuspensions,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { seedLicense } from '../test/licenses';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { sendReviewRejectedEmail, sendReviewUpdateRejectedEmail } from '../lib/email';
import type { DbFactory } from '../lib/handler-utils';
import { wrappedFactory } from '../test/racing-factory';
import { createBanReviewerHandler, createBannedReviewersListHandler } from './admin-reviewers';

vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/email')>()),
  sendReviewRejectedEmail: vi.fn(async () => 'sent'),
  sendReviewUpdateRejectedEmail: vi.fn(async () => 'sent'),
}));

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
function patchApp(factory: DbFactory = t.factory) {
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
  a.patch('/api/admin/reviewers/:id', createBanReviewerHandler(factory, emails));
  return a;
}
const patch = (id: string, body: unknown, factory?: DbFactory) =>
  patchApp(factory).request(
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

    await t.db.insert(profiles).values({ id: u(699), role: 'vendor_admin', vendorId: VENDOR });
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
describe('PATCH /api/admin/reviewers/:id: the last seat (AECI-1623)', () => {
  const VENDOR = u(600);
  const SEAT_A = u(601);
  const SEAT_B = u(602);
  const OWNED_AT = '2026-05-01T00:00:00.000Z';

  beforeEach(async () => {
    await t.db.insert(vendors).values({
      id: VENDOR,
      slug: 'bentley',
      companyName: 'Bentley',
      verified: true,
      maintainedBy: 'vendor',
      ownedAt: OWNED_AT,
    });
    await t.db.insert(profiles).values([
      { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
      {
        id: SEAT_B,
        role: 'vendor_admin',
        vendorId: VENDOR,
        bannedAt: '2026-09-01T00:00:00.000Z',
        banReason: 'earlier',
      },
    ]);
    await seedLicense(t.db, VENDOR, { endsAt: '2027-01-31T00:00:00.000Z' });
  });

  const BAN = { action: 'ban', reason: 'Portal abuse' };

  it('refuses the last unbanned seat with a 409 that points at Suspend, writing nothing', async () => {
    const res = await patch(SEAT_A, BAN);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('VENDOR_LAST_SEAT_USE_SUSPEND');
    expect(body.error.details).toMatchObject({ vendor_id: VENDOR });

    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat!.bannedAt).toBeNull();
    expect(await t.db.select().from(auditLog)).toEqual([]);
    const live = (await t.db.select().from(licenses)).filter((l) => l.endedAt === null);
    expect(live).toHaveLength(1);
    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(vendor!.ownedAt).toBe(OWNED_AT);
    // It never starts a suspension: the operator chooses that.
    expect(await t.db.select().from(vendorSuspensions)).toEqual([]);
  });

  it('a ban while another unbanned seat remains bans that one seat only', async () => {
    await t.db
      .update(profiles)
      .set({ bannedAt: null, banReason: null })
      .where(eq(profiles.id, SEAT_B));
    const res = await patch(SEAT_A, BAN);
    expect(res.status).toBe(200);
    const live = (await t.db.select().from(licenses)).filter((l) => l.endedAt === null);
    expect(live).toHaveLength(1);
    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(vendor!.ownedAt).toBe(OWNED_AT);
  });

  it('the unban re-stamps owned_at a termination cleared, and grants no license', async () => {
    await t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, VENDOR));
    const res = await patch(SEAT_B, { action: 'unban' });
    expect(res.status).toBe(200);
    const [vendor] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(vendor!.ownedAt).not.toBeNull();
    const row = (await t.db.select().from(auditLog)).find(
      (a) => a.action === 'vendor_admin.unbanned',
    );
    expect(row!.metadata).toMatchObject({ ownership_stamped: true });
    expect(
      (await t.db.select().from(auditLog)).filter((a) => a.action === 'license.granted'),
    ).toEqual([]);
  });

  it('a reviewer ban reads and writes no license', async () => {
    await t.db.insert(profiles).values({ id: u(1) });
    expect((await patch(u(1), BAN)).status).toBe(200);
    const live = (await t.db.select().from(licenses)).filter((l) => l.endedAt === null);
    expect(live).toHaveLength(1);
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

// AECI-1949: a ban can reject the person's pending items in the same batch.
describe('PATCH /api/admin/reviewers/:id with reject_pending (AECI-1949)', () => {
  const PERSON = u(10);
  const OTHER = u(11);
  const VENDOR = u(700);
  const SEAT = u(701);
  const SEAT_2 = u(702);
  const T0 = '2026-11-01T00:00:00.000Z';
  const BAN = { action: 'ban', reason: 'Spam account', reject_pending: true };
  let n = 0;

  beforeEach(async () => {
    n = 0;
    vi.mocked(sendReviewRejectedEmail).mockClear();
    vi.mocked(sendReviewUpdateRejectedEmail).mockClear();
    emails.mockClear();
    emails.mockImplementation(async () => new Map([[PERSON, 'person@example.test']]));
    await t.db.insert(vendors).values({ id: VENDOR, slug: 'autodesk', companyName: 'Autodesk' });
    await t.db
      .insert(profiles)
      .values([
        { id: PERSON },
        { id: OTHER },
        { id: SEAT, role: 'vendor_admin', vendorId: VENDOR },
        { id: SEAT_2, role: 'vendor_admin', vendorId: VENDOR },
      ]);
  });

  async function seedReview(reviewerId: string | null, status: string): Promise<string> {
    const id = u(1000 + n++);
    // One product per review: a person reviews a product once.
    const productId = u(5000 + n);
    await t.db.insert(products).values({ id: productId, slug: `p-${n}`, name: 'Revit' });
    await t.db.insert(reviews).values({
      id,
      productId,
      reviewerId,
      ratingOverall: 4,
      ratingOnboarding: 4,
      title: `Review ${id.slice(-3)}`,
      body: 'A review body long enough to read.',
      status,
    });
    return id;
  }
  async function seedUpdate(reviewId: string, status: string): Promise<string> {
    const id = u(2000 + n++);
    await t.db.insert(reviewUpdates).values({
      id,
      reviewId,
      body: 'An update body that is long enough to pass the fifty character minimum.',
      status,
      createdAt: T0,
      updatedAt: T0,
    });
    return id;
  }
  async function seedReply(reviewId: string, authorProfileId: string, status: string) {
    const id = u(3000 + n++);
    await t.db.insert(reviewResponses).values({
      id,
      reviewId,
      vendorId: VENDOR,
      authorProfileId,
      body: 'Thanks for the review.',
      status,
      createdAt: T0,
      updatedAt: T0,
    });
    return id;
  }
  const status = async (
    table: typeof reviews | typeof reviewUpdates | typeof reviewResponses,
    id: string,
  ) => (await t.db.select({ s: table.status }).from(table).where(eq(table.id, id)))[0]?.s;

  it('rejects the pending review and update in the ban batch, each with its own audit row', async () => {
    const pending = await seedReview(PERSON, 'pending');
    const approved = await seedReview(PERSON, 'approved');
    const rejected = await seedReview(PERSON, 'rejected');
    const others = await seedReview(OTHER, 'pending');
    const update = await seedUpdate(approved, 'pending');
    const approvedUpdate = await seedUpdate(approved, 'approved');
    const othersApproved = await seedReview(OTHER, 'approved');
    const othersUpdate = await seedUpdate(othersApproved, 'pending');

    const res = await patch(PERSON, BAN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rejected: unknown };
    expect(body.rejected).toEqual({ reviews: 1, review_updates: 1, review_responses: 0 });

    expect(await status(reviews, pending)).toBe('rejected');
    expect(await status(reviews, approved)).toBe('approved');
    expect(await status(reviews, rejected)).toBe('rejected');
    expect(await status(reviews, others)).toBe('pending');
    expect(await status(reviewUpdates, update)).toBe('rejected');
    expect(await status(reviewUpdates, approvedUpdate)).toBe('approved');
    expect(await status(reviewUpdates, othersUpdate)).toBe('pending');

    const [r] = await t.db.select().from(reviews).where(eq(reviews.id, pending));
    expect(r!.rejectionReason).toBe(BAN_REJECTION_REASON);
    expect(r!.moderatedBy).toBe(ADMIN);
    const [ru] = await t.db.select().from(reviewUpdates).where(eq(reviewUpdates.id, update));
    expect(ru!.rejectionReason).toBe(BAN_REJECTION_REASON);

    const rows = await t.db.select().from(auditLog);
    const ban = rows.find((a) => a.action === 'reviewer.banned')!;
    const reviewRow = rows.find((a) => a.action === 'review.rejected')!;
    const updateRow = rows.find((a) => a.action === 'review_update.rejected')!;
    expect(reviewRow.entityId).toBe(pending);
    expect(reviewRow.actorId).toBe(ADMIN);
    expect(updateRow.entityId).toBe(update);
    for (const row of [reviewRow, updateRow]) {
      expect(row.metadata).toMatchObject({
        source: 'admin-ban',
        ban_audit_id: ban.id,
        rejection_reason: BAN_REJECTION_REASON,
      });
    }
    // The ban's reason stays internal: no item row repeats it.
    expect(JSON.stringify([reviewRow.metadata, updateRow.metadata])).not.toContain('Spam account');

    // The review's workflow closes as a manual reject does.
    const wf = (await t.db.select().from(workflowInstances)).find(
      (w) => w.workflowType === 'review_moderation' && w.entityId === pending,
    );
    expect(wf).toMatchObject({ currentState: 'rejected', finalOutcome: 'rejected' });
    expect(wf!.completedAt).not.toBeNull();
    const transitions = await t.db
      .select()
      .from(workflowTransitions)
      .where(eq(workflowTransitions.workflowId, wf!.id));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromState: 'pending', toState: 'rejected' });

    // Ruling 1: no review email. Ruling 1a: the update email, once, with the fixed reason.
    await vi.waitFor(() => expect(sendReviewUpdateRejectedEmail).toHaveBeenCalledTimes(1));
    expect(sendReviewRejectedEmail).not.toHaveBeenCalled();
    expect(vi.mocked(sendReviewUpdateRejectedEmail).mock.calls[0]![1]).toMatchObject({
      to: 'person@example.test',
      productName: 'Revit',
      reason: BAN_REJECTION_REASON,
      afterBan: true,
      dedupeKey: `review-update-decision:${update}`,
    });
  });

  it('reuses an existing review_moderation instance', async () => {
    const pending = await seedReview(PERSON, 'pending');
    await t.db.insert(workflowInstances).values({
      id: u(4000),
      workflowType: 'review_moderation',
      entityId: pending,
      currentState: 'pending',
    });
    expect((await patch(PERSON, BAN)).status).toBe(200);
    const wfs = (await t.db.select().from(workflowInstances)).filter(
      (w) => w.workflowType === 'review_moderation',
    );
    expect(wfs).toHaveLength(1);
    expect(wfs[0]).toMatchObject({ id: u(4000), currentState: 'rejected' });
  });

  it('a seat ban rejects the pending replies the seat wrote, with the portal notice', async () => {
    const review = await seedReview(OTHER, 'approved');
    const review2 = await seedReview(OTHER, 'approved');
    const reply = await seedReply(review, SEAT, 'pending');
    const othersReply = await t.db
      .insert(reviewResponses)
      .values({
        id: u(3999),
        reviewId: review2,
        vendorId: VENDOR,
        authorProfileId: SEAT_2,
        body: 'Another seat wrote this.',
        status: 'pending',
      })
      .then(() => u(3999));

    const res = await patch(SEAT, BAN);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rejected: unknown }).rejected).toEqual({
      reviews: 0,
      review_updates: 0,
      review_responses: 1,
    });
    expect(await status(reviewResponses, reply)).toBe('rejected');
    expect(await status(reviewResponses, othersReply)).toBe('pending');

    const rows = await t.db.select().from(auditLog);
    const ban = rows.find((a) => a.action === 'vendor_admin.banned')!;
    const replyRow = rows.find((a) => a.action === 'review_response.rejected')!;
    expect(replyRow.entityId).toBe(reply);
    expect(replyRow.vendorId).toBe(VENDOR);
    expect(replyRow.metadata).toMatchObject({ source: 'admin-ban', ban_audit_id: ban.id });
    const notice = rows.find((a) => a.action === 'notification.sent' && a.entityId === reply);
    expect(notice!.metadata).toMatchObject({
      event: 'rejected',
      reason: BAN_REJECTION_REASON,
      notificationId: 'portal-review-response',
    });
  });

  it("reject_pending false keeps today's ban: nothing else moves", async () => {
    const pending = await seedReview(PERSON, 'pending');
    const res = await patch(PERSON, { ...BAN, reject_pending: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { rejected: unknown }).rejected).toEqual({
      reviews: 0,
      review_updates: 0,
      review_responses: 0,
    });
    expect(await status(reviews, pending)).toBe('pending');
    expect((await t.db.select().from(auditLog)).map((a) => a.action)).toEqual(['reviewer.banned']);
  });

  it('400s reject_pending on an unban', async () => {
    await t.db
      .update(profiles)
      .set({ bannedAt: T0, banReason: 'x' })
      .where(eq(profiles.id, PERSON));
    const res = await patch(PERSON, { action: 'unban', reject_pending: true });
    expect(res.status).toBe(400);
    const [p] = await t.db.select().from(profiles).where(eq(profiles.id, PERSON));
    expect(p!.bannedAt).toBe(T0);
  });

  it('422s above the cap and writes nothing', async () => {
    const approved = await seedReview(PERSON, 'approved');
    await seedUpdate(approved, 'pending');
    for (let i = 0; i < 100; i += 1) await seedReview(PERSON, 'pending');
    const res = await patch(PERSON, BAN);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; details: unknown } };
    expect(body.error.code).toBe('BAN_REJECT_TOO_MANY');
    expect(body.error.details).toMatchObject({ reviews: 100, review_updates: 1, max: 100 });
    const [p] = await t.db.select().from(profiles).where(eq(profiles.id, PERSON));
    expect(p!.bannedAt).toBeNull();
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('rejects exactly 100 items, chunking the workflow preload', async () => {
    for (let i = 0; i < 100; i += 1) await seedReview(PERSON, 'pending');
    const res = await patch(PERSON, BAN);
    expect(res.status).toBe(200);
    const left = (await t.db.select().from(reviews)).filter((r) => r.status === 'pending');
    expect(left).toEqual([]);
    expect(
      (await t.db.select().from(auditLog)).filter((a) => a.action === 'review.rejected'),
    ).toHaveLength(100);
  });

  // The ban's batch is the third `db.batch` of the request: the counts, the load,
  // then the write.
  const raceOnWrite = (race: () => Promise<unknown>) =>
    wrappedFactory(t.factory, async (attempt, run) => {
      if (attempt === 3) await race();
      return run();
    });

  it('a pending item decided mid-request aborts everything with BAN_PENDING_CHANGED', async () => {
    const pending = await seedReview(PERSON, 'pending');
    const second = await seedReview(PERSON, 'pending');
    const factory = raceOnWrite(() =>
      t.db.update(reviews).set({ status: 'approved' }).where(eq(reviews.id, second)),
    );
    const res = await patch(PERSON, BAN, factory);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'BAN_PENDING_CHANGED',
    );
    const [p] = await t.db.select().from(profiles).where(eq(profiles.id, PERSON));
    expect(p!.bannedAt).toBeNull();
    expect(await status(reviews, pending)).toBe('pending');
    expect(await t.db.select().from(auditLog)).toEqual([]);
    expect(await t.db.select().from(workflowInstances)).toEqual([]);
    expect(sendReviewUpdateRejectedEmail).not.toHaveBeenCalled();
  });

  // Review of AECI-1949: an item added after the load has no sentinel of its own, so the
  // batch's last statement (`noPendingLeftSentinel`) catches it.
  it('a pending review added mid-request aborts everything with BAN_PENDING_CHANGED', async () => {
    const pending = await seedReview(PERSON, 'pending');
    const factory = raceOnWrite(() => seedReview(PERSON, 'pending'));
    const res = await patch(PERSON, BAN, factory);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'BAN_PENDING_CHANGED',
    );
    const [p] = await t.db.select().from(profiles).where(eq(profiles.id, PERSON));
    expect(p!.bannedAt).toBeNull();
    expect(await status(reviews, pending)).toBe('pending');
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('a pending update added mid-request aborts everything, even with nothing loaded', async () => {
    const approved = await seedReview(PERSON, 'approved');
    const factory = raceOnWrite(() => seedUpdate(approved, 'pending'));
    const res = await patch(PERSON, BAN, factory);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'BAN_PENDING_CHANGED',
    );
    const [p] = await t.db.select().from(profiles).where(eq(profiles.id, PERSON));
    expect(p!.bannedAt).toBeNull();
  });

  it('a pending reply added mid-request aborts the seat ban with BAN_PENDING_CHANGED', async () => {
    const review = await seedReview(OTHER, 'approved');
    const factory = raceOnWrite(() => seedReply(review, SEAT, 'pending'));
    const res = await patch(SEAT, BAN, factory);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'BAN_PENDING_CHANGED',
    );
    const [p] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT));
    expect(p!.bannedAt).toBeNull();
  });

  it('a reply the vendor edited mid-request aborts the seat ban with BAN_PENDING_CHANGED', async () => {
    const review = await seedReview(OTHER, 'approved');
    const reply = await seedReply(review, SEAT, 'pending');
    const factory = raceOnWrite(() =>
      t.db
        .update(reviewResponses)
        .set({ body: 'Edited.', updatedAt: '2026-11-02T00:00:00.000Z' })
        .where(eq(reviewResponses.id, reply)),
    );
    const res = await patch(SEAT, BAN, factory);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'BAN_PENDING_CHANGED',
    );
    const [p] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT));
    expect(p!.bannedAt).toBeNull();
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('a seat race with an unchanged pending set still answers VENDOR_SEATS_CHANGED', async () => {
    const review = await seedReview(OTHER, 'approved');
    await seedReply(review, SEAT, 'pending');
    // The other seat is banned mid-request, so the seat sentinel fires.
    const factory = raceOnWrite(() =>
      t.db.update(profiles).set({ bannedAt: T0 }).where(eq(profiles.id, SEAT_2)),
    );
    const res = await patch(SEAT, BAN, factory);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VENDOR_SEATS_CHANGED',
    );
    expect(
      (await t.db.select().from(auditLog)).filter((a) => a.action !== 'vendor_admin.banned'),
    ).toEqual([]);
  });
});
