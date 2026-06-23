/**
 * Admin moderation API (AECI-204 / Phase 5.13) on the Drizzle/D1 path (ADR 0016 /
 * AECI-253), against the in-memory D1 harness. Asserts the moderation batch
 * (status + audit + workflow), the post-batch count recompute, and the seam-#2
 * email lookup (injected).
 */

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
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminReviewsListHandler, createModerateReviewHandler } from './admin-reviews';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ADMIN = u(900);
const REVIEWER = u(901);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values([{ id: ADMIN, role: 'admin' }, { id: REVIEWER }]);
  await t.db
    .insert(products)
    .values({ id: u(1), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
});
afterEach(() => t.dispose());

async function seedReview(id: string, status: string) {
  await t.db.insert(reviews).values({
    id,
    productId: u(1),
    reviewerId: REVIEWER,
    ratingOverall: 5,
    ratingOnboarding: 4,
    title: 'T',
    body: 'B',
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
  });

  it('422s a non-pending review', async () => {
    await seedReview(u(11), 'approved');
    expect((await patch(u(11), { action: 'approve' })).status).toBe(422);
  });

  it('404s an unknown review', async () => {
    expect((await patch(u(999), { action: 'approve' })).status).toBe(404);
  });
});
