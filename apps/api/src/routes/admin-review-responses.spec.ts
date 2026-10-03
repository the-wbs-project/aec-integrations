/**
 * AECI-1177 — the admin queue for vendor replies to reviews
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c, `ADMIN_PANEL_SPEC.md` §5.13).
 *
 * The handlers over the in-memory D1. What this file pins:
 *
 *   - the queue: pending by default, oldest first, hydrated with the review, the
 *     product, the vendor and the author's email, and the ownership warning;
 *   - every admin transition of §11c.6, with its audit row in the same batch;
 *   - every other from-state is `409 REVIEW_RESPONSE_WRONG_STATE` and writes nothing;
 *   - reject and remove require a reason;
 *   - the purge directive is queued on approve and remove only;
 *   - each decision writes one `review_response` feed row to the reply's vendor,
 *     in the same batch, and only that vendor reads it (AECI-1180, §11c.12);
 *   - a lost race writes nothing (§11c.7);
 *   - the guard is status PLUS version: a decision naming an `updated_at` the vendor
 *     has since replaced (an edit, or a withdraw-and-resubmit) is
 *     `409 REVIEW_RESPONSE_CHANGED` and writes nothing (§11c.7);
 *   - no decision touches `reviews`, a count, or a workflow row (§11c.10);
 *   - the deny matrix on both verbs, through the real `requireAdmin()` guard.
 */

import {
  AdminReviewResponseSchema,
  ApiErrorCode,
  ListAdminReviewResponsesResponseSchema,
  REVIEW_RESPONSE_STATUSES,
  type ReviewResponseDecision,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { requireAdmin, type AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestJwks, type TestJwks } from '../test/auth';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { racingFactory } from '../test/racing-factory';
import {
  createAdminReviewResponsesListHandler,
  createDecideReviewResponseHandler,
  reviewResponseDecisionNotifications,
  type FetchAuthorEmails,
} from './admin-review-responses';
import { createListVendorNotificationsHandler } from './vendor-notifications';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2); // owned P_A once; its product_vendors row is gone
const P_A = uuid(10);
const R1 = uuid(30);
const R2 = uuid(31);
const R3 = uuid(32);
const SEAT_A = uuid(100);
const SEAT_B = uuid(101);
const ADMIN = uuid(105);
const REVIEWER = uuid(106);

const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-02T00:00:00.000Z';
const T2 = '2026-09-03T00:00:00.000Z';

type Auth = AuthzVariables['auth'];
const ADMIN_AUTH: Auth = {
  userId: ADMIN,
  email: 'admin@example.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: null,
  entitlement: null,
} as unknown as Auth;

let t: TestDb;
let nextReply = 0;

beforeEach(async () => {
  nextReply = 0;
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db
    .insert(products)
    .values({ id: P_A, slug: 'revit', name: 'Revit', reviewCount: 3, ratingOverallAvg: 4 });
  await t.db.insert(productVendors).values({ productId: P_A, vendorId: VENDOR_A, isPrimary: true });
  await t.db.insert(profiles).values([
    { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR_A },
    { id: SEAT_B, role: 'vendor_admin', vendorId: VENDOR_B },
    { id: ADMIN, role: 'admin' },
    { id: REVIEWER, role: 'reviewer' },
  ]);
  const review = (id: string, createdAt: string) => ({
    id,
    productId: P_A,
    ratingOverall: 4,
    ratingOnboarding: 3,
    title: `Review ${id.slice(-2)}`,
    body: 'A long enough review body.',
    status: 'approved',
    createdAt,
    updatedAt: createdAt,
  });
  await t.db
    .insert(reviews)
    .values([
      review(R1, '2026-08-01T00:00:00.000Z'),
      review(R2, '2026-08-02T00:00:00.000Z'),
      review(R3, '2026-08-03T00:00:00.000Z'),
    ]);
});
afterEach(() => t.dispose());

