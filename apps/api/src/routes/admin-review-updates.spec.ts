/**
 * AECI-1613 — the admin queue for reviewer updates to published reviews
 * (`STAGE_1_SPEC.md` §4.7a, `ADMIN_PANEL_SPEC.md` §5.20).
 *
 * The handlers over the in-memory D1. What this file pins:
 *
 *   - the queue: pending by default, oldest first, the original review beside each
 *     update, the reviewer's address, and no rate limit or audit on the read;
 *   - each transition, with its audit row in the same batch;
 *   - every other from-state is `409 REVIEW_UPDATE_WRONG_STATE` and writes nothing;
 *   - reject and remove require a reason;
 *   - approve and remove recompute the averages and queue the purge; reject does not;
 *   - approve writes one `review_update` feed row per owning vendor, readable by that
 *     vendor only;
 *   - approve and reject email the reviewer on `review-update-decision:{id}`; remove
 *     emails no one;
 *   - a lost race writes nothing and sends nothing;
 *   - no decision writes `reviews` or a workflow row.
 */

import {
  AdminReviewUpdateSchema,
  ApiErrorCode,
  ListAdminReviewUpdatesResponseSchema,
  REVIEW_UPDATE_STATUSES,
  type ReviewUpdateDecision,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  productVendors,
  products,
  profiles,
  reviewUpdates,
  reviews,
  vendors,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { sendReviewUpdateApprovedEmail, sendReviewUpdateRejectedEmail } from '../lib/email';
import type { DbFactory } from '../lib/handler-utils';
import { recomputeProductCounts } from '../lib/recompute-counts';
import { makeTestDb, type TestDb } from '../test/d1';
import { TEST_ENV, fakeExecutionContext } from '../test/helpers';
import { racingFactory } from '../test/racing-factory';
import {
  createAdminReviewUpdatesListHandler,
  createDecideReviewUpdateHandler,
  type FetchReviewerEmails,
} from './admin-review-updates';
import { createListVendorNotificationsHandler } from './vendor-notifications';

vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/email')>()),
  sendReviewUpdateApprovedEmail: vi.fn(async () => 'sent'),
  sendReviewUpdateRejectedEmail: vi.fn(async () => 'sent'),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const VENDOR_A = uuid(1);
const VENDOR_B = uuid(2);
const VENDOR_C = uuid(3); // owns another product only
const P_A = uuid(10);
const R1 = uuid(30);
const R2 = uuid(31);
const R3 = uuid(32);
const ADMIN = uuid(105);
const REVIEWER = uuid(106);

const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-02T00:00:00.000Z';
const T2 = '2026-09-03T00:00:00.000Z';

type Auth = AuthzVariables['auth'];
const ADMIN_AUTH = {
  userId: ADMIN,
  email: 'admin@example.test',
  role: 'admin',
  vendorId: null,
  entitlementTier: null,
  entitlement: null,
} as unknown as Auth;

let t: TestDb;
let next = 0;

beforeEach(async () => {
  next = 0;
  vi.mocked(sendReviewUpdateApprovedEmail).mockClear();
  vi.mocked(sendReviewUpdateRejectedEmail).mockClear();
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR_A, slug: 'autodesk', companyName: 'Autodesk' },
    { id: VENDOR_B, slug: 'bentley', companyName: 'Bentley' },
    { id: VENDOR_C, slug: 'trimble', companyName: 'Trimble' },
  ]);
  await t.db.insert(products).values({ id: P_A, slug: 'revit', name: 'Revit' });
  await t.db.insert(productVendors).values([
    { productId: P_A, vendorId: VENDOR_A, isPrimary: true },
    { productId: P_A, vendorId: VENDOR_B, isPrimary: false },
  ]);
  await t.db.insert(profiles).values([
    { id: ADMIN, role: 'admin' },
    { id: REVIEWER, role: 'reviewer' },
  ]);
  const review = (id: string, overall: number, createdAt: string) => ({
    id,
    productId: P_A,
    reviewerId: id === R1 ? REVIEWER : null,
    ratingOverall: overall,
    ratingOnboarding: overall,
    title: `Review ${id.slice(-2)}`,
    body: 'The original review body, long enough to read.',
    status: 'approved',
    createdAt,
    updatedAt: createdAt,
  });
  await t.db
    .insert(reviews)
    .values([
      review(R1, 2, '2026-08-01T00:00:00.000Z'),
      review(R2, 4, '2026-08-02T00:00:00.000Z'),
      review(R3, 3, '2026-08-03T00:00:00.000Z'),
    ]);
});
afterEach(() => t.dispose());

