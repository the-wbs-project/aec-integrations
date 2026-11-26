/**
 * Admin moderation API (AECI-204 / Phase 5.13) — Drizzle/D1 (ADR 0016 / AECI-253,
 * AECI-254).
 *
 *   GET   /api/admin/reviews     — the moderation queue (status filter, paginated).
 *   PATCH /api/admin/reviews/:id — approve / reject a *pending* review, or remove an
 *                                  *approved* one (AECI-1643).
 *
 * `REVIEW_DECISIONS` (`@aeci/shared`) gives each action exactly one from-state. A
 * review in any other state is `422 INVALID_STATE_TRANSITION`.
 *
 * Moderation is one atomic `db.batch`: the guarded `UPDATE … WHERE status='pending'`
 * + the `review.approved|rejected` audit + the lean workflow history (find-or-create
 * the `review_moderation` instance, append the `pending → approved|rejected`
 * transition, mark the instance complete). The denormalized count recompute on
 * approve runs as a separate post-batch step (`lib/recompute-counts.ts`). A
 * `changes()` sentinel after the guarded UPDATE rolls the batch back for the loser of
 * a two-admin race, which then answers `409 REVIEW_ALREADY_MODERATED` and sends no
 * email (AECI-1203).
 *
 * An approve also writes one `notification.sent` row per owning vendor into the
 * same batch, and emails their seats post-commit (AECI-1180,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.12, `lib/review-notifications.ts`).
 *
 * A remove (AECI-1643, `STAGE_1_SPEC.md` §22.1, `ADMIN_PANEL_SPEC.md` §5.21) is the
 * same shape: the guarded `UPDATE … WHERE status='approved'`, the sentinel, the
 * `review.removed` audit row and the `approved → removed` transition in one batch,
 * then a recompute and a `product:{slug}` purge. It sends no email to the reviewer
 * or to any vendor, and raises no repeat-offender prompt. `moderated_at` /
 * `moderated_by` keep the approve stamp; `removed_at` / `removal_reason` record the
 * removal.
 *
 * `reviewer_email` (admin-only, lives in `auth.users`) is read via the GoTrue
 * Admin API (seam #2, `lib/supabase-admin.ts`), injected for tests and degrading
 * to `reviewer_email: null` — the queue must stay usable, never 500.
 */

import {
  ApiErrorCode,
  ListPendingReviewsQuerySchema,
  ListPendingReviewsResponseSchema,
  ModerateReviewResponseSchema,
  ModerateReviewSchema,
  REPEAT_OFFENDER_THRESHOLD,
  REVIEW_DECISIONS,
  type ListPendingReviewsResponse,
  type ModerateReviewResponse,
  type RepeatOffenderPrompt,
  type ReviewDecision,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { type WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import { forwardAuditBatch } from '../lib/moderation-forward';
import type { Db } from '../db/client';
import { reviews, workflowInstances } from '../db/schema';
import { logToPosthog, submitCount } from '../posthog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  auditInsert,
  workflowTransitionInsert,
  type BatchStmt,
  type BatchTuple,
} from '../lib/audit';
import { adminReviewConfig, toAdminReview, type RawAdminReviewRow } from '../lib/drizzle-helpers';
import { sendReviewApprovedEmail, sendReviewRejectedEmail } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { recomputeProductCounts } from '../lib/recompute-counts';
import {
  isReviewRaceError,
  reviewDecisionStatements,
  reviewStillInStateSentinel,
} from '../lib/review-moderation';
import {
  emailOwnersOfApprovedReview,
  loadReviewOwners,
  reviewApprovedNotifications,
} from '../lib/review-notifications';
import { fetchAuthUserEmails } from '../lib/supabase-admin';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** Injected reviewer-email seam (seam #2). Default hits the GoTrue Admin API. */
export type FetchReviewerEmails = (
  env: Env,
  reviewerIds: readonly string[],
) => Promise<Map<string, string>>;

/** Injected recompute seam (post-batch, approve-only). */
type RecomputeFn = (db: Db, productIds: Iterable<string>) => Promise<void>;

/** Injected owner-email seam (post-commit, approve-only, AECI-1180). The seat
 *  addresses come through the same `fetchEmails` seam as the reviewer's. */
export type NotifyReviewOwnersFn = typeof emailOwnersOfApprovedReview;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function parseJsonBody<T>(c: AdminContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

function emitModeration(
  c: AdminContext,
  action: ReviewDecision,
  outcome: 'ok' | 'invalid_state',
): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.moderation.action', 1, [
    `action:${action}`,
    `outcome:${outcome}`,
  ]);
}

