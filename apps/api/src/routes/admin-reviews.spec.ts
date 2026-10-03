/**
 * Admin moderation API (AECI-204 / Phase 5.13) on the Drizzle/D1 path (ADR 0016 /
 * AECI-253), against the in-memory D1 harness. Asserts the moderation batch
 * (status + audit + workflow), the post-batch count recompute, and the seam-#2
 * email lookup (injected).
 */

import type { CachePurgeMessage } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  productVendors,
  products,
  profiles,
  reviews,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import {
  sendReviewApprovedEmail,
  sendReviewRejectedEmail,
  sendVendorReviewPublishedEmail,
} from '../lib/email';
import type { DbFactory } from '../lib/handler-utils';
import { wrappedFactory } from '../test/racing-factory';
import { createListVendorNotificationsHandler } from './vendor-notifications';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { stubPosthogIntake } from '../test/posthog-intake';
import { createAdminReviewsListHandler, createModerateReviewHandler } from './admin-reviews';

// The §11.1 reviewer notifications are fire-and-forget; mock them so we can assert
// the right template fires with the product + reason without a real Resend call.
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/email')>()),
  sendReviewApprovedEmail: vi.fn(() => Promise.resolve('sent')),
  sendReviewRejectedEmail: vi.fn(() => Promise.resolve('sent')),
  // AECI-1180: the owning vendors' notice. Never a real Resend call.
  sendVendorReviewPublishedEmail: vi.fn(() => Promise.resolve('sent')),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const REVIEWER = u(901);

