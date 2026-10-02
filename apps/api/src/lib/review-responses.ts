/**
 * Vendor replies to reviews — the shared server pieces (AECI-1176,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c, `DATABASE_SCHEMA.md` §7.3).
 *
 * The vendor routes (`routes/vendor-review-responses.ts`), the `reviews` cursor
 * scope (`routes/vendor-updates.ts`), and later the admin queue (AECI-1177) and
 * the public read (AECI-1178) all import from here, so each rule has one home:
 *
 *   - {@link vendorReviewsWhere}: which reviews a vendor sees. The list and its
 *     cursor share it, so they cannot disagree (`STAGE_2_REALTIME_SPEC.md` §2).
 *   - {@link reviewResponseChangedSentinel}: the `changes()` abort every
 *     transition batch carries right after its guarded write (§11c.7).
 *   - {@link loadPublishedVendorResponses}: the three-rule render predicate of
 *     §11c.11 and the public order, `published_at ASC, id ASC`.
 *
 * Nothing here reads or writes `reviews` beyond a SELECT, and nothing reads a
 * count or a ranking column (§11c.10).
 */

import type {
  PublicVendorResponse,
  ReviewResponseStatus,
  VendorReviewResponse,
} from '@aeci/shared';
import { and, asc, eq, inArray, isNotNull, ne, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { productVendors, reviewResponses, reviews, vendors } from '../db/schema';
import { ownedProductIds } from '../routes/vendor-shared';
import { ONE_ROW } from './integration-claims';
import { chunked } from './promote-claims';

/** `audit_log.entity_type` on every reply transition (§11c.7). */
export const REVIEW_RESPONSE_ENTITY_TYPE = 'review_response';

/** The audit actions (§11c.6). Vendor writes use the first three; AECI-1177's
 *  admin decisions use the last three. */
export const REVIEW_RESPONSE_ACTIONS = {
  submitted: 'review_response.submitted',
  edited: 'review_response.edited',
  withdrawn: 'review_response.withdrawn',
  approved: 'review_response.approved',
  rejected: 'review_response.rejected',
  removed: 'review_response.removed',
} as const;

/** The token {@link reviewResponseChangedSentinel} raises on. */
export const REVIEW_RESPONSE_CHANGED_TOKEN = 'review-response-changed';

export type ReviewResponseRow = typeof reviewResponses.$inferSelect;

/**
 * Approved reviews of the caller's owned products: the scoping predicate of
 * `GET /api/vendor/reviews` and of the `reviews` cursor scope (§11c.13). A
 * subquery, not a fetched list, so the cursor stays one statement.
 */
export function vendorReviewsWhere(db: Db, vendorId: string): SQL | undefined {
  return and(
    eq(reviews.status, 'approved'),
    inArray(reviews.productId, ownedProductIds(db, vendorId)),
  );
}

/**
 * The batch statement that ABORTS a reply transition when the guarded write
 * before it changed no row (§11c.7). Push it IMMEDIATELY after the guarded
 * `UPDATE … WHERE id = ? AND status = ?` (or the first-submit `INSERT`), and push
 * the audit row after it. The loser of a race then commits nothing: no audit row,
 * no notification, no purge.
 *
 * The contest pattern (`contestStillOpenSentinel`): `changes()` is the row count
 * of the last write on the connection, and `json('…')` on a non-JSON token raises,
 * which rolls the whole batch back. It selects from a one-row constant, never from
 * the reply's own row, so the guard is evaluated exactly once even when the row
 * is gone.
 */
export function reviewResponseChangedSentinel(db: Db) {
  return db
    .select({
      guard: sql`CASE WHEN changes() = 0 THEN json(${REVIEW_RESPONSE_CHANGED_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/** Did a batch fail because {@link reviewResponseChangedSentinel} fired? SQLite
 *  reports only "malformed JSON", and the sentinel is the only `json()` call in a
 *  reply batch, so the match is unambiguous. */
export function isReviewResponseRaceError(error: unknown): boolean {
  return causeChainMatches(error, /malformed JSON/i);
}

/** Did a first-submit INSERT lose to another seat of the same vendor on the
 *  `(review_id, vendor_id)` unique index? */
export function isReviewResponseUniqueConflict(error: unknown): boolean {
  return causeChainMatches(
    error,
    /review_responses_review_vendor_key|UNIQUE constraint failed: review_responses/,
  );
}

function causeChainMatches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (pattern.test(String((current as { message?: unknown }).message ?? current))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The caller's own reply on the wire. Author and moderator never cross it. */
export function toVendorReviewResponse(row: ReviewResponseRow): VendorReviewResponse {
  return {
    id: row.id,
    status: row.status as ReviewResponseStatus,
    body: row.body,
    rejection_reason: row.rejectionReason,
    published_at: row.publishedAt,
    moderated_at: row.moderatedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * Published replies for a set of review ids, keyed by review id, in public order.
 *
 * Applies all three rules of §11c.11 in SQL: the reply is `published`, its review
 * is `approved`, and its vendor still owns the review's product in
 * `product_vendors`. `excludeVendorId` drops one vendor's reply, which is how the
 * vendor list builds `other_responses` without repeating the caller's own.
 *
 * The id list is chunked under D1's 100-bound-parameter cap. A page holds at most
 * 100 reviews, so this is one or two statements.
 */
export async function loadPublishedVendorResponses(
  db: Db,
  reviewIds: readonly string[],
  opts: { excludeVendorId?: string } = {},
): Promise<Map<string, PublicVendorResponse[]>> {
  const out = new Map<string, PublicVendorResponse[]>();
  if (reviewIds.length === 0) return out;
  const chunks = await Promise.all(
    chunked([...new Set(reviewIds)]).map((ids) =>
      db
        .select({
          id: reviewResponses.id,
          reviewId: reviewResponses.reviewId,
          body: reviewResponses.body,
          publishedAt: reviewResponses.publishedAt,
          vendorSlug: vendors.slug,
          vendorName: vendors.companyName,
        })
        .from(reviewResponses)
        .innerJoin(reviews, eq(reviews.id, reviewResponses.reviewId))
        .innerJoin(
          productVendors,
          and(
            eq(productVendors.productId, reviews.productId),
            eq(productVendors.vendorId, reviewResponses.vendorId),
          ),
        )
        .innerJoin(vendors, eq(vendors.id, reviewResponses.vendorId))
        .where(
          and(
            inArray(reviewResponses.reviewId, ids),
            eq(reviewResponses.status, 'published'),
            isNotNull(reviewResponses.publishedAt),
            eq(reviews.status, 'approved'),
            opts.excludeVendorId ? ne(reviewResponses.vendorId, opts.excludeVendorId) : undefined,
          ),
        )
        .orderBy(asc(reviewResponses.publishedAt), asc(reviewResponses.id)),
    ),
  );
  // Each chunk is already in public order, and a review's replies all fall in the
  // chunk that holds its id, so appending keeps each list ordered.
  for (const row of chunks.flat()) {
    const list = out.get(row.reviewId) ?? [];
    list.push({
      vendor_slug: row.vendorSlug,
      vendor_name: row.vendorName,
      body: row.body,
      published_at: row.publishedAt!,
    });
    out.set(row.reviewId, list);
  }
  return out;
}