/**
 * Enqueue a purge of the moderated product's `Cache-Tag` (WC-5 / ADR 0020 §3). The
 * SSR Worker's queue consumer issues the actual `ctx.cache.purge()` and emits
 * `aeci.cache.purge{source:moderation}` — the API Worker's own zone-HTTP purge is
 * inert against native Workers Cache. Best-effort: no-ops without the queue binding
 * (local), and a `queue.send` rejection is logged (a `warn`) and
 * swallowed so it never affects the committed moderation.
 */
async function purgeProductTag(c: AdminContext, slug: string): Promise<void> {
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue) return;
  try {
    await queue.send({ tags: [`product:${slug}`], source: 'moderation' });
  } catch (error) {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `Cache purge enqueue failed for product:${slug}`,
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── GET /api/admin/reviews ────────────────────────────────────────────────────

export function createAdminReviewsListHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchReviewerEmails = fetchAuthUserEmails,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListPendingReviewsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const where = eq(reviews.status, query.status);
    const direction = query.sort === 'created_at' ? desc : asc;

    const [rows, countRows] = await Promise.all([
      db.query.reviews.findMany({
        ...adminReviewConfig,
        where,
        orderBy: [direction(reviews.createdAt), asc(reviews.id)],
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(reviews).where(where),
    ]);

    const reviewerIds = rows.map((row) => row.reviewerId).filter((id): id is string => id !== null);
    const emailByReviewerId = await fetchEmails(c.env, reviewerIds);

    const body: ListPendingReviewsResponse = {
      data: rows.map((row) => toAdminReview(row, emailByReviewerId)),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      ListPendingReviewsResponseSchema.parse(body);
    });

    return json(body);
  };
}

// ─── PATCH /api/admin/reviews/:id ──────────────────────────────────────────────

