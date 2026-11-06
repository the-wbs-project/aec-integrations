/**
 * AECI-1613 — a reviewer's update to a published review, and where it shows.
 *
 *   - `POST /api/account/reviews/:reviewId/updates`: owner and approved only (every
 *     miss is the same 404), one pending update per review (409, with the index as
 *     the race backstop), both ratings or neither (400), a suspended vendor seat
 *     writes nothing (403), and the insert and its audit row share one batch.
 *   - `GET /api/account/reviews` carries each row's updates, every status.
 *   - Both public reads carry approved updates only, oldest first, and the review's
 *     own fields stay exactly as published.
 *   - `DELETE /api/account` nulls `review_updates.moderated_by` and keeps the update.
 */

import { ApiErrorCode, ProductReviewsResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  products,
  profiles,
  reviewUpdates,
  reviews,
  vendorSuspensions,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { sendReviewUpdateSubmittedAlert, sendReviewUpdateSubmittedEmail } from '../lib/email';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { wrappedFactory } from '../test/racing-factory';
import { createSubmitReviewUpdateHandler } from './account-review-updates';
import { createGetAccountReviewsHandler } from './account-reviews';
import { createProductReviewsListHandler } from './product-reviews';
import { createProductDetailHandler } from './products';

vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/email')>()),
  sendReviewUpdateSubmittedEmail: vi.fn(async () => 'sent'),
  sendReviewUpdateSubmittedAlert: vi.fn(async () => 'sent'),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = uuid(10);
const OWNER = uuid(100);
const OTHER = uuid(101);
const ADMIN = uuid(102);
const SEAT = uuid(103);
const VENDOR = uuid(1);
const R_APPROVED = uuid(30);
const R_PENDING = uuid(31);
const R_OTHER = uuid(32);

const BODY = 'The vendor shipped a fix for the sync problem, so my experience has changed.';

type Auth = AuthzVariables['auth'];
const authFor = (userId: string, extra: Partial<Record<string, unknown>> = {}) =>
  ({
    userId,
    email: `${userId.slice(-3)}@example.test`,
    role: 'reviewer',
    vendorId: null,
    entitlementTier: null,
    entitlement: null,
    ...extra,
  }) as unknown as Auth;

let t: TestDb;

beforeEach(async () => {
  vi.mocked(sendReviewUpdateSubmittedEmail).mockClear();
  vi.mocked(sendReviewUpdateSubmittedAlert).mockClear();
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'autodesk', companyName: 'Autodesk' });
  await t.db
    .insert(products)
    .values({ id: P, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'reviewer' },
    { id: OTHER, role: 'reviewer' },
    { id: ADMIN, role: 'admin' },
    { id: SEAT, role: 'vendor_admin', vendorId: VENDOR },
  ]);
  const review = (id: string, reviewerId: string, status: string, createdAt: string) => ({
    id,
    productId: P,
    reviewerId,
    ratingOverall: 2,
    ratingOnboarding: 3,
    title: `Review ${id.slice(-2)}`,
    body: 'The original review, as it was published.',
    status,
    createdAt,
    updatedAt: createdAt,
  });
  await t.db
    .insert(reviews)
    .values([
      review(R_APPROVED, OWNER, 'approved', '2026-08-03T00:00:00.000Z'),
      review(R_OTHER, OTHER, 'approved', '2026-08-02T00:00:00.000Z'),
    ]);
  // A pending review of another product would hit the unique index on P, so give the
  // owner's pending review its own product.
  await t.db.insert(products).values({ id: uuid(11), slug: 'navis', name: 'Navis' });
  await t.db.insert(reviews).values({
    ...review(R_PENDING, OWNER, 'pending', '2026-08-01T00:00:00.000Z'),
    productId: uuid(11),
  });
});
afterEach(() => t.dispose());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function submit(
  reviewId: string,
  body: unknown,
  opts: { auth?: Auth; factory?: DbFactory; score?: number | null } = {},
) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, nxt) => {
    c.set('auth', opts.auth ?? authFor(OWNER));
    await nxt();
  });
  a.post(
    '/api/account/reviews/:reviewId/updates',
    createSubmitReviewUpdateHandler(opts.factory ?? t.factory, async () =>
      'score' in opts ? (opts.score ?? null) : 0.1,
    ),
  );
  const execCtx = fakeExecutionContext();
  const res = await a.request(
    `/api/account/reviews/${reviewId}/updates`,
    {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    TEST_ENV,
    execCtx,
  );
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody };
}

async function seedUpdate(
  status: string,
  extra: Partial<typeof reviewUpdates.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(reviewUpdates).values({
    id: extra.id ?? crypto.randomUUID(),
    reviewId: R_APPROVED,
    body: BODY,
    ratingOverall: 4,
    ratingOnboarding: 4,
    status,
    ...extra,
  });
}

const updateRows = () => t.db.select().from(reviewUpdates);
const auditRows = () => t.db.select().from(auditLog);

// ─── POST ────────────────────────────────────────────────────────────────────

