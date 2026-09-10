/**
 * POST /api/reviews on the Drizzle/D1 path (ADR 0016 / AECI-253), against the
 * in-memory D1 harness. Asserts the atomic review + workflow instance + genesis
 * transition + audit row (the §26.1 batch), plus the dedup + not-found paths.
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
import { sendReviewSubmittedEmail } from '../lib/email';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createSubmitReviewHandler, REVIEW_HOURLY_LIMIT } from './reviews';

// The §11.1 confirmation send is fire-and-forget; mock it so the route specs can
// assert it fires with the reviewer's email without a real Resend call.
vi.mock('../lib/email', () => ({
  sendReviewSubmittedEmail: vi.fn(() => Promise.resolve('sent')),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const USER = u(900);
const USER_EMAIL = 'reviewer@example.com';

let t: TestDb;
beforeEach(async () => {
  vi.mocked(sendReviewSubmittedEmail).mockClear();
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: USER });
  await t.db
    .insert(products)
    .values({ id: u(1), slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
});
afterEach(() => t.dispose());

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', {
      userId: USER,
      email: USER_EMAIL,
      role: 'reviewer',
      vendorId: null,
      entitlementTier: 'unclaimed',
      entitlement: null,
    });
    await next();
  });
  // score injected as a fixed null (fail-open path); no external call.
  a.post(
    '/api/reviews',
    createSubmitReviewHandler(t.factory, async () => null),
  );
  return a;
}

function post(body: unknown) {
  return app().request(
    '/api/reviews',
    { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
    TEST_ENV,
    fakeExecutionContext(),
  );
}

const validBody = (productId = u(1)) => ({
  product_id: productId,
  rating_overall: 5,
  rating_onboarding: 4,
  title: 'Solid tool',
  // body must be >= 50 chars per SubmitReviewSchema.
  body: 'We use it daily across the whole team and it works really well for our workflows.',
});

describe('POST /api/reviews', () => {
  it('creates a pending review + workflow instance + genesis transition + audit, atomically', async () => {
    const res = await post(validBody());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('pending');

    const reviewRows = await t.db.select().from(reviews);
    expect(reviewRows).toHaveLength(1);
    expect(reviewRows[0]!.status).toBe('pending');
    expect(reviewRows[0]!.reviewerId).toBe(USER);

    const wf = await t.db.select().from(workflowInstances);
    expect(wf).toHaveLength(1);
    expect(wf[0]!.workflowType).toBe('review_moderation');
    expect(wf[0]!.currentState).toBe('pending');

    const transitions = await t.db.select().from(workflowTransitions);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]!.toState).toBe('pending');
    expect(transitions[0]!.fromState).toBeNull();

    const audit = await t.db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('review.submitted');
    expect(audit[0]!.entityId).toBe(body.id);

    // §11.1: the "in moderation" confirmation fires to the reviewer (fire-and-forget).
    expect(sendReviewSubmittedEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: USER_EMAIL }),
    );
  });

  it('rejects a duplicate (non-archived) review for the same product → 409', async () => {
    expect((await post(validBody())).status).toBe(201);
    const dup = await post(validBody());
    expect(dup.status).toBe(409);
    // Still exactly one review — the duplicate did not write.
    expect(await t.db.select().from(reviews)).toHaveLength(1);
  });

  it('404s when the product does not exist', async () => {
    const res = await post(validBody(u(999)));
    expect(res.status).toBe(404);
    expect(await t.db.select().from(reviews)).toHaveLength(0);
  });

  it('stores a trimmed reviewer_firm (AECI-284)', async () => {
    const res = await post({ ...validBody(), reviewer_firm: '  Acme Architects  ' });
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(reviews);
    expect(row!.reviewerFirm).toBe('Acme Architects');
  });

  it('stores null reviewer_firm for a blank/whitespace-only value', async () => {
    const res = await post({ ...validBody(), reviewer_firm: '   ' });
    expect(res.status).toBe(201);
    const [row] = await t.db.select().from(reviews);
    expect(row!.reviewerFirm).toBeNull();
  });

  it('defaults reviewer_firm to null when omitted', async () => {
    expect((await post(validBody())).status).toBe(201);
    const [row] = await t.db.select().from(reviews);
    expect(row!.reviewerFirm).toBeNull();
  });

  it('rejects a reviewer_firm longer than 100 chars → 400 VALIDATION_FAILED', async () => {
    const res = await post({ ...validBody(), reviewer_firm: 'x'.repeat(101) });
    expect(res.status).toBe(400);
    expect(await t.db.select().from(reviews)).toHaveLength(0);
  });
});

describe('POST /api/reviews — the §15.1 hourly per-user cap (AECI-773)', () => {
  /** Distinct products, because the dedup index caps a user at one per product. */
  async function seedProducts(n: number) {
    for (let i = 0; i < n; i += 1) {
      await t.db
        .insert(products)
        .values({ id: u(100 + i), slug: `p${i}`, name: `P${i}`, promotionStatus: 'promoted' });
    }
  }

  it('allows the first three and 429s the fourth, with Retry-After', async () => {
    await seedProducts(4);

    for (let i = 0; i < REVIEW_HOURLY_LIMIT; i += 1) {
      expect((await post(validBody(u(100 + i)))).status).toBe(201);
    }

    const res = await post(validBody(u(103)));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(await t.db.select().from(reviews)).toHaveLength(REVIEW_HOURLY_LIMIT);
  });

  it('does not count reviews older than the window', async () => {
    await seedProducts(4);
    for (let i = 0; i < REVIEW_HOURLY_LIMIT; i += 1) {
      expect((await post(validBody(u(100 + i)))).status).toBe(201);
    }

    // Age every existing row out of the rolling hour.
    await t.db.update(reviews).set({ createdAt: new Date(Date.now() - 7_200_000).toISOString() });

    expect((await post(validBody(u(103)))).status).toBe(201);
  });

  it('counts EVERY status, so moderation is not a slot-refund machine', async () => {
    // The cap deliberately does not reuse the dedup index's `status <> archived`
    // predicate. If a rejected review stopped counting, rejecting three would
    // hand the submitter three fresh slots.
    await seedProducts(4);
    for (let i = 0; i < REVIEW_HOURLY_LIMIT; i += 1) {
      expect((await post(validBody(u(100 + i)))).status).toBe(201);
    }
    await t.db.update(reviews).set({ status: 'rejected' });

    expect((await post(validBody(u(103)))).status).toBe(429);
  });

  it('spends no budget on a product that does not exist', async () => {
    // The cap is checked after the existence and duplicate gates, so a caller
    // cannot burn their hour probing for products.
    for (let i = 0; i < 5; i += 1) {
      expect((await post(validBody(u(999)))).status).toBe(404);
    }

    await seedProducts(1);
    expect((await post(validBody(u(100)))).status).toBe(201);
  });
});