export function createModerateReviewHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchReviewerEmails = fetchAuthUserEmails,
  recompute: RecomputeFn = recomputeProductCounts,
  notifyOwners: NotifyReviewOwnersFn = emailOwnersOfApprovedReview,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing review id', { field: 'id' });
    }

    const payload = await parseJsonBody(c, ModerateReviewSchema);
    const { db } = writeDb(c, dbFor);

    // Preload the full admin row — it gates the transition (status) and builds the
    // response (the values we set are merged in after commit; no post-commit read).
    const existing = (await db.query.reviews.findFirst({
      ...adminReviewConfig,
      where: eq(reviews.id, id),
    })) as RawAdminReviewRow | undefined;
    if (!existing) throw notFoundError('review', { id });
    const decision = REVIEW_DECISIONS[payload.action];
    if (existing.status !== decision.from) {
      emitModeration(c, payload.action, 'invalid_state');
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        payload.action === 'remove'
          ? `Review is ${existing.status}; only approved reviews can be removed.`
          : `Review is ${existing.status}; only pending reviews can be moderated.`,
      );
    }

    if (payload.action === 'remove') {
      return removeReview(c, db, existing, payload.rejection_reason as string, {
        fetchEmails,
        recompute,
      });
    }

    const approve = payload.action === 'approve';
    const newStatus = approve ? 'approved' : 'rejected';
    const rejectionReason = approve ? null : (payload.rejection_reason as string);
    const moderatedAt = new Date().toISOString();

    // Read the workflow instance up front (find-or-create can't be conditional
    // inside a batch). Reviews pre-dating the AECI-210 retrofit have none.
    const existingWf = await db.query.workflowInstances.findFirst({
      columns: { id: true },
      where: and(
        eq(workflowInstances.workflowType, 'review_moderation'),
        eq(workflowInstances.entityId, id),
      ),
    });
    const actor = { actorId: userId, actorType: auditActorType(session) };

    // AECI-1180 (§11c.12): on approve, one `notification.sent` row per owning
    // vendor, primary or not, on every plan. Owners are read before the batch
    // because a batch statement cannot fan out into audit rows. Reject writes none.
    const owners = approve ? await loadReviewOwners(db, existing.product.id) : [];
    const notifications = reviewApprovedNotifications('portal-review', actor, owners, {
      id,
      title: existing.title,
      product: existing.product,
    });

    // The guarded update (`WHERE status='pending'`) makes the state change safe under
    // a concurrent moderation, and the sentinel right after it makes the LOSER's whole
    // batch roll back (AECI-1203). Two admins can both pass the preload gate above.
    // Before the sentinel the loser still committed its audit row and transition, and
    // then emailed the reviewer a second, possibly contradictory, decision. Now the
    // loser writes nothing, sends nothing, and answers 409 REVIEW_ALREADY_MODERATED.
    // The vendor feed rows ride the same batch, so the loser writes none of them.
    // The statements come from the builder the ban's `reject_pending` also uses
    // (AECI-1949, `lib/review-moderation.ts`).
    const { stmts, audits, transitions } = reviewDecisionStatements(db, {
      reviewId: id,
      productId: existing.product.id,
      decision: approve ? 'approve' : 'reject',
      rejectionReason,
      moderatedAt,
      actor,
      existingWorkflowId: existingWf?.id ?? null,
      notifications,
    });
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isReviewRaceError(error)) throw error;
      emitModeration(c, payload.action, 'invalid_state');
      throw new ApiError(
        409,
        ApiErrorCode.REVIEW_ALREADY_MODERATED,
        'Another moderator decided this review first. Nothing was changed.',
      );
    }

    // `decision.purges` (REVIEW_DECISIONS) says whether the public page changes:
    // true for approve, false for reject (a rejected review was never counted).
    // Recompute the product's denormalized counts, then purge. Separate
    // post-batch step under D1.
    if (decision.purges) {
      await recompute(db, [existing.product.id]);
    }

    emitModeration(c, payload.action, 'ok');

    if (decision.purges && c.env.CACHE_PURGE_QUEUE) {
      c.executionCtx.waitUntil(purgeProductTag(c, existing.product.slug));
    }
    // §26.5 audit + workflow forwards, in ONE request (AECI-1112).
    forwardAuditBatch(c, audits, transitions);

    // AECI-1180: email the owners' seats, post-commit and fail-open.
    if (owners.length > 0) {
      c.executionCtx.waitUntil(
        notifyOwners(
          c,
          db,
          owners,
          {
            id,
            title: existing.title,
            ratingOverall: existing.ratingOverall,
            ratingOnboarding: existing.ratingOnboarding,
            product: existing.product,
          },
          fetchEmails,
        ),
      );
    }

    const moderatedRow: RawAdminReviewRow = {
      ...existing,
      status: newStatus,
      moderatedAt,
      rejectionReason: approve ? existing.rejectionReason : rejectionReason,
    };
    const emailByReviewerId = await fetchEmails(
      c.env,
      existing.reviewerId ? [existing.reviewerId] : [],
    );

    // §11.1 reviewer notification, fire-and-forget. Reuses the email already
    // fetched for the response; fails open (absent key/email → silent skip).
    //
    // Both templates share one key (AECI-1203): a review gets one decision email,
    // ever. Only a `pending` review is moderated, and nothing returns a decided review
    // to `pending` (a revision is a new review with a new id), so the key never has to
    // carry the status.
    const decisionDedupe = {
      dedupeKey: `review-decision:${id}`,
      entity: { type: 'review', id },
    };
    const reviewerEmail = existing.reviewerId
      ? emailByReviewerId.get(existing.reviewerId)
      : undefined;
    c.executionCtx.waitUntil(
      approve
        ? sendReviewApprovedEmail(c, {
            to: reviewerEmail,
            productName: existing.product.name,
            productSlug: existing.product.slug,
            ...decisionDedupe,
          })
        : sendReviewRejectedEmail(c, {
            to: reviewerEmail,
            productName: existing.product.name,
            reason: rejectionReason ?? '',
            ...decisionDedupe,
          }),
    );

    const repeatOffender = await computeRepeatOffenderPrompt(
      db,
      approve ? null : existing.reviewerId,
      emailByReviewerId,
    );

    const body: ModerateReviewResponse = {
      review: toAdminReview(moderatedRow, emailByReviewerId),
      repeat_offender: repeatOffender,
    };

    validateResponseInDev(c.env, () => {
      ModerateReviewResponseSchema.parse(body);
    });

    return json(body);
  };
}

/**
 * `approved → removed` (AECI-1643). Called once the state gate has passed. One
 * batch: the guarded UPDATE, the sentinel, the `review.removed` audit row, the
 * workflow instance moved to `removed`, and the transition. A lost race rolls the
 * whole batch back and answers `409 REVIEW_ALREADY_MODERATED`.
 *
 * After commit: recompute the product's counts (the review stops counting), purge
 * `product:{slug}`, forward the audit batch. No email to anyone: the Terms let us
 * remove content without notice, and the reason reaches the reviewer on
 * `/account`.
 */
