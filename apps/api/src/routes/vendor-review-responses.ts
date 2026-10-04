/**
 * Vendor replies to reviews, vendor side (`/api/vendor/*`, AECI-1176 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c) — Drizzle/D1.
 *
 *   GET  /api/vendor/reviews                               — the list (paginated).
 *   POST /api/vendor/reviews/:reviewId/response            — create (201) or resubmit (200).
 *   PATCH /api/vendor/reviews/:reviewId/response           — edit (200).
 *   POST /api/vendor/reviews/:reviewId/response/withdraw   — withdraw (200).
 *
 * `routes/vendor.ts` holds the narrative of this surface's invariants. Five rules of
 * this module's own:
 *
 * ── 1. ORDER: REVIEW → OWNERSHIP → CAPABILITY → BODY → STATE ────────────────
 * The review id is a path param, so ownership is proven before anything else is
 * read or parsed. An unknown review, a review of a product the caller does not own,
 * and a review that is not `approved` are ONE query and ONE 404, with the review id
 * as the only detail: a vendor never learns that a pending or rejected review
 * exists (§11c.3). Then `requireCapability(c, 'review.reply')`, so a Free seat gets
 * `403 ENTITLEMENT_REQUIRED` only after ownership settled (`STAGE_2_PAID_TIERS_SPEC.md`
 * §4). Withdraw is not gated (§11c.9): taking your own words down is never paid.
 *
 * ── 2. EVERY TRANSITION IS ONE BATCH ────────────────────────────────────────
 * The guarded write, {@link reviewResponseChangedSentinel} straight after it, then
 * the `audit_log` row (§11c.7). The guard is on the EXACT status the handler read,
 * not the whole allowed set, because the audit metadata and the purge both depend
 * on it: an admin approve landing between the read and an edit must not let the
 * edit commit with `wasPublished` absent and no purge, leaving a cached page that
 * shows a reply which is no longer published. The loser answers `409`, with the
 * status from a re-read, and writes nothing.
 *
 * ── 3. ONLY A PUBLISHED REPLY LEAVING THE PAGE PURGES ───────────────────────
 * Pre-moderation (ruling 1) means a vendor write never makes a reply appear. It can
 * make one disappear: an edit or a withdraw of a `published` reply. Those two purge
 * `product:{slug}` through `afterVendorWrite`, with no re-crawl. Nothing else does.
 *
 * ── 4. THE FIREWALL ─────────────────────────────────────────────────────────
 * No statement here writes `reviews`, a count, an average or a ranking input, and
 * nothing calls `recomputeProductCounts` (§11c.10). The list reads `reviews` only.
 *
 * ── 5. NO WORKFLOW ROW ──────────────────────────────────────────────────────
 * The state machine lives in `review_responses.status`. Nothing writes
 * `workflow_instances` or `workflow_transitions` (§11c.7).
 */

import {
  ApiErrorCode,
  ListVendorReviewsQuerySchema,
  ListVendorReviewsResponseSchema,
  ReviewResponseBodySchema,
  VendorReviewResponseResultSchema,
  type ListVendorReviewsResponse,
  type ReviewResponseStatus,
  type VendorReviewItem,
  type VendorReviewResponseResult,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { hasCapability } from '@aeci/shared/entitlements';
import { and, asc, count, desc, eq, exists, inArray, not, type SQL } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { productVendors, products, reviewResponses, reviews } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, requireCapability } from '../lib/authz';
import { publicReviewColumns, toPublicReview } from '../lib/drizzle-helpers';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { chunked } from '../lib/promote-claims';
import {
  REVIEW_RESPONSE_ACTIONS,
  REVIEW_RESPONSE_ENTITY_TYPE,
  isReviewResponseRaceError,
  isReviewResponseUniqueConflict,
  loadPublishedVendorResponses,
  reviewResponseChangedSentinel,
  toVendorReviewResponse,
  vendorReviewsWhere,
  type ReviewResponseRow,
} from '../lib/review-responses';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  sessionVendorId,
  type VendorContext,
  vendorAuditEntry,
} from './vendor-shared';

