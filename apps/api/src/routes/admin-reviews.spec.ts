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
  products,
  profiles,
  reviews,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { sendReviewApprovedEmail, sendReviewRejectedEmail } from '../lib/email';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminReviewsListHandler, createModerateReviewHandler } from './admin-reviews';

// The §11.1 reviewer notifications are fire-and-forget; mock them so we can assert
// the right template fires with the product + reason without a real Resend call.
vi.mock('../lib/email', () => ({
  sendReviewApprovedEmail: vi.fn(() => Promise.resolve('sent')),
  sendReviewRejectedEmail: vi.fn(() => Promise.resolve('sent')),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const REVIEWER = u(901);

let t: TestDb;
beforeEach(async () => {
  vi.mocked(sendReviewApprovedEmail).mockClear();
  vi.mocked(sendReviewRejectedEmail).mockClear();
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
    c.set('auth', { userId: ADMIN, email: undefined, role: 'admin' });
    await next();
  });
  a.get('/api/admin/reviews', createAdminReviewsListHandler(t.factory, emails));
  return a;
}
function moderateApp() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', { userId: ADMIN, email: undefined, role: 'admin' });
    await next();
  });
  a.patch('/api/admin/reviews/:id', createModerateReviewHandler(t.factory, emails));
  return a;
}
const patch = (id: string, body: unknown) =>
  moderateApp().request(
    `/api/admin/reviews/${id}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    TEST_ENV,
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

  it('404s an unknown review', async () => {
    expect((await patch(u(999), { action: 'approve' })).status).toBe(404);
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
