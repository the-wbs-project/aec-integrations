/**
 * AECI-1176 — vendor replies to reviews (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c).
 *
 * The handlers over the in-memory D1, with the session stubbed. The real guard is
 * composed with them in `vendor.authz-matrix.spec.ts`. What this file pins:
 *
 *   - every vendor transition of §11c.6, with its audit row in the same batch;
 *   - the purge directive is queued ONLY when a published reply leaves the page;
 *   - the refusals: duplicate, removed, wrong state, no change, the plan gate;
 *   - the one-404 rule for unknown, unowned and unapproved reviews (§11c.3);
 *   - a lost race writes nothing (§11c.7);
 *   - no route writes `reviews`, a count, or a workflow row (§11c.10, §11c.7);
 *   - the list and the `reviews` cursor scope (§11c.13, §11c.14).
 */

import {
  ApiErrorCode,
  ListVendorReviewsResponseSchema,
  VendorReviewResponseResultSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  productVendors,
  products,
  profiles,
  reviewResponses,
  reviews,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { racingFactory } from '../test/racing-factory';
import {
  createEditReviewResponseHandler,
  createListVendorReviewsHandler,
  createSubmitReviewResponseHandler,
  createWithdrawReviewResponseHandler,
} from './vendor-review-responses';
import { createVendorUpdatesHandler } from './vendor-updates';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1); // owns P_A
const VENDOR_B = uuid(2); // co-owns P_A in the co-owner cases only
const VENDOR_C = uuid(3); // owns P_C only

const P_A = uuid(10);
const P_C = uuid(11);

const R1 = uuid(30); // approved, on P_A
const R2 = uuid(31); // approved, on P_A
const R3 = uuid(32); // approved, on P_A
const R_PENDING = uuid(33); // pending, on P_A
const R_C = uuid(34); // approved, on P_C
const R_UNKNOWN = uuid(39);

const SEAT_A = uuid(100);
const SEAT_A2 = uuid(103);
const SEAT_B = uuid(101);
const SEAT_C = uuid(102);
const ADMIN = uuid(105);

const T0 = '2026-09-01T00:00:00.000Z';