let t: TestDb;
beforeEach(async () => {
  vi.mocked(sendReviewApprovedEmail).mockClear();
  vi.mocked(sendReviewRejectedEmail).mockClear();
  vi.mocked(sendVendorReviewPublishedEmail).mockClear();
  t = await makeTestDb();
  await t.db.insert(profiles).values([{ id: ADMIN, role: 'admin' }, { id: REVIEWER }]);
  await t.db
    .insert(products)
    .values({ id: u(1), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
});
afterEach(() => t.dispose());

async function seedReview(id: string, status: string, reviewerFirm: string | null = null) {
  await t.db.insert(reviews).values({
    id,
    productId: u(1),
    reviewerId: REVIEWER,
    ratingOverall: 5,
    ratingOnboarding: 4,
    title: 'T',
    body: 'B',
    reviewerFirm,
    status,
  });
}

const emails = vi.fn(async () => new Map([[REVIEWER, 'rev@example.com']]));

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
  a.get('/api/admin/reviews', createAdminReviewsListHandler(t.factory, emails));
  return a;
}
function moderateApp() {
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
  a.patch('/api/admin/reviews/:id', createModerateReviewHandler(t.factory, emails));
  return a;
}
const patch = (id: string, body: unknown, env: Env = TEST_ENV) =>
  moderateApp().request(
    `/api/admin/reviews/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    env,
    fakeExecutionContext(),
  );

describe('GET /api/admin/reviews', () => {
  it('lists pending reviews with the reviewer email (seam #2)', async () => {
    await seedReview(u(11), 'pending');
    const res = await listApp().request(
      '/api/admin/reviews?status=pending',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      data: Array<{ reviewer_email: string | null }>;
    };
    expect(body.total).toBe(1);
    expect(body.data[0]!.reviewer_email).toBe('rev@example.com');
  });

  it('surfaces the reviewer_firm for moderation context (AECI-284)', async () => {
    await seedReview(u(12), 'pending', 'Acme Architects');
    const res = await listApp().request(
      '/api/admin/reviews?status=pending',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ reviewer_firm: string | null }> };
    expect(body.data[0]!.reviewer_firm).toBe('Acme Architects');
  });
});

describe('PATCH /api/admin/reviews/:id', () => {
  it('approves: status, audit, workflow, and recomputed product counts', async () => {
    await seedReview(u(11), 'pending');
    const res = await patch(u(11), { action: 'approve' });
    expect(res.status).toBe(200);

    expect((await t.db.select().from(reviews))[0]!.status).toBe('approved');
    // recompute ran post-batch: the product's denormalized review_count = 1.
    expect((await t.db.select().from(products))[0]!.reviewCount).toBe(1);
    expect((await t.db.select().from(auditLog)).some((a) => a.action === 'review.approved')).toBe(
      true,
    );
    const wf = await t.db.select().from(workflowInstances);
    expect(wf[0]!.currentState).toBe('approved');
    expect((await t.db.select().from(workflowTransitions))[0]!.toState).toBe('approved');

    // §11.1: the "now live" email fires to the reviewer with the product details.
    expect(sendReviewApprovedEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: 'rev@example.com',
        productName: 'Revit',
        productSlug: 'revit',
      }),
    );
    expect(sendReviewRejectedEmail).not.toHaveBeenCalled();
  });

  it('rejects with a reason', async () => {
    await seedReview(u(11), 'pending');
    const res = await patch(u(11), {
      action: 'reject',
      rejection_reason: 'Spam / not a genuine review.',
    });
    expect(res.status).toBe(200);
    const [row] = await t.db.select().from(reviews);
    expect(row!.status).toBe('rejected');
    expect(row!.rejectionReason).toBe('Spam / not a genuine review.');

    // §11.1: the "needs revision" email fires with the moderator's reason.
    expect(sendReviewRejectedEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: 'rev@example.com',
        productName: 'Revit',
        reason: 'Spam / not a genuine review.',
      }),
    );
    expect(sendReviewApprovedEmail).not.toHaveBeenCalled();
  });

  it('422s a non-pending review', async () => {
    await seedReview(u(11), 'approved');
    expect((await patch(u(11), { action: 'approve' })).status).toBe(422);
  });

  it('forwards the audit row and the transition in ONE request (AECI-1112)', async () => {
    await seedReview(u(11), 'pending');
    const intake = stubPosthogIntake();
    try {
      const res = await patch(
        u(11),
        { action: 'approve' },
        { ...TEST_ENV, POSTHOG_PROJECT_KEY: 'phc_test' },
      );
      expect(res.status).toBe(200);

      expect(intake.auditRequests()).toHaveLength(1);
      const messages = intake.auditRequests()[0]!.messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toBe(`audit review.approved ${u(11)}`);
      expect(messages[1]).toMatch(/^workflow pending→approved /);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('404s an unknown review', async () => {
    expect((await patch(u(999), { action: 'approve' })).status).toBe(404);
  });

  it('keys both decision emails review-decision:{id}, one decision email per review (AECI-1203)', async () => {
    await seedReview(u(11), 'pending');
    await patch(u(11), { action: 'approve' });
    expect(sendReviewApprovedEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dedupeKey: `review-decision:${u(11)}`,
        entity: { type: 'review', id: u(11) },
      }),
    );

    // The reject template shares the key, so the two can never both reach a reviewer.
    await t.db.delete(reviews);
    await seedReview(u(12), 'pending');
    await patch(u(12), { action: 'reject', rejection_reason: 'Off-topic.' });
    expect(sendReviewRejectedEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        dedupeKey: `review-decision:${u(12)}`,
        entity: { type: 'review', id: u(12) },
      }),
    );
  });

  it('two admins racing: the loser rolls back, answers 409, and sends no email (AECI-1203)', async () => {
    // Both requests pass the pending pre-read. The first batch to arrive waits until
    // the other has committed, so the guarded UPDATE in the late batch matches no row
    // and the real SQLite `changes()` sentinel aborts it.
    await seedReview(u(11), 'pending');
    const original = t.db.batch.bind(t.db);
    let releaseFirst!: () => void;
    const firstMayRun = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    const spy = vi.spyOn(t.db, 'batch').mockImplementation((async (stmts: never) => {
      calls++;
      if (calls === 1) {
        await firstMayRun;
        return original(stmts);
      }
      try {
        return await original(stmts);
      } finally {
        releaseFirst();
      }
    }) as never);

    const [approve, reject] = await Promise.all([
      patch(u(11), { action: 'approve' }),
      patch(u(11), { action: 'reject', rejection_reason: 'Spam / not a genuine review.' }),
    ]);
    spy.mockRestore();

    const statuses = [approve.status, reject.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = approve.status === 409 ? approve : reject;
    expect(((await loser.json()) as { error: { code: string } }).error.code).toBe(
      'REVIEW_ALREADY_MODERATED',
    );

    // One decision email, one audit row, one transition: the loser wrote nothing.
    const decisionEmails =
      vi.mocked(sendReviewApprovedEmail).mock.calls.length +
      vi.mocked(sendReviewRejectedEmail).mock.calls.length;
    expect(decisionEmails).toBe(1);
    const audits = (await t.db.select().from(auditLog)).filter((a) =>
      a.action.startsWith('review.'),
    );
    expect(audits).toHaveLength(1);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(1);
    const [row] = await t.db.select().from(reviews);
    expect(row!.status).toBe(approve.status === 200 ? 'approved' : 'rejected');
  });
});

describe('PATCH /api/admin/reviews/:id — cache-purge enqueue (WC-5 / AECI-319)', () => {
  /** PATCH with a mock `CACHE_PURGE_QUEUE` producer binding; drains the post-commit
   *  `waitUntil` tasks so the enqueue is observable. */
  async function patchWithQueue(
    id: string,
    body: unknown,
    send = vi.fn().mockResolvedValue(undefined),
  ) {
    const env: Env = {
      ...TEST_ENV,
      CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
    };
    const execCtx = fakeExecutionContext();
    const res = await moderateApp().request(
      `/api/admin/reviews/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      },
      env,
      execCtx,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    return { res, send };
  }

  it('enqueues product:<slug> with source:moderation on approve', async () => {
    await seedReview(u(11), 'pending');
    const { res, send } = await patchWithQueue(u(11), { action: 'approve' });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0] as CachePurgeMessage).toEqual({
      tags: ['product:revit'],
      source: 'moderation',
    });
  });

  it('does not enqueue on reject (the product-page aggregate is unchanged)', async () => {
    await seedReview(u(12), 'pending');
    const { res, send } = await patchWithQueue(u(12), {
      action: 'reject',
      rejection_reason: 'Spam / not a genuine review.',
    });
    expect(res.status).toBe(200);
    expect(send).not.toHaveBeenCalled();
  });

  it('still 200s when the queue binding is absent (graceful no-op)', async () => {
    await seedReview(u(13), 'pending');
    // Default TEST_ENV carries no CACHE_PURGE_QUEUE, so the purge is simply skipped.
    expect((await patch(u(13), { action: 'approve' })).status).toBe(200);
  });
});