async function removeReview(
  c: AdminContext,
  db: Db,
  existing: RawAdminReviewRow,
  reason: string,
  seams: { fetchEmails: FetchReviewerEmails; recompute: RecomputeFn },
): Promise<Response> {
  const session = c.get('auth');
  const { userId } = session;
  const { id } = existing;
  const removedAt = new Date().toISOString();
  const removalReason = reason.trim();
  const { from, to, purges } = REVIEW_DECISIONS.remove;

  const existingWf = await db.query.workflowInstances.findFirst({
    columns: { id: true },
    where: and(
      eq(workflowInstances.workflowType, 'review_moderation'),
      eq(workflowInstances.entityId, id),
    ),
  });
  const workflowId = existingWf?.id ?? crypto.randomUUID();

  const metadata = {
    source: 'admin-moderation',
    product_id: existing.product.id,
    removal_reason: removalReason,
  };
  const auditEntry: AuditLogEntry = {
    actorId: userId,
    actorType: auditActorType(session),
    action: 'review.removed',
    entityType: 'review',
    entityId: id,
    productId: existing.product.id,
    metadata,
  };
  const workflowEntry: WorkflowTransitionEntry = {
    workflowId,
    fromState: from,
    toState: to,
    actorId: userId,
    reason: removalReason,
    metadata,
  };

  const stmts: BatchStmt[] = [
    db
      .update(reviews)
      .set({ status: to, removedAt, removalReason })
      .where(and(eq(reviews.id, id), eq(reviews.status, from))),
    // Directly after the UPDATE: `changes()` must read the guarded write.
    reviewStillInStateSentinel(db),
    auditInsert(db, auditEntry),
    // The instance completed on approve; only its state moves. `final_outcome` keeps
    // `approved`, because its CHECK has no `removed` and the transition records the
    // removal. A review that predates the AECI-210 retrofit gets a closed instance.
    existingWf
      ? db
          .update(workflowInstances)
          .set({ currentState: to })
          .where(eq(workflowInstances.id, workflowId))
      : db.insert(workflowInstances).values({
          id: workflowId,
          workflowType: 'review_moderation',
          entityId: id,
          currentState: to,
          completedAt: removedAt,
        }),
    workflowTransitionInsert(db, workflowEntry),
  ];
  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    if (!isReviewRaceError(error)) throw error;
    emitModeration(c, 'remove', 'invalid_state');
    throw new ApiError(
      409,
      ApiErrorCode.REVIEW_ALREADY_MODERATED,
      'Another moderator changed this review first. Nothing was changed.',
    );
  }

  if (purges) {
    await seams.recompute(db, [existing.product.id]);
  }
  emitModeration(c, 'remove', 'ok');
  if (purges && c.env.CACHE_PURGE_QUEUE) {
    c.executionCtx.waitUntil(purgeProductTag(c, existing.product.slug));
  }
  forwardAuditBatch(c, [auditEntry], [workflowEntry]);

  const emailByReviewerId = await seams.fetchEmails(
    c.env,
    existing.reviewerId ? [existing.reviewerId] : [],
  );
  const body: ModerateReviewResponse = {
    review: toAdminReview({ ...existing, status: to, removedAt, removalReason }, emailByReviewerId),
    repeat_offender: null,
  };
  validateResponseInDev(c.env, () => {
    ModerateReviewResponseSchema.parse(body);
  });
  return json(body);
}

/** AECI-218 repeat-offender prompt: reject-only, identified reviewers, ≥ threshold
 *  total rejected. Best-effort — a count failure degrades to no prompt (the
 *  moderation already committed). */
async function computeRepeatOffenderPrompt(
  db: Db,
  reviewerId: string | null,
  emailByReviewerId: ReadonlyMap<string, string>,
): Promise<RepeatOffenderPrompt | null> {
  if (!reviewerId) return null;
  let rejectedCount: number;
  try {
    const [row] = await db
      .select({ value: count() })
      .from(reviews)
      .where(and(eq(reviews.reviewerId, reviewerId), eq(reviews.status, 'rejected')));
    rejectedCount = row?.value ?? 0;
  } catch (error) {
    console.warn('admin-reviews: repeat-offender count failed', error);
    return null;
  }
  if (rejectedCount < REPEAT_OFFENDER_THRESHOLD) return null;
  return {
    reviewer_id: reviewerId,
    reviewer_email: emailByReviewerId.get(reviewerId) ?? null,
    rejected_count: rejectedCount,
  };
}

// The sentinel moved to `lib/review-moderation.ts` (AECI-1949). Re-exported so
// existing importers keep working.
export { isReviewRaceError, reviewStillInStateSentinel };