/** The review a write addresses, once ownership has settled. */
interface OwnedReview {
  id: string;
  productId: string;
  productSlug: string;
}

function reviewIdParam(c: VendorContext): string {
  const value = c.req.param('reviewId');
  if (!value) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing reviewId', {
      field: 'reviewId',
    });
  }
  return value;
}

/**
 * Rule 1: the review exists, is `approved`, and is of a product the caller owns.
 * One statement, so the three misses cannot be told apart by timing or by detail.
 * The co-owner case passes: any `product_vendors` row counts, primary or not
 * (ruling 4).
 */
async function requireOwnedApprovedReview(
  db: Db,
  vendorId: string,
  reviewId: string,
): Promise<OwnedReview> {
  const [row] = await db
    .select({ id: reviews.id, productId: reviews.productId, productSlug: products.slug })
    .from(reviews)
    .innerJoin(
      productVendors,
      and(eq(productVendors.productId, reviews.productId), eq(productVendors.vendorId, vendorId)),
    )
    .innerJoin(products, eq(products.id, reviews.productId))
    .where(and(eq(reviews.id, reviewId), eq(reviews.status, 'approved')))
    .limit(1);
  if (!row) throw notFoundError('review', { id: reviewId });
  return row;
}

async function loadOwnReply(
  db: Db,
  reviewId: string,
  vendorId: string,
): Promise<ReviewResponseRow | undefined> {
  return db.query.reviewResponses.findFirst({
    where: and(eq(reviewResponses.reviewId, reviewId), eq(reviewResponses.vendorId, vendorId)),
  });
}

function stateError(code: ApiErrorCode, status: string, message: string): ApiError {
  return new ApiError(409, code, message, { details: { status } });
}

function removedError(): ApiError {
  return stateError(
    ApiErrorCode.REVIEW_RESPONSE_REMOVED,
    'removed',
    'AEC Integrations removed this reply. It cannot be changed or replaced.',
  );
}

function wrongStateError(status: string): ApiError {
  return stateError(
    ApiErrorCode.REVIEW_RESPONSE_WRONG_STATE,
    status,
    `This reply is ${status}, so that change is not allowed.`,
  );
}

function existsError(status: string): ApiError {
  return stateError(
    ApiErrorCode.REVIEW_RESPONSE_EXISTS,
    status,
    `This review already has your reply (${status}). Edit it instead.`,
  );
}

/**
 * Run a transition batch whose guarded write is followed by the sentinel. A lost
 * race answers 409 with the status a re-read finds: `REMOVED` when AECi removed the
 * reply meanwhile (any vendor write on a removed reply answers that), `EXISTS` when
 * a first submit lost the unique index to another seat, `WRONG_STATE` otherwise.
 * Returns the committed row for the echo.
 */
async function runReplyBatch(
  db: Db,
  key: { reviewId: string; vendorId: string },
  stmts: BatchStmt[],
): Promise<ReviewResponseRow> {
  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    const unique = isReviewResponseUniqueConflict(error);
    if (!unique && !isReviewResponseRaceError(error)) throw error;
    const current = await loadOwnReply(db, key.reviewId, key.vendorId);
    const status = current?.status ?? 'missing';
    if (status === 'removed') throw removedError();
    if (unique) throw existsError(status);
    throw wrongStateError(status);
  }
  const row = await loadOwnReply(db, key.reviewId, key.vendorId);
  if (!row) throw notFoundError('review_response', { id: key.reviewId });
  return row;
}

function echo(c: VendorContext, row: ReviewResponseRow, status = 200): Response {
  const body: VendorReviewResponseResult = { response: toVendorReviewResponse(row) };
  validateResponseInDev(c.env, () => VendorReviewResponseResultSchema.parse(body));
  return json(body, { status });
}

/** The audit metadata every reply write carries. `resubmit` and `wasPublished`
 *  are present only when true, never as `false`, so a key-presence query finds
 *  exactly the rows that matter (the `maintenanceTransfer` encoding). */