/** Seed a reply directly, in a given status. */
async function seedReply(
  reviewId: string,
  status: string,
  extra: Partial<typeof reviewResponses.$inferInsert> = {},
): Promise<string> {
  const id = extra.id ?? uuid(500 + nextReply++);
  await t.db.insert(reviewResponses).values({
    id,
    reviewId,
    vendorId: VENDOR_A,
    authorProfileId: SEAT_A,
    body: 'Thanks for the review. We fixed it.',
    status,
    createdAt: T0,
    updatedAt: T0,
    ...(status === 'published' ? { publishedAt: T0, moderatedBy: ADMIN, moderatedAt: T0 } : {}),
    ...(status === 'rejected' || status === 'removed'
      ? { rejectionReason: 'Earlier reason.', moderatedBy: ADMIN, moderatedAt: T0 }
      : {}),
    ...extra,
  });
  return id;
}

const fakeEmails: FetchAuthorEmails = async (_env, ids) =>
  new Map(ids.map((id) => [id, `${id.slice(-3)}@vendor.test`]));

function app(factory: DbFactory = t.factory, emails: FetchAuthorEmails = fakeEmails) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', ADMIN_AUTH);
    await next();
  });
  a.get('/api/admin/review-responses', createAdminReviewResponsesListHandler(factory, emails));
  a.patch('/api/admin/review-responses/:id', createDecideReviewResponseHandler(factory, emails));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
  opts: { factory?: DbFactory; emails?: FetchAuthorEmails } = {},
): Promise<{ status: number; body: JsonBody; send: ReturnType<typeof vi.fn> }> {
  const send = vi.fn().mockResolvedValue(undefined);
  const env: Env = {
    ...TEST_ENV,
    CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
  };
  const execCtx = fakeExecutionContext();
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await app(opts.factory, opts.emails).request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send };
}

const list = (query = '', opts?: { emails?: FetchAuthorEmails }) =>
  call('GET', `/api/admin/review-responses${query}`, undefined, opts);
const decide = (id: string, body: unknown, factory?: DbFactory) =>
  call('PATCH', `/api/admin/review-responses/${id}`, body, { factory });

const replyRow = async (id: string) =>
  (await t.db.select().from(reviewResponses).where(eq(reviewResponses.id, id)))[0]!;
const auditRows = () => t.db.select().from(auditLog);
/** The decision's own audit rows, without the vendor's feed row (AECI-1180). */
const decisionAudits = async () =>
  (await auditRows()).filter((r) => r.action !== 'notification.sent');
/** The vendor feed rows a decision wrote (AECI-1180, §11c.12). */
const feedRows = async () => (await auditRows()).filter((r) => r.action === 'notification.sent');

/** `reviews`, the product's count columns and the workflow tables. */
async function firewallSnapshot() {
  return {
    reviews: await t.db.select().from(reviews),
    product: await t.db.select().from(products).where(eq(products.id, P_A)),
    workflows: await t.db.select().from(workflowInstances),
    transitions: await t.db.select().from(workflowTransitions),
  };
}

/** Every seeded reply's version unless a test says otherwise. */
const V0 = { expected_updated_at: T0 };