async function seedUpdate(
  reviewId: string,
  status: string,
  extra: Partial<typeof reviewUpdates.$inferInsert> = {},
): Promise<string> {
  const id = extra.id ?? uuid(500 + next++);
  await t.db.insert(reviewUpdates).values({
    id,
    reviewId,
    body: 'The vendor fixed the problem I described, so here is my update.',
    ratingOverall: 5,
    ratingOnboarding: 5,
    status,
    toxicityScore: 0,
    createdAt: T0,
    updatedAt: T0,
    ...(status === 'approved' ? { publishedAt: T0, moderatedBy: ADMIN, moderatedAt: T0 } : {}),
    ...(status === 'rejected' || status === 'removed'
      ? { rejectionReason: 'Earlier reason.', moderatedBy: ADMIN, moderatedAt: T0 }
      : {}),
    ...extra,
  });
  return id;
}

const fakeEmails: FetchReviewerEmails = async (_env, ids) =>
  new Map(ids.map((id) => [id, `${id.slice(-3)}@reviewer.test`]));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
  opts: { factory?: DbFactory; emails?: FetchReviewerEmails } = {},
) {
  const send = vi.fn().mockResolvedValue(undefined);
  const recompute = vi.fn(recomputeProductCounts);
  const factory = opts.factory ?? t.factory;
  const emails = opts.emails ?? fakeEmails;
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, nxt) => {
    c.set('auth', ADMIN_AUTH);
    await nxt();
  });
  a.get('/api/admin/review-updates', createAdminReviewUpdatesListHandler(factory, emails));
  a.patch(
    '/api/admin/review-updates/:id',
    createDecideReviewUpdateHandler(factory, emails, recompute),
  );
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
  const res = await a.request(path, init, env, execCtx);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: (await res.json()) as JsonBody, send, recompute };
}

const list = (query = '', emails?: FetchReviewerEmails) =>
  call('GET', `/api/admin/review-updates${query}`, undefined, { emails });
const decide = (id: string, body: unknown, factory?: DbFactory) =>
  call('PATCH', `/api/admin/review-updates/${id}`, body, { factory });

const updateRow = async (id: string) =>
  (await t.db.select().from(reviewUpdates).where(eq(reviewUpdates.id, id)))[0]!;
const auditRows = () => t.db.select().from(auditLog);
const decisionAudits = async () =>
  (await auditRows()).filter((r) => r.action !== 'notification.sent');
const feedRows = async () => (await auditRows()).filter((r) => r.action === 'notification.sent');
const product = async () => (await t.db.select().from(products).where(eq(products.id, P_A)))[0]!;

const BODIES: Record<ReviewUpdateDecision, JsonBody> = {
  approve: { action: 'approve' },
  reject: { action: 'reject', reason: 'It follows an incentive.' },
  remove: { action: 'remove', reason: 'The reviewer asked us to.' },
};