function replyMetadata(
  vendorId: string,
  review: OwnedReview,
  flags: { resubmit?: boolean; wasPublished?: boolean } = {},
): Record<string, unknown> {
  return {
    source: AUDIT_SOURCE,
    vendorId,
    reviewId: review.id,
    productId: review.productId,
    ...(flags.resubmit ? { resubmit: true } : {}),
    ...(flags.wasPublished ? { wasPublished: true } : {}),
  };
}

// ─── POST /api/vendor/reviews/:reviewId/response ─────────────────────────────

/**
 * Create the caller's reply, or resubmit a `rejected` or `withdrawn` one on the
 * same row (ruling 6). Both land `pending`. `201` on create, `200` on resubmit.
 * A `pending` or `published` reply is `409 REVIEW_RESPONSE_EXISTS` (edit it with
 * the PATCH); a `removed` one is `409 REVIEW_RESPONSE_REMOVED`.
 */
export function createSubmitReviewResponseHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const reviewId = reviewIdParam(c);
    const { db } = writeDb(c, dbFor);

    const review = await requireOwnedApprovedReview(db, vendorId, reviewId);
    requireCapability(c, 'review.reply');
    const { body } = await parseJsonBody(c, ReviewResponseBodySchema);

    const existing = await loadOwnReply(db, reviewId, vendorId);
    const now = new Date().toISOString();
    const key = { reviewId, vendorId };

    if (!existing) {
      const id = crypto.randomUUID();
      const audit: AuditLogEntry = {
        actorId: session.userId,
        actorType: auditActorType(session),
        action: REVIEW_RESPONSE_ACTIONS.submitted,
        entityType: REVIEW_RESPONSE_ENTITY_TYPE,
        entityId: id,
        productId: review.productId,
        beforeState: null,
        afterState: { status: 'pending', body },
        metadata: replyMetadata(vendorId, review),
      };
      const row = await runReplyBatch(db, key, [
        db.insert(reviewResponses).values({
          id,
          reviewId,
          vendorId,
          authorProfileId: session.userId,
          body,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        }),
        reviewResponseChangedSentinel(db),
        auditInsert(db, vendorAuditEntry(c, audit)),
      ]);
      // Pending is invisible to the public: nothing to purge (§11c.6).
      afterVendorWrite(c, [], audit);
      return echo(c, row, 201);
    }

    const from = existing.status as ReviewResponseStatus;
    if (from === 'removed') throw removedError();
    if (from === 'pending' || from === 'published') throw existsError(from);

    // `rejected` or `withdrawn`: resubmit in place. The old reason is history; the
    // audit row keeps it.
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: REVIEW_RESPONSE_ACTIONS.submitted,
      entityType: REVIEW_RESPONSE_ENTITY_TYPE,
      entityId: existing.id,
      productId: review.productId,
      beforeState: {
        status: from,
        body: existing.body,
        rejection_reason: existing.rejectionReason,
      },
      afterState: { status: 'pending', body },
      metadata: replyMetadata(vendorId, review, { resubmit: true }),
    };
    const row = await runReplyBatch(db, key, [
      db
        .update(reviewResponses)
        .set({
          body,
          status: 'pending',
          authorProfileId: session.userId,
          rejectionReason: null,
          moderatedBy: null,
          moderatedAt: null,
          publishedAt: null,
          updatedAt: now,
        })
        .where(and(eq(reviewResponses.id, existing.id), eq(reviewResponses.status, from))),
      reviewResponseChangedSentinel(db),
      auditInsert(db, vendorAuditEntry(c, audit)),
    ]);
    afterVendorWrite(c, [], audit);
    return echo(c, row, 200);
  };
}

// ─── PATCH /api/vendor/reviews/:reviewId/response ────────────────────────────

/**
 * Edit a `pending` or `published` reply; it lands `pending` (ruling 5). Editing a
 * published reply takes it off the page until AECi approves it again, so that
 * case purges. An unchanged trimmed body is `422 REVIEW_RESPONSE_NO_CHANGE`, so a
 * no-op save cannot hide a live reply.
 */