const REASONED: Record<ReviewResponseDecision, Record<string, string>> = {
  approve: { decision: 'approve', ...V0 },
  reject: { decision: 'reject', reason: 'It names the reviewer.', ...V0 },
  remove: { decision: 'remove', reason: 'It is a sales pitch.', ...V0 },
};

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/review-responses', () => {
  it('lists pending replies by default, oldest first, fully hydrated', async () => {
    const newer = await seedReply(R1, 'pending', { updatedAt: T2 });
    const older = await seedReply(R2, 'pending', { updatedAt: T1 });
    await seedReply(R3, 'published');

    const res = await list();
    expect(res.status).toBe(200);
    expect(() => ListAdminReviewResponsesResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.total).toBe(2);
    expect(res.body.data.map((r: JsonBody) => r.id)).toEqual([older, newer]);
    expect(res.body.data[0]).toMatchObject({
      status: 'pending',
      body: 'Thanks for the review. We fixed it.',
      rejection_reason: null,
      vendor: { id: VENDOR_A, slug: 'autodesk', name: 'Autodesk' },
      vendor_owns_product: true,
      author_email: '100@vendor.test',
      product: { id: P_A, slug: 'revit', name: 'Revit' },
      review: {
        id: R2,
        status: 'approved',
        title: 'Review 31',
        rating_overall: 4,
        rating_onboarding: 3,
      },
      updated_at: T1,
    });
  });

  it('breaks an updated_at tie by id', async () => {
    const b = await seedReply(R1, 'pending', { id: uuid(902), updatedAt: T1 });
    const a = await seedReply(R2, 'pending', { id: uuid(901), updatedAt: T1 });
    expect((await list()).body.data.map((r: JsonBody) => r.id)).toEqual([a, b]);
  });

  it.each(REVIEW_RESPONSE_STATUSES)('filters on status=%s', async (status) => {
    // One row per status, on distinct (review, vendor) pairs: the pair is unique.
    const slots: Record<string, [string, string]> = {
      pending: [R1, VENDOR_A],
      published: [R2, VENDOR_A],
      rejected: [R3, VENDOR_A],
      withdrawn: [R1, VENDOR_B],
      removed: [R2, VENDOR_B],
    };
    for (const s of REVIEW_RESPONSE_STATUSES) {
      const [reviewId, vendorId] = slots[s]!;
      await seedReply(reviewId, s, { vendorId });
    }
    const res = await list(`?status=${status}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: JsonBody) => r.status)).toEqual([status]);
  });

  it('warns when the vendor no longer owns the product, and when the review left approved', async () => {
    await seedReply(R1, 'pending', { vendorId: VENDOR_B, authorProfileId: SEAT_B });
    await t.db.update(reviews).set({ status: 'archived' }).where(eq(reviews.id, R1));
    const [row] = (await list()).body.data;
    expect(row).toMatchObject({ vendor_owns_product: false, review: { status: 'archived' } });
  });

  it('degrades author_email to null when the GoTrue seam throws, or the author is erased', async () => {
    await seedReply(R1, 'pending');
    await seedReply(R2, 'pending', { authorProfileId: null, updatedAt: T1 });
    const res = await list('', {
      emails: async () => {
        throw new Error('GoTrue down');
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: JsonBody) => r.author_email)).toEqual([null, null]);
  });

  it('refuses an unknown status', async () => {
    expect((await list('?status=approved')).status).toBe(400);
  });

  it('writes no audit row', async () => {
    await seedReply(R1, 'pending');
    await list();
    expect(await auditRows()).toEqual([]);
  });
});

// ─── PATCH: the allowed transitions ─────────────────────────────────────────

describe('PATCH /api/admin/review-responses/:id — the transitions', () => {
  it('approve: pending to published, audit in the batch, purges the product page', async () => {
    const id = await seedReply(R1, 'pending');
    const before = await firewallSnapshot();

    const res = await decide(id, { decision: 'approve', ...V0 });
    expect(res.status).toBe(200);
    expect(() => AdminReviewResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body).toMatchObject({ id, status: 'published', rejection_reason: null });
    expect(res.body.published_at).toEqual(expect.any(String));

    const row = await replyRow(id);
    expect(row).toMatchObject({ status: 'published', moderatedBy: ADMIN });
    expect(row.publishedAt).toBe(row.moderatedAt);
    expect(row.updatedAt).toBe(row.moderatedAt);

    const audits = await decisionAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'review_response.approved',
      entityType: 'review_response',
      entityId: id,
      actorId: ADMIN,
      actorType: 'admin',
      beforeState: { status: 'pending' },
      afterState: { status: 'published' },
    });
    expect(audits[0]!.metadata).toEqual({
      source: 'admin-moderation',
      vendorId: VENDOR_A,
      reviewId: R1,
      productId: P_A,
    });

    expect(res.send).toHaveBeenCalledTimes(1);
    expect(res.send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'moderation' });
    expect(await firewallSnapshot()).toEqual(before);
  });

  it('reject: pending to rejected with the reason, and NO purge', async () => {
    const id = await seedReply(R1, 'pending');
    const before = await firewallSnapshot();

    const res = await decide(id, {
      decision: 'reject',
      reason: '  It names the reviewer.  ',
      ...V0,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'rejected',
      rejection_reason: 'It names the reviewer.',
      published_at: null,
    });

    const row = await replyRow(id);
    expect(row).toMatchObject({
      status: 'rejected',
      rejectionReason: 'It names the reviewer.',
      moderatedBy: ADMIN,
      publishedAt: null,
    });
    const [audit] = await decisionAudits();
    expect(audit).toMatchObject({
      action: 'review_response.rejected',
      beforeState: { status: 'pending' },
      afterState: { status: 'rejected', rejection_reason: 'It names the reviewer.' },
    });
    expect(audit!.metadata).toMatchObject({ reason: 'It names the reviewer.' });
    expect(res.send).not.toHaveBeenCalled();
    expect(await firewallSnapshot()).toEqual(before);
  });

  it('remove: published to removed, clears published_at, purges the product page', async () => {
    const id = await seedReply(R1, 'published');
    const before = await firewallSnapshot();

    const res = await decide(id, { decision: 'remove', reason: 'It is a sales pitch.', ...V0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'removed',
      rejection_reason: 'It is a sales pitch.',
      published_at: null,
    });

    const row = await replyRow(id);
    expect(row).toMatchObject({
      status: 'removed',
      rejectionReason: 'It is a sales pitch.',
      publishedAt: null,
      moderatedBy: ADMIN,
    });
    const [audit] = await decisionAudits();
    expect(audit).toMatchObject({
      action: 'review_response.removed',
      beforeState: { status: 'published' },
      afterState: { status: 'removed', rejection_reason: 'It is a sales pitch.' },
    });
    expect(res.send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'moderation' });
    expect(await firewallSnapshot()).toEqual(before);
  });

  it('builds one `review_response` feed row for the reply’s vendor (AECI-1180)', () => {
    const entries = reviewResponseDecisionNotifications({
      responseId: uuid(700),
      decision: 'remove',
      vendorId: VENDOR_A,
      reviewId: R1,
      product: { id: P_A, slug: 'revit', name: 'Revit' },
      reason: 'It is a sales pitch.',
      actor: { actorId: ADMIN, actorType: 'admin' },
    });
    expect(entries).toEqual([
      {
        actorId: ADMIN,
        actorType: 'admin',
        action: 'notification.sent',
        entityType: 'review_response',
        entityId: uuid(700),
        metadata: {
          kind: 'review_response',
          notificationId: 'portal-review-response',
          vendorId: VENDOR_A,
          event: 'removed',
          responseId: uuid(700),
          reviewId: R1,
          productId: P_A,
          product: { slug: 'revit', name: 'Revit' },
          reason: 'It is a sales pitch.',
        },
      },
    ]);
  });

  it.each([
    { decision: 'approve' as const, from: 'pending', event: 'approved', reason: undefined },
    {
      decision: 'reject' as const,
      from: 'pending',
      event: 'rejected',
      reason: 'It names the reviewer.',
    },
    {
      decision: 'remove' as const,
      from: 'published',
      event: 'removed',
      reason: 'It is a sales pitch.',
    },
  ])(
    '$decision writes one feed row to the reply’s vendor in the decision batch',
    async ({ decision, from, event, reason }) => {
      const id = await seedReply(R1, from);
      expect((await decide(id, REASONED[decision])).status).toBe(200);

      const feed = await feedRows();
      expect(feed).toHaveLength(1);
      expect(feed[0]).toMatchObject({
        actorId: ADMIN,
        entityType: 'review_response',
        entityId: id,
      });
      expect(feed[0]!.metadata).toEqual({
        kind: 'review_response',
        notificationId: 'portal-review-response',
        vendorId: VENDOR_A,
        event,
        responseId: id,
        reviewId: R1,
        productId: P_A,
        product: { slug: 'revit', name: 'Revit' },
        ...(reason ? { reason } : {}),
      });
    },
  );

  it('the decision row reaches the reply’s vendor feed, and no other vendor’s', async () => {
    const id = await seedReply(R1, 'pending');
    expect((await decide(id, REASONED.reject)).status).toBe(200);

    const read = async (vendorId: string) => {
      const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
      a.onError(errorHandler());
      a.use('*', async (c, next) => {
        c.set('auth', { ...ADMIN_AUTH, role: 'vendor_admin', vendorId } as Auth);
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
      return ((await res.json()) as JsonBody).notifications as JsonBody[];
    };

    expect(await read(VENDOR_A)).toEqual([
      {
        kind: 'review_response',
        id: expect.any(String),
        event: 'rejected',
        response_id: id,
        review_id: R1,
        product: { slug: 'revit', name: 'Revit' },
        reason: 'It names the reviewer.',
        created_at: expect.any(String),
      },
    ]);
    expect(await read(VENDOR_B)).toEqual([]);
  });
});

// ─── PATCH: the refusals ─────────────────────────────────────────────────────

describe('PATCH /api/admin/review-responses/:id — the refusals', () => {
  const ALLOWED: Record<ReviewResponseDecision, string> = {
    approve: 'pending',
    reject: 'pending',
    remove: 'published',
  };
  const REFUSED = (Object.keys(ALLOWED) as ReviewResponseDecision[]).flatMap((decision) =>
    REVIEW_RESPONSE_STATUSES.filter((s) => s !== ALLOWED[decision]).map((status) => ({
      decision,
      status,
    })),
  );

  it.each(REFUSED)(
    '$decision on a $status reply is 409 REVIEW_RESPONSE_WRONG_STATE and writes nothing',
    async ({ decision, status }) => {
      const id = await seedReply(R1, status);
      const before = await replyRow(id);

      const res = await decide(id, REASONED[decision]);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_WRONG_STATE);
      expect(res.body.error.details).toEqual({ status });
      expect(await replyRow(id)).toEqual(before);
      expect(await auditRows()).toEqual([]);
      expect(res.send).not.toHaveBeenCalled();
    },
  );

  it.each(['reject', 'remove'] as const)('%s without a reason is a 400', async (decision) => {
    const id = await seedReply(R1, decision === 'remove' ? 'published' : 'pending');
    for (const body of [
      { decision, ...V0 },
      { decision, reason: '', ...V0 },
      { decision, reason: '   ', ...V0 },
    ]) {
      const res = await decide(id, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    }
    expect(await auditRows()).toEqual([]);
  });

  it('refuses a reason over 1,000 characters, an unknown decision, and bad JSON', async () => {
    const id = await seedReply(R1, 'pending');
    expect((await decide(id, { decision: 'reject', reason: 'x'.repeat(1001), ...V0 })).status).toBe(
      400,
    );
    expect((await decide(id, { decision: 'withdraw', ...V0 })).status).toBe(400);
    expect((await decide(id, '{not json')).status).toBe(400);
    expect((await replyRow(id)).status).toBe('pending');
  });

  it('answers 404 for an unknown id', async () => {
    const res = await decide(uuid(999), { decision: 'approve', ...V0 });
    expect(res.status).toBe(404);
  });

  it('a lost race writes nothing, purges nothing, and answers 409 with the status that won', async () => {
    const id = await seedReply(R1, 'pending');
    // The vendor withdraws between the handler's read and its batch.
    const racing = racingFactory(t.factory, async () => {
      await t.db
        .update(reviewResponses)
        .set({ status: 'withdrawn' })
        .where(eq(reviewResponses.id, id));
    });
    const res = await decide(id, { decision: 'approve', ...V0 }, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_WRONG_STATE);
    expect(res.body.error.details).toEqual({ status: 'withdrawn' });
    expect(await replyRow(id)).toMatchObject({ status: 'withdrawn', publishedAt: null });
    expect(await auditRows()).toEqual([]);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('a second approve is refused, so one decision audits once', async () => {
    const id = await seedReply(R1, 'pending');
    expect((await decide(id, { decision: 'approve', ...V0 })).status).toBe(200);
    const again = await decide(id, { decision: 'approve', ...V0 });
    expect(again.status).toBe(409);
    expect(again.body.error.details).toEqual({ status: 'published' });
    expect(await decisionAudits()).toHaveLength(1);
  });

  it('refuses a decision without expected_updated_at with a 400 (§11c.7)', async () => {
    const id = await seedReply(R1, 'pending');
    const res = await decide(id, { decision: 'approve' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect((await replyRow(id)).status).toBe('pending');
  });
});

// ─── PATCH: the version guard (§11c.7) ───────────────────────────────────────

describe('PATCH /api/admin/review-responses/:id — the version guard', () => {
  /** Nothing the decision would write is there: no column moved, no audit row,
   *  no feed row, no purge. */
  async function expectNothingWritten(
    id: string,
    res: Awaited<ReturnType<typeof decide>>,
    vendorRow: Awaited<ReturnType<typeof replyRow>>,
  ) {
    expect(await replyRow(id)).toEqual(vendorRow);
    expect(await decisionAudits()).toEqual([]);
    expect(await feedRows()).toEqual([]);
    expect(res.send).not.toHaveBeenCalled();
  }

  it('the vendor edits a pending reply after the admin loaded the queue: 409 CHANGED', async () => {
    const id = await seedReply(R1, 'pending');
    const queue = await list();
    const seen = (queue.body.data as JsonBody[]).find((r) => r.id === id)!;
    expect(seen.updated_at).toBe(T0);

    // The vendor's PATCH: same status, new body, new updated_at.
    await t.db
      .update(reviewResponses)
      .set({ body: 'A different reply the admin never read.', updatedAt: T1 })
      .where(eq(reviewResponses.id, id));
    const edited = await replyRow(id);

    const res = await decide(id, { decision: 'approve', expected_updated_at: seen.updated_at });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_CHANGED);
    expect(res.body.error.details).toEqual({ status: 'pending', updated_at: T1 });
    await expectNothingWritten(id, res, edited);
  });

  it('the vendor edits a pending reply inside the batch window: the sentinel rolls back, 409 CHANGED', async () => {
    const id = await seedReply(R1, 'pending');
    const racing = racingFactory(t.factory, async () => {
      await t.db
        .update(reviewResponses)
        .set({ body: 'Edited between the read and the batch.', updatedAt: T1 })
        .where(eq(reviewResponses.id, id));
    });

    const res = await decide(id, REASONED.approve, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_CHANGED);
    expect(res.body.error.details).toEqual({ status: 'pending', updated_at: T1 });
    const row = await replyRow(id);
    expect(row).toMatchObject({
      status: 'pending',
      body: 'Edited between the read and the batch.',
      moderatedBy: null,
      publishedAt: null,
    });
    await expectNothingWritten(id, res, row);
  });

  it('a withdraw-and-resubmit after the admin read: back to pending, still 409 CHANGED', async () => {
    const id = await seedReply(R1, 'pending');
    // Withdraw at T1, resubmit with new text at T2. The status ends where it began.
    await t.db
      .update(reviewResponses)
      .set({ status: 'withdrawn', updatedAt: T1 })
      .where(eq(reviewResponses.id, id));
    await t.db
      .update(reviewResponses)
      .set({ status: 'pending', body: 'The resubmitted text.', updatedAt: T2 })
      .where(eq(reviewResponses.id, id));
    const resubmitted = await replyRow(id);

    const res = await decide(id, REASONED.reject);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_CHANGED);
    expect(res.body.error.details).toEqual({ status: 'pending', updated_at: T2 });
    await expectNothingWritten(id, res, resubmitted);
  });

  it('a withdraw-and-resubmit inside the batch window: rolled back, 409 CHANGED', async () => {
    const id = await seedReply(R1, 'pending');
    const racing = racingFactory(t.factory, async () => {
      await t.db
        .update(reviewResponses)
        .set({ status: 'withdrawn', updatedAt: T1 })
        .where(eq(reviewResponses.id, id));
      await t.db
        .update(reviewResponses)
        .set({ status: 'pending', body: 'The resubmitted text.', updatedAt: T2 })
        .where(eq(reviewResponses.id, id));
    });

    const res = await decide(id, REASONED.approve, racing);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_CHANGED);
    const row = await replyRow(id);
    expect(row).toMatchObject({ status: 'pending', updatedAt: T2, publishedAt: null });
    await expectNothingWritten(id, res, row);
  });

  it('a stale expected_updated_at on remove of a published reply: 409 CHANGED, still published', async () => {
    // Edited and re-approved since the admin's copy: published, but at T1.
    const id = await seedReply(R1, 'published', {
      updatedAt: T1,
      moderatedAt: T1,
      publishedAt: T1,
    });
    const before = await replyRow(id);

    const res = await decide(id, REASONED.remove);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_CHANGED);
    expect(res.body.error.details).toEqual({ status: 'published', updated_at: T1 });
    await expectNothingWritten(id, res, before);
  });

  it('a wrong status still wins over a stale version: 409 WRONG_STATE', async () => {
    const id = await seedReply(R1, 'withdrawn', { updatedAt: T1 });
    const res = await decide(id, REASONED.approve);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(ApiErrorCode.REVIEW_RESPONSE_WRONG_STATE);
  });

  it('the current version decides normally', async () => {
    const id = await seedReply(R1, 'pending', { updatedAt: T1 });
    const res = await decide(id, { decision: 'approve', expected_updated_at: T1 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('published');
  });
});

// ─── Authorization ───────────────────────────────────────────────────────────

describe('/api/admin/review-responses — authorization', () => {
  const SUPABASE_URL = 'https://test-project.supabase.co';
  const AUTHZ_ENV = { ENV: 'preview', SUPABASE_URL } as Env;

  let jwks: TestJwks;
  beforeAll(async () => {
    jwks = await makeTestJwks();
  });

  function guarded() {
    const guard = { getKey: jwks.getKey, dbFor: t.factory };
    const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
    a.onError(errorHandler());
    a.get(
      '/api/admin/review-responses',
      requireAdmin(guard),
      createAdminReviewResponsesListHandler(t.factory, fakeEmails),
    );
    a.patch(
      '/api/admin/review-responses/:id',
      requireAdmin(guard),
      createDecideReviewResponseHandler(t.factory, fakeEmails),
    );
    return a;
  }

  const request = (path: string, method: 'GET' | 'PATCH', token?: string) =>
    guarded().request(
      path,
      {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(method === 'PATCH' ? { body: JSON.stringify({ decision: 'approve', ...V0 }) } : {}),
      },
      AUTHZ_ENV,
      fakeExecutionContext(),
    );
  const token = (sub: string) => jwks.mintToken({ sub, supabaseUrl: SUPABASE_URL });

  it('401s an anonymous caller on both verbs', async () => {
    const id = await seedReply(R1, 'pending');
    expect((await request('/api/admin/review-responses', 'GET')).status).toBe(401);
    expect((await request(`/api/admin/review-responses/${id}`, 'PATCH')).status).toBe(401);
    expect((await replyRow(id)).status).toBe('pending');
  });

  it.each([
    ['a reviewer', REVIEWER],
    ['a vendor seat', SEAT_A],
  ])('403s %s on both verbs, and decides nothing', async (_who, sub) => {
    const id = await seedReply(R1, 'pending');
    const tk = await token(sub);
    expect((await request('/api/admin/review-responses', 'GET', tk)).status).toBe(403);
    expect((await request(`/api/admin/review-responses/${id}`, 'PATCH', tk)).status).toBe(403);
    expect((await replyRow(id)).status).toBe('pending');
    expect(await auditRows()).toEqual([]);
  });

  it('lets an admin through on both verbs', async () => {
    const id = await seedReply(R1, 'pending');
    const tk = await token(ADMIN);
    expect((await request('/api/admin/review-responses', 'GET', tk)).status).toBe(200);
    expect((await request(`/api/admin/review-responses/${id}`, 'PATCH', tk)).status).toBe(200);
    expect((await replyRow(id)).status).toBe('published');
  });
});