// ─── GET ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/review-updates', () => {
  it('lists pending updates by default, oldest first, with the original review beside each', async () => {
    const newer = await seedUpdate(R1, 'pending', { createdAt: T2 });
    const older = await seedUpdate(R2, 'pending', {
      createdAt: T1,
      ratingOverall: null,
      ratingOnboarding: null,
    });
    await seedUpdate(R3, 'approved');

    const res = await list();
    expect(res.status).toBe(200);
    expect(() => ListAdminReviewUpdatesResponseSchema.parse(res.body)).not.toThrow();
    expect(res.body.total).toBe(2);
    expect(res.body.data.map((r: JsonBody) => r.id)).toEqual([older, newer]);
    expect(res.body.data[1]).toMatchObject({
      status: 'pending',
      rating_overall: 5,
      rating_onboarding: 5,
      toxicity_score: 0,
      reviewer_email: '106@reviewer.test',
      product: { id: P_A, slug: 'revit', name: 'Revit' },
      review: { id: R1, status: 'approved', title: 'Review 30', rating_overall: 2 },
    });
    // An anonymous review has no address, and a rating-less update carries nulls.
    expect(res.body.data[0]).toMatchObject({
      reviewer_email: null,
      rating_overall: null,
      rating_onboarding: null,
    });
  });

  it.each(REVIEW_UPDATE_STATUSES)('filters on status=%s', async (status) => {
    // Pending is one per review, so each status gets its own row.
    await seedUpdate(R1, 'pending');
    await seedUpdate(R1, 'approved');
    await seedUpdate(R2, 'rejected');
    await seedUpdate(R3, 'removed');
    const res = await list(`?status=${status}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: JsonBody) => r.status)).toEqual([status]);
  });

  it('degrades reviewer_email to null when the GoTrue seam throws', async () => {
    await seedUpdate(R1, 'pending');
    const res = await list('', async () => {
      throw new Error('GoTrue down');
    });
    expect(res.status).toBe(200);
    expect(res.body.data[0].reviewer_email).toBeNull();
  });

  it('refuses an unknown status and writes no audit row', async () => {
    expect((await list('?status=published')).status).toBe(400);
    await seedUpdate(R1, 'pending');
    await list();
    expect(await auditRows()).toEqual([]);
  });
});

// ─── PATCH: the transitions ─────────────────────────────────────────────────

describe('PATCH /api/admin/review-updates/:id — the transitions', () => {
  it('approve: pending to approved, audit in the batch, averages recomputed, page purged', async () => {
    const id = await seedUpdate(R1, 'pending');
    const reviewsBefore = await t.db.select().from(reviews);

    const res = await decide(id, BODIES.approve);
    expect(res.status).toBe(200);
    expect(() => AdminReviewUpdateSchema.parse(res.body)).not.toThrow();
    expect(res.body).toMatchObject({ id, status: 'approved', rejection_reason: null });

    const row = await updateRow(id);
    expect(row).toMatchObject({ status: 'approved', moderatedBy: ADMIN });
    expect(row.publishedAt).toBe(row.moderatedAt);

    expect(await decisionAudits()).toEqual([
      expect.objectContaining({
        action: 'review_update.approved',
        entityType: 'review_update',
        entityId: id,
        productId: P_A,
      }),
    ]);
    expect(res.recompute).toHaveBeenCalledWith(expect.anything(), [P_A]);
    expect(res.send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'moderation' });

    // R1 now counts at 5/5 beside R2 (4) and R3 (3). The count does not move.
    expect(await product()).toMatchObject({ reviewCount: 3, ratingOverallAvg: 4 });
    // The original review is never written.
    expect(await t.db.select().from(reviews)).toEqual(reviewsBefore);
    expect(await t.db.select().from(workflowInstances)).toEqual([]);
    expect(await t.db.select().from(workflowTransitions)).toEqual([]);
  });

  it('approve: one review_update feed row per owning vendor, readable by that vendor only', async () => {
    const id = await seedUpdate(R1, 'pending');
    await decide(id, BODIES.approve);

    const feed = await feedRows();
    expect(feed.map((r) => r.vendorId).sort()).toEqual([VENDOR_A, VENDOR_B]);
    for (const r of feed) {
      expect(r).toMatchObject({ entityType: 'review_update', entityId: id, productId: P_A });
      expect(r.metadata).toMatchObject({
        kind: 'review_update',
        notificationId: 'portal-review-update',
        updateId: id,
        reviewId: R1,
        rerated: true,
      });
    }

    const read = async (vendorId: string) => {
      const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
      a.onError(errorHandler());
      a.use('*', async (c, nxt) => {
        c.set('auth', { ...ADMIN_AUTH, role: 'vendor_admin', vendorId } as Auth);
        await nxt();
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
        kind: 'review_update',
        id: expect.any(String),
        update_id: id,
        review_id: R1,
        product: { slug: 'revit', name: 'Revit' },
        review_title: 'Review 30',
        rerated: true,
        created_at: expect.any(String),
      },
    ]);
    expect(await read(VENDOR_C)).toEqual([]);
  });

  it('reject: pending to rejected with the reason, no purge, no recompute, no feed row', async () => {
    const id = await seedUpdate(R1, 'pending');
    const res = await decide(id, BODIES.reject);
    expect(res.status).toBe(200);
    expect(await updateRow(id)).toMatchObject({
      status: 'rejected',
      rejectionReason: 'It follows an incentive.',
      publishedAt: null,
    });
    expect(await decisionAudits()).toEqual([
      expect.objectContaining({ action: 'review_update.rejected', entityId: id }),
    ]);
    expect(res.recompute).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
    expect(await feedRows()).toEqual([]);
  });

  it('remove: approved to removed, the average reverts, the page is purged', async () => {
    const id = await seedUpdate(R1, 'pending');
    await decide(id, BODIES.approve);
    expect((await product()).ratingOverallAvg).toBe(4);

    const res = await decide(id, BODIES.remove);
    expect(res.status).toBe(200);
    expect(await updateRow(id)).toMatchObject({
      status: 'removed',
      rejectionReason: 'The reviewer asked us to.',
      publishedAt: null,
    });
    expect(res.recompute).toHaveBeenCalledWith(expect.anything(), [P_A]);
    expect(res.send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'moderation' });
    expect(await product()).toMatchObject({ reviewCount: 3, ratingOverallAvg: 3 });
  });

  it('emails the reviewer on approve and reject, keyed review-update-decision:{id}; remove sends none', async () => {
    const a = await seedUpdate(R1, 'pending');
    await decide(a, BODIES.approve);
    expect(sendReviewUpdateApprovedEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        to: '106@reviewer.test',
        productSlug: 'revit',
        dedupeKey: `review-update-decision:${a}`,
        entity: { type: 'review_update', id: a },
      }),
    );

    await decide(a, BODIES.remove);
    expect(sendReviewUpdateApprovedEmail).toHaveBeenCalledTimes(1);
    expect(sendReviewUpdateRejectedEmail).not.toHaveBeenCalled();

    const b = await seedUpdate(R1, 'pending');
    await decide(b, BODIES.reject);
    expect(sendReviewUpdateRejectedEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reason: 'It follows an incentive.',
        dedupeKey: `review-update-decision:${b}`,
        entity: { type: 'review_update', id: b },
      }),
    );
  });
});

// ─── PATCH: the refusals ─────────────────────────────────────────────────────

describe('PATCH /api/admin/review-updates/:id — the refusals', () => {
  const ALLOWED: Record<ReviewUpdateDecision, string> = {
    approve: 'pending',
    reject: 'pending',
    remove: 'approved',
  };
  const cases = (Object.keys(ALLOWED) as ReviewUpdateDecision[]).flatMap((action) =>
    REVIEW_UPDATE_STATUSES.filter((s) => s !== ALLOWED[action]).map((s) => [action, s] as const),
  );

  it.each(cases)(
    '%s from %s is 409 REVIEW_UPDATE_WRONG_STATE and writes nothing',
    async (action, status) => {
      const id = await seedUpdate(R1, status);
      const before = await updateRow(id);
      const res = await decide(id, BODIES[action]);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: ApiErrorCode.REVIEW_UPDATE_WRONG_STATE,
        details: { status },
      });
      expect(await updateRow(id)).toEqual(before);
      expect(await auditRows()).toEqual([]);
      expect(res.send).not.toHaveBeenCalled();
      expect(res.recompute).not.toHaveBeenCalled();
    },
  );

  it.each(['reject', 'remove'] as const)('%s without a reason is 400', async (action) => {
    const id = await seedUpdate(R1, action === 'remove' ? 'approved' : 'pending');
    expect((await decide(id, { action })).status).toBe(400);
    expect((await decide(id, { action, reason: '   ' })).status).toBe(400);
    expect(await auditRows()).toEqual([]);
  });

  it('404s an unknown update', async () => {
    expect((await decide(uuid(999), BODIES.approve)).status).toBe(404);
  });

  it('a lost race rolls the whole batch back: 409, no audit, no feed row, no purge, no email', async () => {
    const id = await seedUpdate(R1, 'pending');
    // Another moderator rejects it between this handler's read and its batch.
    const factory = racingFactory(t.factory, async (attempt) => {
      if (attempt !== 1) return;
      await t.db
        .update(reviewUpdates)
        .set({ status: 'rejected', rejectionReason: 'Other admin.' })
        .where(eq(reviewUpdates.id, id));
    });
    const res = await decide(id, BODIES.approve, factory);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: ApiErrorCode.REVIEW_UPDATE_WRONG_STATE,
      details: { status: 'rejected' },
    });
    expect(await auditRows()).toEqual([]);
    expect(res.send).not.toHaveBeenCalled();
    expect(res.recompute).not.toHaveBeenCalled();
    expect(sendReviewUpdateApprovedEmail).not.toHaveBeenCalled();
  });
});