export function createEditReviewResponseHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const reviewId = reviewIdParam(c);
    const { db } = writeDb(c, dbFor);

    const review = await requireOwnedApprovedReview(db, vendorId, reviewId);
    requireCapability(c, 'review.reply');
    const { body } = await parseJsonBody(c, ReviewResponseBodySchema);

    const existing = await loadOwnReply(db, reviewId, vendorId);
    if (!existing) throw notFoundError('review_response', { id: reviewId });
    const from = existing.status as ReviewResponseStatus;
    if (from === 'removed') throw removedError();
    if (from !== 'pending' && from !== 'published') throw wrongStateError(from);
    if (body === existing.body) {
      throw new ApiError(
        422,
        ApiErrorCode.REVIEW_RESPONSE_NO_CHANGE,
        'The reply is unchanged. Nothing was saved.',
        { field: 'body' },
      );
    }

    const wasPublished = from === 'published';
    const now = new Date().toISOString();
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: REVIEW_RESPONSE_ACTIONS.edited,
      entityType: REVIEW_RESPONSE_ENTITY_TYPE,
      entityId: existing.id,
      productId: review.productId,
      beforeState: { status: from, body: existing.body },
      afterState: { status: 'pending', body },
      metadata: replyMetadata(vendorId, review, { wasPublished }),
    };
    const row = await runReplyBatch(db, { reviewId, vendorId }, [
      db
        .update(reviewResponses)
        .set({
          body,
          status: 'pending',
          authorProfileId: session.userId,
          publishedAt: null,
          updatedAt: now,
        })
        .where(and(eq(reviewResponses.id, existing.id), eq(reviewResponses.status, from))),
      reviewResponseChangedSentinel(db),
      auditInsert(db, vendorAuditEntry(c, audit)),
    ]);
    afterVendorWrite(c, wasPublished ? [`product:${review.productSlug}`] : [], audit);
    return echo(c, row);
  };
}

// ─── POST /api/vendor/reviews/:reviewId/response/withdraw ────────────────────

/**
 * Withdraw a `pending` or `published` reply. No body, and NOT capability-gated
 * (§11c.9, §11c.14): a vendor that drops to Free can still take its own words
 * down. A published reply leaving the page purges.
 */
export function createWithdrawReviewResponseHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const reviewId = reviewIdParam(c);
    const { db } = writeDb(c, dbFor);

    const review = await requireOwnedApprovedReview(db, vendorId, reviewId);

    const existing = await loadOwnReply(db, reviewId, vendorId);
    if (!existing) throw notFoundError('review_response', { id: reviewId });
    const from = existing.status as ReviewResponseStatus;
    if (from === 'removed') throw removedError();
    if (from !== 'pending' && from !== 'published') throw wrongStateError(from);

    const wasPublished = from === 'published';
    const now = new Date().toISOString();
    const audit: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: REVIEW_RESPONSE_ACTIONS.withdrawn,
      entityType: REVIEW_RESPONSE_ENTITY_TYPE,
      entityId: existing.id,
      productId: review.productId,
      beforeState: { status: from },
      afterState: { status: 'withdrawn' },
      metadata: replyMetadata(vendorId, review, { wasPublished }),
    };
    const row = await runReplyBatch(db, { reviewId, vendorId }, [
      db
        .update(reviewResponses)
        .set({ status: 'withdrawn', publishedAt: null, updatedAt: now })
        .where(and(eq(reviewResponses.id, existing.id), eq(reviewResponses.status, from))),
      reviewResponseChangedSentinel(db),
      auditInsert(db, vendorAuditEntry(c, audit)),
    ]);
    afterVendorWrite(c, wasPublished ? [`product:${review.productSlug}`] : [], audit);
    return echo(c, row);
  };
}

// ─── GET /api/vendor/reviews ─────────────────────────────────────────────────

/** The `reply_status` filter as a predicate on `reviews`, scoped to the caller's
 *  own reply. `none` is "no row of mine on this review". */