describe('PATCH /api/admin/reviews/:id — owning-vendor notifications (AECI-1180 / §11c.12)', () => {
  const PRIMARY = u(201);
  const CO_OWNER = u(202);
  const STRANGER = u(203);
  const SEAT_PRIMARY = u(301);
  const SEAT_CO = u(302);
  const SEAT_STRANGER = u(303);

  beforeEach(async () => {
    await t.db.insert(vendors).values([
      { id: PRIMARY, slug: 'autodesk', companyName: 'Autodesk' },
      { id: CO_OWNER, slug: 'bentley', companyName: 'Bentley' },
      { id: STRANGER, slug: 'trimble', companyName: 'Trimble' },
    ]);
    await t.db.insert(productVendors).values([
      { productId: u(1), vendorId: PRIMARY, isPrimary: true },
      { productId: u(1), vendorId: CO_OWNER, isPrimary: false },
    ]);
    await t.db.insert(profiles).values([
      { id: SEAT_PRIMARY, role: 'vendor_admin', vendorId: PRIMARY },
      { id: SEAT_CO, role: 'vendor_admin', vendorId: CO_OWNER },
      { id: SEAT_STRANGER, role: 'vendor_admin', vendorId: STRANGER },
    ]);
  });

  /** Every id resolves, so a seat that is not emailed was never asked for. */
  const anyEmails = vi.fn(
    async (_env: Env, ids: readonly string[]) =>
      new Map(ids.map((id) => [id, `${id.slice(-3)}@example.test`])),
  );

  async function moderate(id: string, body: unknown, factory: DbFactory = t.factory) {
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
    a.patch('/api/admin/reviews/:id', createModerateReviewHandler(factory, anyEmails));
    const execCtx = fakeExecutionContext();
    const res = await a.request(
      `/api/admin/reviews/${id}`,
      {
        method: 'PATCH',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      },
      TEST_ENV,
      execCtx,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    return res;
  }

  const feedRows = async () =>
    (await t.db.select().from(auditLog)).filter((r) => r.action === 'notification.sent');

  it('approve writes one feed row per owning vendor, primary or not, and none to a non-owner', async () => {
    await seedReview(u(11), 'pending');
    expect((await moderate(u(11), { action: 'approve' })).status).toBe(200);

    const feed = await feedRows();
    expect(feed).toHaveLength(2);
    const byVendor = new Map(
      feed.map((r) => [(r.metadata as { vendorId: string }).vendorId, r] as const),
    );
    expect([...byVendor.keys()].sort()).toEqual([PRIMARY, CO_OWNER].sort());
    expect(byVendor.has(STRANGER)).toBe(false);
    expect(byVendor.get(CO_OWNER)).toMatchObject({
      actorId: ADMIN,
      entityType: 'review',
      entityId: u(11),
      metadata: {
        kind: 'review',
        vendorId: CO_OWNER,
        reviewId: u(11),
        productId: u(1),
        product: { slug: 'revit', name: 'Revit' },
        reviewTitle: 'T',
      },
    });
  });

  it('writes the feed rows in the approve batch itself', async () => {
    await seedReview(u(11), 'pending');
    let batches = 0;
    let rowsBefore = -1;
    const spying = wrappedFactory(t.factory, async (_attempt, run) => {
      batches += 1;
      rowsBefore = (await t.db.select().from(auditLog)).length;
      return run();
    });
    expect((await moderate(u(11), { action: 'approve' }, spying)).status).toBe(200);
    expect(batches).toBe(1);
    expect(rowsBefore).toBe(0);
    // review.approved and the two feed rows, all from that one batch.
    expect((await t.db.select().from(auditLog)).map((r) => r.action).sort()).toEqual([
      'notification.sent',
      'notification.sent',
      'review.approved',
    ]);
  });

  it('a failed approve batch leaves no feed row and sends no email', async () => {
    await seedReview(u(11), 'pending');
    const failing = wrappedFactory(t.factory, async () => {
      throw new Error('D1 down');
    });
    expect((await moderate(u(11), { action: 'approve' }, failing)).status).toBe(500);
    expect(await feedRows()).toEqual([]);
    expect((await t.db.select().from(reviews))[0]!.status).toBe('pending');
    expect(sendVendorReviewPublishedEmail).not.toHaveBeenCalled();
  });

  it('reject writes no feed row and emails no vendor', async () => {
    await seedReview(u(11), 'pending');
    const res = await moderate(u(11), {
      action: 'reject',
      rejection_reason: 'Spam / not a genuine review.',
    });
    expect(res.status).toBe(200);
    expect(await feedRows()).toEqual([]);
    expect(sendVendorReviewPublishedEmail).not.toHaveBeenCalled();
  });

  it('emails each owner’s seat post-commit, never a non-owner’s', async () => {
    await seedReview(u(11), 'pending');
    await moderate(u(11), { action: 'approve' });
    const sent = vi.mocked(sendVendorReviewPublishedEmail).mock.calls.map((c) => c[1]);
    expect(sent.map((s) => s.to).sort()).toEqual(['301@example.test', '302@example.test']);
    expect(sent.find((s) => s.to === '302@example.test')).toMatchObject({
      vendorSlug: 'bentley',
      productName: 'Revit',
      productSlug: 'revit',
      title: 'T',
      ratingOverall: 5,
      ratingOnboarding: 4,
    });
    // The reviewer's own email still fires beside it.
    expect(sendReviewApprovedEmail).toHaveBeenCalledTimes(1);
  });

  it('a failing owner email never changes the moderation response', async () => {
    await seedReview(u(11), 'pending');
    vi.mocked(sendVendorReviewPublishedEmail).mockRejectedValueOnce(new Error('Resend down'));
    const res = await moderate(u(11), { action: 'approve' });
    expect(res.status).toBe(200);
    expect(await feedRows()).toHaveLength(2);
  });

  it('each owner reads its own row on GET /api/vendor/notifications, a non-owner reads none', async () => {
    await seedReview(u(11), 'pending');
    await moderate(u(11), { action: 'approve' });

    const read = async (vendorId: string) => {
      const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
      a.onError(errorHandler());
      a.use('*', async (c, next) => {
        c.set('auth', {
          userId: SEAT_PRIMARY,
          email: undefined,
          role: 'vendor_admin',
          vendorId,
          entitlementTier: 'unclaimed',
          entitlement: null,
        });
        await next();
      });
      a.get('/api/vendor/notifications', createListVendorNotificationsHandler(t.factory));
      const res = await a.request(
        '/api/vendor/notifications',
        {},
        TEST_ENV,
        fakeExecutionContext(),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { notifications: unknown[] }).notifications;
    };

    const expected = {
      kind: 'review',
      id: expect.any(String),
      review_id: u(11),
      product: { slug: 'revit', name: 'Revit' },
      review_title: 'T',
      created_at: expect.any(String),
    };
    // Free (unclaimed) owners are told too: the notice is not plan-gated.
    expect(await read(PRIMARY)).toEqual([expected]);
    expect(await read(CO_OWNER)).toEqual([expected]);
    expect(await read(STRANGER)).toEqual([]);
  });
});