describe('POST /api/account/reviews/:reviewId/updates', () => {
  it('stores a pending update with its audit row in the same batch, and sends both emails', async () => {
    let batched: unknown[] = [];
    const factory = wrappedFactory(t.factory, async (_attempt, run, stmts) => {
      batched = stmts as unknown[];
      return run();
    });
    const res = await submit(
      R_APPROVED,
      { body: `  ${BODY}  `, rating_overall: 4, rating_onboarding: 5 },
      { factory },
    );
    expect(res.status).toBe(201);
    expect(res.body.update).toMatchObject({
      status: 'pending',
      body: BODY,
      rating_overall: 4,
      rating_onboarding: 5,
      rejection_reason: null,
      published_at: null,
    });
    expect(batched).toHaveLength(2);

    const [row] = await updateRows();
    expect(row).toMatchObject({
      id: res.body.update.id,
      reviewId: R_APPROVED,
      status: 'pending',
      toxicityScore: 0.1,
    });
    expect(await auditRows()).toEqual([
      expect.objectContaining({
        action: 'review_update.submitted',
        entityType: 'review_update',
        entityId: row!.id,
        actorId: OWNER,
        productId: P,
      }),
    ]);
    expect(sendReviewUpdateSubmittedEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ to: '100@example.test' }),
    );
    expect(sendReviewUpdateSubmittedAlert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ toxicityScore: 0.1 }),
    );
    // The original review is never written.
    const [original] = await t.db.select().from(reviews).where(eq(reviews.id, R_APPROVED));
    expect(original).toMatchObject({ ratingOverall: 2, ratingOnboarding: 3 });
  });

  it('accepts an update with neither rating', async () => {
    const res = await submit(R_APPROVED, { body: BODY });
    expect(res.status).toBe(201);
    expect(res.body.update).toMatchObject({ rating_overall: null, rating_onboarding: null });
  });

  it('stores a null toxicity score when the classifier fails open', async () => {
    expect((await submit(R_APPROVED, { body: BODY }, { score: null })).status).toBe(201);
    expect((await updateRows())[0]!.toxicityScore).toBeNull();
  });

  it.each([
    ['one rating only', { body: BODY, rating_overall: 4 }, 'rating_onboarding'],
    ['the other rating only', { body: BODY, rating_onboarding: 4 }, 'rating_overall'],
    ['a short body', { body: 'Too short.' }, 'body'],
    [
      'a rating out of range',
      { body: BODY, rating_overall: 6, rating_onboarding: 4 },
      'rating_overall',
    ],
  ])('refuses %s with 400 and writes nothing', async (_name, payload, field) => {
    const res = await submit(R_APPROVED, payload);
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain(field);
    expect(await updateRows()).toEqual([]);
    expect(await auditRows()).toEqual([]);
  });

  it.each([
    ['someone else’s review', R_OTHER],
    ['a review that is not approved', R_PENDING],
    ['an unknown review', uuid(999)],
  ])('answers the same 404 for %s', async (_name, reviewId) => {
    const res = await submit(reviewId, { body: BODY });
    expect(res.status).toBe(404);
    expect(await updateRows()).toEqual([]);
  });

  it('refuses a second update while one is pending: 409 REVIEW_UPDATE_PENDING', async () => {
    await seedUpdate('pending');
    const res = await submit(R_APPROVED, { body: BODY });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: ApiErrorCode.REVIEW_UPDATE_PENDING,
      details: { status: 'pending' },
    });
    expect(await auditRows()).toEqual([]);
  });

  it('maps a pending row that races past the pre-check onto the same 409', async () => {
    const factory = wrappedFactory(t.factory, async (attempt, run) => {
      if (attempt === 1) await seedUpdate('pending');
      return run();
    });
    const res = await submit(R_APPROVED, { body: BODY }, { factory });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_UPDATE_PENDING);
    expect(await auditRows()).toEqual([]);
  });

  it('allows another update after a decision', async () => {
    await seedUpdate('rejected', { rejectionReason: 'No.' });
    await seedUpdate('approved', { publishedAt: '2026-09-01T00:00:00.000Z' });
    expect((await submit(R_APPROVED, { body: BODY })).status).toBe(201);
  });

  it('refuses a suspended vendor seat with 403 VENDOR_SUSPENDED', async () => {
    await t.db.update(reviews).set({ reviewerId: SEAT }).where(eq(reviews.id, R_APPROVED));
    await t.db.insert(vendorSuspensions).values({
      id: uuid(700),
      vendorId: VENDOR,
      kind: 'breach',
      rule: 'billing',
      evidence: 'Unpaid invoice.',
      reason: 'Billing.',
      suspendedAt: '2026-09-01T00:00:00.000Z',
      suspendedBy: ADMIN,
    } as typeof vendorSuspensions.$inferInsert);
    const res = await submit(
      R_APPROVED,
      { body: BODY },
      { auth: authFor(SEAT, { role: 'vendor_admin', vendorId: VENDOR }) },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(ApiErrorCode.VENDOR_SUSPENDED);
    expect(await updateRows()).toEqual([]);
  });

  it('refuses a body that is not JSON', async () => {
    expect((await submit(R_APPROVED, 'not json')).status).toBe(400);
  });
});

