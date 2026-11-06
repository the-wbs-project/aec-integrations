/**
 * `POST /api/account/reviews/:reviewId/updates` (AECI-1613, `STAGE_1_SPEC.md` §4.7a).
 *
 * A reviewer adds an update to one of their OWN APPROVED reviews. The original review
 * is never written. The update enters `review_updates` as `pending` and shows on the
 * product page only after an admin approves it (`routes/admin-review-updates.ts`).
 *
 * Guards, in order:
 *   - `requireAuth({ bannedCode: REVIEW_BANNED })` and `rateLimit('write')` in
 *     `index.ts`, as `POST /api/reviews`.
 *   - A suspended vendor's seat writes nothing (AECI-1623), as `POST /api/reviews`.
 *   - The review exists, is the caller's (`reviews.reviewer_id = session.userId`),
 *     and is `approved`. Anything else is the SAME `404 review`, so a caller cannot
 *     tell "not yours" from "no such review" or "still pending".
 *   - One pending update per review: `409 REVIEW_UPDATE_PENDING`. The partial unique
 *     index `review_updates_one_pending_key` is the backstop for a race.
 *
 * Toxicity is scored BEFORE the batch and fails open to `null` (queue parity with
 * reviews). One `db.batch`: the insert and its `review_update.submitted` audit row.
 * Post-commit, in `waitUntil`: the audit forward, the reviewer's receipt and the
 * operator alert. No count moves on submit, so nothing is recomputed or purged.
 */

import {
  ApiErrorCode,
  SubmitReviewUpdateResponseSchema,
  SubmitReviewUpdateSchema,
  type SubmitReviewUpdateResponse,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import { products, reviewUpdates, reviews, vendorSuspensions } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  sendReviewUpdateSubmittedAlert,
  sendReviewUpdateSubmittedEmail,
  type SubmittedReviewUpdateSummary,
} from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';
import {
  REVIEW_UPDATE_ACTIONS,
  REVIEW_UPDATE_ENTITY_TYPE,
  isReviewUpdatePendingConflict,
  toAccountReviewUpdate,
} from '../lib/review-updates';
import { scoreToxicity } from '../lib/toxicity';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** `audit_log.metadata.source` and the forward's `source`. */
const SOURCE = 'account-review-update';

async function parseJsonBody<T>(c: AuthContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

const pendingError = (): ApiError =>
  new ApiError(
    409,
    ApiErrorCode.REVIEW_UPDATE_PENDING,
    'This review already has an update waiting for moderation.',
    { details: { status: 'pending' } },
  );

export function createSubmitReviewUpdateHandler(
  dbFor: DbFactory = getDb,
  score: (c: AuthContext, body: string) => Promise<number | null> = scoreToxicity,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const reviewId = c.req.param('reviewId');
    if (!reviewId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing review id', {
        field: 'reviewId',
      });
    }
    const payload = await parseJsonBody(c, SubmitReviewUpdateSchema);
    const { db } = writeDb(c, dbFor);

    // AECI-1623: a suspended vendor's seats write nothing. Reads only for a seat.
    if (session.role === 'vendor_admin' && session.vendorId) {
      const open = await db.query.vendorSuspensions.findFirst({
        columns: { id: true },
        where: and(
          eq(vendorSuspensions.vendorId, session.vendorId),
          isNull(vendorSuspensions.resolvedAt),
        ),
      });
      if (open) {
        throw new ApiError(
          403,
          ApiErrorCode.VENDOR_SUSPENDED,
          'This vendor account is suspended, so its seats cannot update reviews right now.',
        );
      }
    }

    // Owner + approved, in the WHERE, so every miss is the same 404.
    const [review] = await db
      .select({
        id: reviews.id,
        title: reviews.title,
        productId: products.id,
        productName: products.name,
        productSlug: products.slug,
      })
      .from(reviews)
      .innerJoin(products, eq(products.id, reviews.productId))
      .where(
        and(
          eq(reviews.id, reviewId),
          eq(reviews.reviewerId, session.userId),
          eq(reviews.status, 'approved'),
        ),
      )
      .limit(1);
    if (!review) throw notFoundError('review', { id: reviewId });

    const [pending] = await db
      .select({ id: reviewUpdates.id })
      .from(reviewUpdates)
      .where(and(eq(reviewUpdates.reviewId, reviewId), eq(reviewUpdates.status, 'pending')))
      .limit(1);
    if (pending) throw pendingError();

    // BEFORE the batch: an external call must not sit inside the atomic unit.
    const toxicityScore = await score(c, payload.body);

    const ratingOverall = payload.rating_overall ?? null;
    const ratingOnboarding = payload.rating_onboarding ?? null;
    const rerated = ratingOverall !== null;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: REVIEW_UPDATE_ACTIONS.submitted,
      entityType: REVIEW_UPDATE_ENTITY_TYPE,
      entityId: id,
      productId: review.productId,
      afterState: { status: 'pending' },
      metadata: {
        source: SOURCE,
        reviewId,
        productId: review.productId,
        rerated,
        toxicity_score: toxicityScore,
      },
    };

    const stmts: BatchStmt[] = [
      db.insert(reviewUpdates).values({
        id,
        reviewId,
        body: payload.body,
        ratingOverall,
        ratingOnboarding,
        status: 'pending',
        toxicityScore,
        createdAt: now,
        updatedAt: now,
      }),
      auditInsert(db, audit),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isReviewUpdatePendingConflict(error)) throw pendingError();
      throw error;
    }

    forwardAuditBatch(c, [audit], [], SOURCE);
    const summary: SubmittedReviewUpdateSummary = {
      updateId: id,
      reviewId,
      reviewTitle: review.title,
      productName: review.productName,
      productSlug: review.productSlug,
      body: payload.body,
      ratingOverall,
      ratingOnboarding,
    };
    c.executionCtx.waitUntil(
      sendReviewUpdateSubmittedEmail(c, { to: session.email, update: summary }),
    );
    c.executionCtx.waitUntil(
      sendReviewUpdateSubmittedAlert(c, {
        update: summary,
        reviewerEmail: session.email,
        toxicityScore,
      }),
    );

    const body: SubmitReviewUpdateResponse = {
      update: toAccountReviewUpdate({
        id,
        reviewId,
        body: payload.body,
        ratingOverall,
        ratingOnboarding,
        status: 'pending',
        rejectionReason: null,
        moderatedBy: null,
        moderatedAt: null,
        publishedAt: null,
        toxicityScore,
        createdAt: now,
        updatedAt: now,
      }),
    };
    validateResponseInDev(c.env, () => SubmitReviewUpdateResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}