type Auth = AuthzVariables['auth'];
const seat = (userId: string, vendorId: string, tier: 'verified' | 'unclaimed'): Auth => ({
  userId,
  email: `${userId}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: tier,
  entitlement: null,
});
const AUTH_A = seat(SEAT_A, VENDOR_A, 'verified');
const AUTH_A2 = seat(SEAT_A2, VENDOR_A, 'verified');
const AUTH_A_FREE = seat(SEAT_A, VENDOR_A, 'unclaimed');
const AUTH_B = seat(SEAT_B, VENDOR_B, 'verified');
const AUTH_C = seat(SEAT_C, VENDOR_C, 'verified');
const AUTH_C_FREE = seat(SEAT_C, VENDOR_C, 'unclaimed');

let t: TestDb;

beforeEach(async () => {
  nextReply = 0;
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'graphisoft', companyName: 'Graphisoft' },
  ]);
  await t.db.insert(products).values([
    { id: P_A, slug: 'revit', name: 'Revit', reviewCount: 3, ratingOverallAvg: 4 },
    { id: P_C, slug: 'archicad', name: 'ArchiCAD' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_C, vendorId: VENDOR_C, isPrimary: true },
  ]);
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_A2, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: SEAT_C, role: 'vendor_admin', vendorId: VENDOR_C },
    { id: ADMIN, role: 'admin' },
  ]);
  const review = (id: string, productId: string, status: string, createdAt: string) => ({
    id,
    productId,
    ratingOverall: 4,
    ratingOnboarding: 3,
    title: `Review ${id.slice(-2)}`,
    body: 'A long enough review body.',
    status,
    createdAt,
    updatedAt: createdAt,
  });
  await t.db
    .insert(reviews)
    .values([
      review(R1, P_A, 'approved', '2026-08-01T00:00:00.000Z'),
      review(R2, P_A, 'approved', '2026-08-02T00:00:00.000Z'),
      review(R3, P_A, 'approved', '2026-08-03T00:00:00.000Z'),
      review(R_PENDING, P_A, 'pending', '2026-08-04T00:00:00.000Z'),
      review(R_C, P_C, 'approved', '2026-08-05T00:00:00.000Z'),
    ]);
});
afterEach(() => t.dispose());

function app(auth: Auth, factory: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.get('/api/vendor/reviews', createListVendorReviewsHandler(factory));
  a.post('/api/vendor/reviews/:reviewId/response', createSubmitReviewResponseHandler(factory));
  a.patch('/api/vendor/reviews/:reviewId/response', createEditReviewResponseHandler(factory));
  a.post(
    '/api/vendor/reviews/:reviewId/response/withdraw',
    createWithdrawReviewResponseHandler(factory),
  );
  a.get('/api/vendor/updates', createVendorUpdatesHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  auth: Auth,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  factory?: DbFactory,
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app(auth, factory).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const submit = (auth: Auth, reviewId: string, body: unknown, factory?: DbFactory) =>
  call(auth, 'POST', `/api/vendor/reviews/${reviewId}/response`, body, factory);
const edit = (auth: Auth, reviewId: string, body: unknown, factory?: DbFactory) =>
  call(auth, 'PATCH', `/api/vendor/reviews/${reviewId}/response`, body, factory);
const withdraw = (auth: Auth, reviewId: string, factory?: DbFactory) =>
  call(auth, 'POST', `/api/vendor/reviews/${reviewId}/response/withdraw`, undefined, factory);
const list = (auth: Auth, query = '') => call(auth, 'GET', `/api/vendor/reviews${query}`);

const replyRows = () => t.db.select().from(reviewResponses);
const auditRows = () => t.db.select().from(auditLog);
const replyOf = async (reviewId: string, vendorId = VENDOR_A) =>
  (await replyRows()).find((r) => r.reviewId === reviewId && r.vendorId === vendorId);

/** Deterministic ids for seeded replies. Reset per test in `beforeEach`. */
let nextReply = 0;

/** Seed a reply row directly, in a given status. */
async function seedReply(
  reviewId: string,
  status: string,
  extra: Partial<typeof reviewResponses.$inferInsert> = {},
  vendorId = VENDOR_A,
): Promise<string> {
  const id = extra.id ?? uuid(500 + nextReply++);
  await t.db.insert(reviewResponses).values({
    id,
    reviewId,
    vendorId,
    authorProfileId: SEAT_A,
    body: 'The original reply.',
    status,
    createdAt: T0,
    updatedAt: T0,
    ...(status === 'published' ? { publishedAt: T0, moderatedBy: ADMIN, moderatedAt: T0 } : {}),
    ...extra,
  });
  return id;
}

/** `reviews` and the product's count columns, for the firewall assertion. */
async function firewallSnapshot() {
  return {
    reviews: await t.db.select().from(reviews),
    product: await t.db.select().from(products).where(eq(products.id, P_A)),
    workflows: await t.db.select().from(workflowInstances),
    transitions: await t.db.select().from(workflowTransitions),
  };
}

// ─── POST — create ───────────────────────────────────────────────────────────

describe('POST /api/vendor/reviews/:reviewId/response — create', () => {
  it('creates a pending reply with its audit row, and purges nothing', async () => {
    const res = await submit(AUTH_A, R1, { body: '  Thanks for the review.\nWe fixed it.  ' });
    expect(res.status).toBe(201);
    expect(() => VendorReviewResponseResultSchema.parse(res.body)).not.toThrow();
    expect(res.body.response).toMatchObject({
      status: 'pending',
      body: 'Thanks for the review.\nWe fixed it.',
      rejection_reason: null,
      published_at: null,
    });

    const row = await replyOf(R1);
    expect(row).toMatchObject({ status: 'pending', authorProfileId: SEAT_A, vendorId: VENDOR_A });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'review_response.submitted',
      entityType: 'review_response',
      entityId: row!.id,
      actorId: SEAT_A,
      actorType: 'user',
      afterState: { status: 'pending', body: 'Thanks for the review.\nWe fixed it.' },
    });
    expect(audit!.metadata).toEqual({
      source: 'vendor-portal',
      vendorId: VENDOR_A,
      reviewId: R1,
      productId: P_A,
    });
    // Pending is invisible to the public (pre-moderation): no purge.
    expect(res.send).not.toHaveBeenCalled();
  });

  it('refuses a body that is empty after trim, or longer than 2,000 characters', async () => {
    for (const body of [{ body: '   ' }, { body: 'x'.repeat(2001) }, {}]) {
      const res = await submit(AUTH_A, R1, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    }
    expect(await submit(AUTH_A, R1, { body: 'x'.repeat(2000) })).toMatchObject({ status: 201 });
  });

  it('refuses a second reply by the same vendor, pending or published, writing nothing', async () => {
    await submit(AUTH_A, R1, { body: 'First.' });
    const again = await submit(AUTH_A2, R1, { body: 'Second, from another seat.' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_EXISTS);
    expect(again.body.error.details).toEqual({ status: 'pending' });

    await seedReply(R2, 'published');
    const onPublished = await submit(AUTH_A, R2, { body: 'Another.' });
    expect(onPublished.status).toBe(409);
    expect(onPublished.body.error.details).toEqual({ status: 'published' });

    expect(await replyRows()).toHaveLength(2);
    expect(await auditRows()).toHaveLength(1);
  });

  it('answers EXISTS to the loser of two seats racing to create, with no audit row', async () => {
    const racing = racingFactory(t.factory, () => {
      t.raw
        .prepare(
          `INSERT INTO review_responses (id, review_id, vendor_id, body, status, created_at, updated_at)
             VALUES (?, ?, ?, 'won the race', 'pending', ?, ?)`,
        )
        .run(uuid(900), R1, VENDOR_A, T0, T0);
    });
    const res = await submit(AUTH_A, R1, { body: 'Lost the race.' }, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_EXISTS);
    expect(res.body.error.details).toEqual({ status: 'pending' });
    expect(await replyRows()).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
  });

  it('lets each owning vendor of a co-owned product reply once (ruling 4)', async () => {
    await t.db
      .insert(productVendors)
      .values({ productId: P_A, vendorId: VENDOR_B, isPrimary: false });
    expect((await submit(AUTH_A, R1, { body: 'From the primary.' })).status).toBe(201);
    expect((await submit(AUTH_B, R1, { body: 'From the co-owner.' })).status).toBe(201);
    expect(await replyRows()).toHaveLength(2);
  });
});

// ─── POST — resubmit ─────────────────────────────────────────────────────────

describe('POST /api/vendor/reviews/:reviewId/response — resubmit', () => {
  it('resubmits a rejected reply on the same row, clearing the decision', async () => {
    const id = await seedReply(R1, 'rejected', {
      rejectionReason: 'No offers to the reviewer.',
      moderatedBy: ADMIN,
      moderatedAt: T0,
    });
    const res = await submit(AUTH_A2, R1, { body: 'A plain answer this time.' });
    expect(res.status).toBe(200);
    expect(res.body.response).toMatchObject({ id, status: 'pending', rejection_reason: null });

    const row = await replyOf(R1);
    expect(row).toMatchObject({
      id,
      status: 'pending',
      body: 'A plain answer this time.',
      authorProfileId: SEAT_A2,
      rejectionReason: null,
      moderatedBy: null,
      moderatedAt: null,
      publishedAt: null,
    });
    expect(row!.updatedAt).not.toBe(T0);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'review_response.submitted',
      entityId: id,
      beforeState: {
        status: 'rejected',
        body: 'The original reply.',
        rejection_reason: 'No offers to the reviewer.',
      },
      afterState: { status: 'pending', body: 'A plain answer this time.' },
    });
    expect(audit!.metadata).toMatchObject({ resubmit: true });
    expect(res.send).not.toHaveBeenCalled();
  });

  it('resubmits a withdrawn reply on the same row', async () => {
    const id = await seedReply(R1, 'withdrawn');
    const res = await submit(AUTH_A, R1, { body: 'Back again.' });
    expect(res.status).toBe(200);
    expect(res.body.response).toMatchObject({ id, status: 'pending' });
    expect(await replyRows()).toHaveLength(1);
  });

  it('refuses any write on a removed reply, for good', async () => {
    await seedReply(R1, 'removed', { rejectionReason: 'Named the reviewer.' });
    for (const res of [
      await submit(AUTH_A, R1, { body: 'Try again.' }),
      await edit(AUTH_A, R1, { body: 'Try again.' }),
      await withdraw(AUTH_A, R1),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_REMOVED);
      expect(res.body.error.details).toEqual({ status: 'removed' });
    }
    expect((await replyOf(R1))!.status).toBe('removed');
    expect(await auditRows()).toHaveLength(0);
  });
});

// ─── PATCH — edit ────────────────────────────────────────────────────────────

describe('PATCH /api/vendor/reviews/:reviewId/response — edit', () => {
  it('edits a pending reply in place, with no purge and no wasPublished', async () => {
    const id = await seedReply(R1, 'pending');
    const res = await edit(AUTH_A, R1, { body: 'Reworded.' });
    expect(res.status).toBe(200);
    expect(res.body.response).toMatchObject({ id, status: 'pending', body: 'Reworded.' });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'review_response.edited',
      beforeState: { status: 'pending', body: 'The original reply.' },
      afterState: { status: 'pending', body: 'Reworded.' },
    });
    expect(audit!.metadata).not.toHaveProperty('wasPublished');
    expect(res.send).not.toHaveBeenCalled();
  });

  it('takes a published reply off the page and purges the product tag', async () => {
    await seedReply(R1, 'published');
    const res = await edit(AUTH_A, R1, { body: 'A correction.' });
    expect(res.status).toBe(200);
    expect(res.body.response).toMatchObject({ status: 'pending', published_at: null });
    const row = await replyOf(R1);
    expect(row).toMatchObject({ status: 'pending', publishedAt: null, authorProfileId: SEAT_A });
    const [audit] = await auditRows();
    expect(audit!.metadata).toMatchObject({ wasPublished: true });
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(res.send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'vendor' });
  });

  it('refuses an unchanged body after trim with 422, so a no-op cannot hide a live reply', async () => {
    await seedReply(R1, 'published');
    const res = await edit(AUTH_A, R1, { body: '  The original reply.  ' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_NO_CHANGE);
    expect(res.body.error.field).toBe('body');
    expect((await replyOf(R1))!.status).toBe('published');
    expect(res.send).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'withdrawn'])('refuses to edit a %s reply (resubmit instead)', async (s) => {
    await seedReply(R1, s);
    const res = await edit(AUTH_A, R1, { body: 'Edited.' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_WRONG_STATE);
    expect(res.body.error.details).toEqual({ status: s });
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers 404 when the caller has no reply to this review', async () => {
    const res = await edit(AUTH_A, R1, { body: 'Edited.' });
    expect(res.status).toBe(404);
    expect(res.body.error.details).toMatchObject({ resource: 'review_response' });
  });

  it('commits nothing when an admin decision lands between the read and the batch', async () => {
    await seedReply(R1, 'pending');
    const racing = racingFactory(t.factory, () => {
      t.raw
        .prepare(
          `UPDATE review_responses SET status = 'published', published_at = ? WHERE review_id = ?`,
        )
        .run(T0, R1);
    });
    const res = await edit(AUTH_A, R1, { body: 'Edited.' }, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_WRONG_STATE);
    expect(res.body.error.details).toEqual({ status: 'published' });
    expect((await replyOf(R1))!.body).toBe('The original reply.');
    expect(await auditRows()).toHaveLength(0);
    expect(res.send).not.toHaveBeenCalled();
  });
});

// ─── POST — withdraw ─────────────────────────────────────────────────────────

describe('POST /api/vendor/reviews/:reviewId/response/withdraw', () => {
  it('withdraws a pending reply with no purge', async () => {
    await seedReply(R1, 'pending');
    const res = await withdraw(AUTH_A, R1);
    expect(res.status).toBe(200);
    expect(res.body.response).toMatchObject({ status: 'withdrawn' });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'review_response.withdrawn',
      beforeState: { status: 'pending' },
      afterState: { status: 'withdrawn' },
    });
    expect(audit!.metadata).not.toHaveProperty('wasPublished');
    expect(res.send).not.toHaveBeenCalled();
  });

  it('withdraws a published reply, clears published_at and purges the product tag', async () => {
    await seedReply(R1, 'published');
    const res = await withdraw(AUTH_A, R1);
    expect(res.status).toBe(200);
    expect(await replyOf(R1)).toMatchObject({ status: 'withdrawn', publishedAt: null });
    expect((await auditRows())[0]!.metadata).toMatchObject({ wasPublished: true });
    expect(res.send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'vendor' });
  });

  it('is not plan-gated: a Free seat can take its own words down (§11c.9)', async () => {
    await seedReply(R1, 'published');
    const res = await withdraw(AUTH_A_FREE, R1);
    expect(res.status).toBe(200);
    expect((await replyOf(R1))!.status).toBe('withdrawn');
  });

  it('refuses a withdrawn or rejected reply, and 404s when there is none', async () => {
    await seedReply(R1, 'withdrawn');
    await seedReply(R2, 'rejected');
    expect((await withdraw(AUTH_A, R1)).body.error.code).toBe(
      ApiErrorCode.REVIEW_RESPONSE_WRONG_STATE,
    );
    expect((await withdraw(AUTH_A, R2)).body.error.details).toEqual({ status: 'rejected' });
    expect((await withdraw(AUTH_A, R3)).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers REMOVED when AECi removed the reply mid-request', async () => {
    await seedReply(R1, 'published');
    const racing = racingFactory(t.factory, () => {
      t.raw
        .prepare(
          `UPDATE review_responses SET status = 'removed', published_at = NULL WHERE review_id = ?`,
        )
        .run(R1);
    });
    const res = await withdraw(AUTH_A, R1, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_REMOVED);
    expect(await auditRows()).toHaveLength(0);
    expect(res.send).not.toHaveBeenCalled();
  });
});

// ─── The gates ───────────────────────────────────────────────────────────────

describe('who may reply (§11c.3, §11c.9)', () => {
  it('answers the same 404 for an unknown, an unowned and an unapproved review', async () => {
    const results = [
      await submit(AUTH_A, R_UNKNOWN, { body: 'x' }),
      await submit(AUTH_A, R_C, { body: 'x' }),
      await submit(AUTH_A, R_PENDING, { body: 'x' }),
    ];
    const ids = [R_UNKNOWN, R_C, R_PENDING];
    results.forEach((res, i) => {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ApiErrorCode.NOT_FOUND);
      // Nothing but the id the caller sent: no product id, no status.
      expect(res.body.error.details).toEqual({ resource: 'review', id: ids[i] });
    });
    expect(await replyRows()).toHaveLength(0);
  });

  it('settles ownership before the plan gate and before the body', async () => {
    // A Free seat on another vendor: 404, never the 403 that would confirm the review.
    expect((await submit(AUTH_C_FREE, R1, { body: 'x' })).status).toBe(404);
    // A malformed body on an unowned review: still the 404.
    expect((await submit(AUTH_C, R1, { body: '' })).status).toBe(404);
    expect((await edit(AUTH_C, R1, {})).status).toBe(404);
    expect((await withdraw(AUTH_C, R1)).status).toBe(404);
  });

  it('refuses create and edit to a Free seat with 403 ENTITLEMENT_REQUIRED', async () => {
    const created = await submit(AUTH_A_FREE, R1, { body: 'x' });
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe(ApiErrorCode.ENTITLEMENT_REQUIRED);
    expect(created.body.error.details).toMatchObject({
      capability: 'review.reply',
      tier: 'unclaimed',
    });

    await seedReply(R2, 'pending');
    const edited = await edit(AUTH_A_FREE, R2, { body: 'Edited.' });
    expect(edited.status).toBe(403);
    expect(edited.body.error.details).toMatchObject({ capability: 'review.reply' });

    // The plan gate runs before the body: an invalid body is still the 403.
    expect((await submit(AUTH_A_FREE, R1, { body: '' })).status).toBe(403);
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers 404 to a vendor that lost ownership, and keeps its reply row (§11c.3)', async () => {
    await seedReply(R1, 'published');
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, VENDOR_A));
    expect((await withdraw(AUTH_A, R1)).status).toBe(404);
    expect((await replyOf(R1))!.status).toBe('published');
  });
});

// ─── The firewall ────────────────────────────────────────────────────────────

describe('the firewall (§11c.10)', () => {
  it('never writes reviews, a count column or a workflow row, across every transition', async () => {
    const before = await firewallSnapshot();
    await submit(AUTH_A, R1, { body: 'One.' });
    await edit(AUTH_A, R1, { body: 'Two.' });
    await withdraw(AUTH_A, R1);
    await submit(AUTH_A, R1, { body: 'Three.' });
    await seedReply(R2, 'published');
    await edit(AUTH_A, R2, { body: 'Four.' });
    await seedReply(R3, 'published');
    await withdraw(AUTH_A, R3);
    expect(await firewallSnapshot()).toEqual(before);
  });
});

// ─── GET /api/vendor/reviews ─────────────────────────────────────────────────

describe('GET /api/vendor/reviews', () => {
  it('lists approved reviews of owned products only, newest first, with the reply states', async () => {
    await t.db
      .insert(productVendors)
      .values({ productId: P_A, vendorId: VENDOR_B, isPrimary: false });
    await seedReply(R1, 'rejected', { rejectionReason: 'Off topic.' });
    await seedReply(R2, 'published', {}, VENDOR_B);
    await seedReply(R3, 'pending', {}, VENDOR_B);

    const res = await list(AUTH_A);
    expect(res.status).toBe(200);
    expect(() => ListVendorReviewsResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.total).toBe(3);
    expect(res.body.data.map((i: JsonBody) => i.review.id)).toEqual([R3, R2, R1]);
    const byId = Object.fromEntries(res.body.data.map((i: JsonBody) => [i.review.id, i]));

    expect(byId[R1].response).toMatchObject({ status: 'rejected', rejection_reason: 'Off topic.' });
    expect(byId[R1].product).toMatchObject({ id: P_A, slug: 'revit', name: 'Revit' });
    // The co-owner's PUBLISHED reply shows; its pending one never does.
    expect(byId[R2].response).toBeNull();
    expect(byId[R2].other_responses).toEqual([
      {
        vendor_slug: 'bentley',
        vendor_name: 'Bentley',
        body: 'The original reply.',
        published_at: T0,
      },
    ]);
    expect(byId[R3].other_responses).toEqual([]);
    expect(res.body.data.every((i: JsonBody) => i.can_reply === true)).toBe(true);
    // The public review shape: no reviewer, no status, no moderation column.
    expect(byId[R1].review).not.toHaveProperty('status');
    expect(byId[R1].review).not.toHaveProperty('reviewer_id');
  });

  it('drops a co-owner reply once that vendor no longer owns the product (§11c.11 rule 3)', async () => {
    await seedReply(R1, 'published', {}, VENDOR_B);
    const res = await list(AUTH_A);
    expect(res.body.data.find((i: JsonBody) => i.review.id === R1).other_responses).toEqual([]);
  });

  it('reports can_reply false to a Free seat, which still reads everything', async () => {
    await seedReply(R1, 'published');
    const res = await list(AUTH_A_FREE);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.data.every((i: JsonBody) => i.can_reply === false)).toBe(true);
  });

  it('filters by reply_status and product_id; a foreign product is an empty page', async () => {
    await seedReply(R1, 'pending');
    await seedReply(R2, 'withdrawn');
    const ids = async (q: string) =>
      (await list(AUTH_A, q)).body.data.map((i: JsonBody) => i.review.id);
    expect(await ids('?reply_status=none')).toEqual([R3]);
    expect(await ids('?reply_status=pending')).toEqual([R1]);
    expect(await ids('?reply_status=withdrawn')).toEqual([R2]);
    expect(await ids('?reply_status=removed')).toEqual([]);
    expect(await ids(`?product_id=${P_A}`)).toEqual([R3, R2, R1]);
    const foreign = await list(AUTH_A, `?product_id=${P_C}`);
    expect(foreign.status).toBe(200);
    expect(foreign.body).toMatchObject({ data: [], total: 0 });
    expect((await list(AUTH_A, '?reply_status=bogus')).status).toBe(400);
  });

  it('paginates', async () => {
    const res = await list(AUTH_A, '?perPage=2&page=2');
    expect(res.body).toMatchObject({ page: 2, perPage: 2, total: 3 });
    expect(res.body.data.map((i: JsonBody) => i.review.id)).toEqual([R1]);
  });

  it('writes no audit row', async () => {
    await list(AUTH_A);
    expect(await auditRows()).toHaveLength(0);
  });
});

// ─── The `reviews` cursor scope ──────────────────────────────────────────────

describe('GET /api/vendor/updates — the reviews scope (§11c.13)', () => {
  const cursor = async (auth: Auth) =>
    (await call(auth, 'GET', '/api/vendor/updates')).body.revisions.reviews as string | null;

  it('reports the newest approved review of an owned product, and moves on a reply write', async () => {
    expect(await cursor(AUTH_A)).toBe('2026-08-03T00:00:00.000Z');
    await submit(AUTH_A, R1, { body: 'Hello.' });
    const moved = await cursor(AUTH_A);
    expect(moved! > '2026-08-03T00:00:00.000Z').toBe(true);
    expect(moved).toBe((await replyOf(R1))!.updatedAt);
  });

  it('never moves for a pending review or another vendor’s reply', async () => {
    const before = await cursor(AUTH_A);
    await t.db
      .update(reviews)
      .set({ updatedAt: '2027-01-01T00:00:00.000Z' })
      .where(eq(reviews.id, R_PENDING));
    await t.db
      .insert(productVendors)
      .values({ productId: P_A, vendorId: VENDOR_B, isPrimary: false });
    await seedReply(R1, 'pending', { updatedAt: '2027-01-02T00:00:00.000Z' }, VENDOR_B);
    await seedReply(R_C, 'pending', { updatedAt: '2027-01-03T00:00:00.000Z' }, VENDOR_C);
    expect(await cursor(AUTH_A)).toBe(before);
  });

  it('is null for a vendor with no reviews and no replies', async () => {
    await t.db.delete(reviews).where(eq(reviews.id, R_C));
    expect(await cursor(AUTH_C)).toBeNull();
  });
});