// ─── GET /api/account/reviews ───────────────────────────────────────────────

describe('GET /api/account/reviews — updates[] (AECI-1613)', () => {
  async function accountList(userId = OWNER) {
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.use('*', async (c, nxt) => {
      c.set('auth', authFor(userId));
      await nxt();
    });
    a.get('/api/account/reviews', createGetAccountReviewsHandler(t.factory));
    const res = await a.request('/api/account/reviews', {}, TEST_ENV, fakeExecutionContext());
    return (await res.json()) as JsonBody;
  }

  it('carries every status of the caller’s own updates, oldest first, and [] elsewhere', async () => {
    await seedUpdate('rejected', {
      rejectionReason: 'It follows an incentive.',
      createdAt: '2026-09-01T00:00:00.000Z',
      moderatedBy: ADMIN,
    });
    await seedUpdate('pending', { createdAt: '2026-09-02T00:00:00.000Z' });
    const body = await accountList();
    const approved = body.data.find((r: JsonBody) => r.id === R_APPROVED);
    expect(approved.updates.map((u: JsonBody) => u.status)).toEqual(['rejected', 'pending']);
    expect(approved.updates[0]).toMatchObject({ rejection_reason: 'It follows an incentive.' });
    expect(approved.updates[0]).not.toHaveProperty('moderated_by');
    expect(approved.updates[0]).not.toHaveProperty('toxicity_score');
    expect(body.data.find((r: JsonBody) => r.id === R_PENDING).updates).toEqual([]);
    // Another reviewer never sees them.
    expect((await accountList(OTHER)).data[0].updates).toEqual([]);
  });
});

// ─── The public reads ───────────────────────────────────────────────────────

describe('public reads carry approved updates only (AECI-1613)', () => {
  async function seedEvery() {
    await seedUpdate('approved', {
      id: uuid(802),
      body: 'Second approved update.',
      ratingOverall: null,
      ratingOnboarding: null,
      publishedAt: '2026-09-05T00:00:00.000Z',
    });
    await seedUpdate('approved', {
      id: uuid(801),
      body: 'First approved update.',
      publishedAt: '2026-09-04T00:00:00.000Z',
    });
    await seedUpdate('pending', { body: 'Pending update.' });
    await seedUpdate('rejected', { body: 'Rejected update.' });
    await seedUpdate('removed', { body: 'Removed update.' });
  }

  const EXPECTED = [
    {
      body: 'First approved update.',
      rating_overall: 4,
      rating_onboarding: 4,
      published_at: '2026-09-04T00:00:00.000Z',
    },
    {
      body: 'Second approved update.',
      rating_overall: null,
      rating_onboarding: null,
      published_at: '2026-09-05T00:00:00.000Z',
    },
  ];

  it('GET /api/products/:slug/reviews: oldest first, original fields unchanged, no reviewer data', async () => {
    await seedEvery();
    const a = new Hono<{ Bindings: Env }>();
    a.onError(errorHandler());
    a.get('/api/products/:slug/reviews', createProductReviewsListHandler(t.factory));
    const res = await a.request(
      '/api/products/revit/reviews',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = (await res.json()) as JsonBody;
    expect(() => ProductReviewsResponseSchema.parse(body)).not.toThrow();
    // Review order is unchanged: newest first.
    expect(body.data.map((r: JsonBody) => r.id)).toEqual([R_APPROVED, R_OTHER]);
    const [mine, other] = body.data;
    expect(mine).toMatchObject({ rating_overall: 2, rating_onboarding: 3 });
    expect(mine.updates).toEqual(EXPECTED);
    expect(other.updates).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(OWNER);
  });

  it('the ProductDetail embed carries the same lists', async () => {
    await seedEvery();
    const a = new Hono<{ Bindings: Env }>();
    a.onError(errorHandler());
    a.get('/api/products/:slug', createProductDetailHandler(t.factory));
    const res = await a.request('/api/products/revit', {}, TEST_ENV, fakeExecutionContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as JsonBody;
    const mine = body.reviews.find((r: JsonBody) => r.id === R_APPROVED);
    expect(mine).toMatchObject({ rating_overall: 2, rating_onboarding: 3 });
    expect(mine.updates).toEqual(EXPECTED);
  });

  it('hides an approved update when its review leaves approved', async () => {
    await seedEvery();
    await t.db.update(reviews).set({ status: 'archived' }).where(eq(reviews.id, R_APPROVED));
    await t.db.update(reviews).set({ status: 'approved' }).where(eq(reviews.id, R_OTHER));
    const a = new Hono<{ Bindings: Env }>();
    a.get('/api/products/:slug/reviews', createProductReviewsListHandler(t.factory));
    const res = await a.request(
      '/api/products/revit/reviews',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = (await res.json()) as JsonBody;
    expect(body.data.flatMap((r: JsonBody) => r.updates)).toEqual([]);
  });
});