function replyStatusWhere(db: Db, vendorId: string, filter: string | undefined): SQL | undefined {
  if (!filter) return undefined;
  const mine = (status?: string) =>
    db
      .select({ one: reviewResponses.id })
      .from(reviewResponses)
      .where(
        and(
          eq(reviewResponses.reviewId, reviews.id),
          eq(reviewResponses.vendorId, vendorId),
          status ? eq(reviewResponses.status, status) : undefined,
        ),
      );
  return filter === 'none' ? not(exists(mine())) : exists(mine(filter));
}

/**
 * Approved reviews of the caller's owned products, newest first
 * (`created_at DESC, id ASC`, the public order). Each item carries the review in
 * its public shape, the product, the caller's own reply in any status, and the
 * co-owners' published replies. A seat on any plan may read it: reads are never
 * gated (§11c.9). Not audited. Not rate-limited.
 */
export function createListVendorReviewsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);
    const query = ListVendorReviewsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const where = and(
      vendorReviewsWhere(db, vendorId),
      // A product the caller does not own simply matches nothing: an empty page.
      query.product_id ? eq(reviews.productId, query.product_id) : undefined,
      replyStatusWhere(db, vendorId, query.reply_status),
    );

    const [rows, countRows] = await Promise.all([
      db
        .select({ ...pickPublicReviewColumns(), productId: reviews.productId })
        .from(reviews)
        .where(where)
        .orderBy(desc(reviews.createdAt), asc(reviews.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(reviews).where(where),
    ]);

    const reviewIds = rows.map((r) => r.id);
    const productIds = [...new Set(rows.map((r) => r.productId))];
    const [productRows, ownRows, others] = await Promise.all([
      selectInChunks(productIds, (ids) =>
        db
          .select({
            id: products.id,
            slug: products.slug,
            name: products.name,
            logoUrl: products.logoUrl,
          })
          .from(products)
          .where(inArray(products.id, ids)),
      ),
      selectInChunks(reviewIds, (ids) =>
        db
          .select()
          .from(reviewResponses)
          .where(
            and(eq(reviewResponses.vendorId, vendorId), inArray(reviewResponses.reviewId, ids)),
          ),
      ),
      loadPublishedVendorResponses(db, reviewIds, { excludeVendorId: vendorId }),
    ]);
    const productById = new Map(productRows.map((p) => [p.id, p]));
    const ownByReview = new Map(ownRows.map((r) => [r.reviewId, r]));
    // Until per-product plans land, a product's plan is the vendor's (§11c.9).
    const canReply = hasCapability(c.get('auth').entitlementTier, 'review.reply');

    const data: VendorReviewItem[] = [];
    for (const row of rows) {
      const product = productById.get(row.productId);
      // The FK cascades, so a review always has its product. Skip rather than 500.
      if (!product) continue;
      const own = ownByReview.get(row.id);
      data.push({
        review: toPublicReview(row),
        product: {
          id: product.id,
          slug: product.slug,
          name: product.name,
          logo_url: product.logoUrl,
        },
        response: own ? toVendorReviewResponse(own) : null,
        other_responses: others.get(row.id) ?? [],
        can_reply: canReply,
      });
    }

    const body: ListVendorReviewsResponse = {
      data,
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => ListVendorReviewsResponseSchema.parse(body));
    return json(body);
  };
}

/** `publicReviewColumns` as a `select()` column map, so the list reads exactly
 *  the public review fields and nothing a reviewer would not want shown. */
function pickPublicReviewColumns() {
  const cols = {} as {
    [K in keyof typeof publicReviewColumns]: (typeof reviews)[K];
  };
  for (const key of Object.keys(publicReviewColumns) as (keyof typeof publicReviewColumns)[]) {
    (cols as Record<string, unknown>)[key] = reviews[key];
  }
  return cols;
}

/** Run `read` over `ids` in chunks under D1's bound-parameter cap. */
async function selectInChunks<T>(
  ids: readonly string[],
  read: (ids: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const parts = await Promise.all(chunked(ids).map(read));
  return parts.flat();
}
