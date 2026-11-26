/**
 * A ban that rejects the person's pending items (AECI-1949, `ADMIN_PANEL_SPEC.md`
 * §5.8, `STAGE_1_SPEC.md` §22.3).
 *
 * `PATCH /api/admin/reviewers/:id` with `reject_pending: true` rejects, in the ban's
 * own `db.batch`:
 *
 *   - the person's `pending` reviews (`reviews.reviewer_id`);
 *   - the `pending` updates to those reviews (`review_updates` through `reviews`);
 *   - the `pending` vendor replies the person last wrote (`author_profile_id`).
 *
 * Each item uses the same builder as its manual reject (`lib/review-moderation.ts`),
 * with the fixed {@link BAN_REJECTION_REASON} and `metadata.source = 'admin-ban'`.
 * `GET /api/admin/users/:id` counts the same sets with
 * {@link pendingModerationCountStatements}, so the form and the ban agree.
 *
 * Nothing pending was ever public, so nothing here recomputes, reindexes or purges.
 */

import { BAN_REJECTION_REASON, type BanRejectedCounts } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { products, reviewResponses, reviewUpdates, reviews, workflowInstances } from '../db/schema';
import { vendorAuditStamp, type VendorAuditStamp } from './audit-vendor';
import { ONE_ROW } from './integration-claims';
import { chunked } from './promote-claims';
import {
  reviewDecisionStatements,
  reviewResponseDecisionStatements,
  reviewUpdateDecisionStatements,
  type ModerationBatch,
} from './review-moderation';

/** `audit_log.metadata.source` on every item a ban rejects. */
export const BAN_REJECT_SOURCE = 'admin-ban';

export interface BanPendingItems {
  reviews: { id: string; productId: string; workflowId: string | null }[];
  updates: { id: string; reviewId: string; productId: string; productName: string }[];
  responses: {
    id: string;
    vendorId: string;
    reviewId: string;
    updatedAt: string;
    product: { id: string; slug: string; name: string };
  }[];
}

export const NO_PENDING_ITEMS: BanPendingItems = { reviews: [], updates: [], responses: [] };

export const NO_REJECTED: BanRejectedCounts = {
  reviews: 0,
  review_updates: 0,
  review_responses: 0,
};

/** Review updates by the person: the update's review is theirs. */
function pendingUpdatesWhere(profileId: string) {
  return and(eq(reviews.reviewerId, profileId), eq(reviewUpdates.status, 'pending'));
}

/** Replies the person last wrote. */
function pendingResponsesWhere(profileId: string) {
  return and(eq(reviewResponses.authorProfileId, profileId), eq(reviewResponses.status, 'pending'));
}

/**
 * The two counts `GET /api/admin/users/:id` adds to the person's `reviews.pending`:
 * pending updates, then pending replies. Plain statements, so they ride the detail
 * read's own `db.batch`.
 */
export function pendingModerationCountStatements(db: Db, profileId: string) {
  return [
    db
      .select({ value: count() })
      .from(reviewUpdates)
      .innerJoin(reviews, eq(reviews.id, reviewUpdates.reviewId))
      .where(pendingUpdatesWhere(profileId)),
    db.select({ value: count() }).from(reviewResponses).where(pendingResponsesWhere(profileId)),
  ] as const;
}

/** How many items a ban with `reject_pending` would reject, by kind. */
export async function countBanPendingItems(db: Db, profileId: string): Promise<BanRejectedCounts> {
  const [updates, responses] = pendingModerationCountStatements(db, profileId);
  const [reviewRows, updateRows, responseRows] = await db.batch([
    db
      .select({ value: count() })
      .from(reviews)
      .where(and(eq(reviews.reviewerId, profileId), eq(reviews.status, 'pending'))),
    updates,
    responses,
  ]);
  return {
    reviews: reviewRows[0]?.value ?? 0,
    review_updates: updateRows[0]?.value ?? 0,
    review_responses: responseRows[0]?.value ?? 0,
  };
}

export function totalItems(counts: BanRejectedCounts): number {
  return counts.reviews + counts.review_updates + counts.review_responses;
}

/**
 * Every pending item of the person, with what each reject builder needs. The caller
 * has already checked the counts against `BAN_REJECT_MAX_ITEMS`. The workflow ids
 * are read in chunks, so 100 review ids plus `workflow_type` stay under D1's 100
 * bound parameters per query.
 */
export async function loadBanPendingItems(db: Db, profileId: string): Promise<BanPendingItems> {
  const [reviewRows, updateRows, responseRows] = await db.batch([
    db
      .select({ id: reviews.id, productId: reviews.productId })
      .from(reviews)
      .where(and(eq(reviews.reviewerId, profileId), eq(reviews.status, 'pending')))
      .orderBy(asc(reviews.id)),
    db
      .select({
        id: reviewUpdates.id,
        reviewId: reviewUpdates.reviewId,
        productId: reviews.productId,
        productName: products.name,
      })
      .from(reviewUpdates)
      .innerJoin(reviews, eq(reviews.id, reviewUpdates.reviewId))
      .innerJoin(products, eq(products.id, reviews.productId))
      .where(pendingUpdatesWhere(profileId))
      .orderBy(asc(reviewUpdates.id)),
    db
      .select({
        id: reviewResponses.id,
        vendorId: reviewResponses.vendorId,
        reviewId: reviewResponses.reviewId,
        updatedAt: reviewResponses.updatedAt,
        productId: reviews.productId,
        productSlug: products.slug,
        productName: products.name,
      })
      .from(reviewResponses)
      .innerJoin(reviews, eq(reviews.id, reviewResponses.reviewId))
      .innerJoin(products, eq(products.id, reviews.productId))
      .where(pendingResponsesWhere(profileId))
      .orderBy(asc(reviewResponses.id)),
  ]);

  const workflowByReview = new Map<string, string>();
  for (const ids of chunked(reviewRows.map((r) => r.id))) {
    const rows = await db
      .select({ id: workflowInstances.id, entityId: workflowInstances.entityId })
      .from(workflowInstances)
      .where(
        and(
          eq(workflowInstances.workflowType, 'review_moderation'),
          inArray(workflowInstances.entityId, ids),
        ),
      );
    for (const row of rows) workflowByReview.set(row.entityId, row.id);
  }

  return {
    reviews: reviewRows.map((r) => ({ ...r, workflowId: workflowByReview.get(r.id) ?? null })),
    updates: updateRows,
    responses: responseRows.map((r) => ({
      id: r.id,
      vendorId: r.vendorId,
      reviewId: r.reviewId,
      updatedAt: r.updatedAt,
      product: { id: r.productId, slug: r.productSlug, name: r.productName },
    })),
  };
}

/**
 * A key per item that changes when the item would no longer be rejected as read: a
 * new item, a decided one, or a reply the vendor edited. Two equal sets mean the
 * pending items did not move.
 */
export function pendingFingerprint(items: BanPendingItems): string {
  return [
    ...items.reviews.map((r) => `review:${r.id}`),
    ...items.updates.map((u) => `update:${u.id}`),
    ...items.responses.map((r) => `response:${r.id}:${r.updatedAt}`),
  ]
    .sort()
    .join('|');
}

export function rejectedCounts(items: BanPendingItems): BanRejectedCounts {
  return {
    reviews: items.reviews.length,
    review_updates: items.updates.length,
    review_responses: items.responses.length,
  };
}

/**
 * The reject statements for every pending item, in the order reviews, updates,
 * replies. Each item carries its own sentinel, so one that moved aborts the whole
 * batch, ban included. Reads only the vendor audit stamps, once per vendor.
 */
export async function banRejectStatements(
  db: Db,
  items: BanPendingItems,
  ctx: {
    actor: { actorId: string; actorType: AuditLogEntry['actorType'] };
    now: string;
    banAuditId: string;
  },
): Promise<ModerationBatch> {
  const extraMetadata = { ban_audit_id: ctx.banAuditId, rejection_reason: BAN_REJECTION_REASON };
  const common = { actor: ctx.actor, source: BAN_REJECT_SOURCE, extraMetadata };
  const out: ModerationBatch = { stmts: [], audits: [], transitions: [] };
  const add = (batch: ModerationBatch) => {
    out.stmts.push(...batch.stmts);
    out.audits.push(...batch.audits);
    out.transitions.push(...batch.transitions);
  };

  for (const review of items.reviews) {
    add(
      reviewDecisionStatements(db, {
        ...common,
        reviewId: review.id,
        productId: review.productId,
        decision: 'reject',
        rejectionReason: BAN_REJECTION_REASON,
        moderatedAt: ctx.now,
        existingWorkflowId: review.workflowId,
      }),
    );
  }
  for (const update of items.updates) {
    add(
      reviewUpdateDecisionStatements(db, {
        ...common,
        updateId: update.id,
        decision: { action: 'reject', reason: BAN_REJECTION_REASON },
        reviewId: update.reviewId,
        productId: update.productId,
        now: ctx.now,
      }),
    );
  }
  const stamps = new Map<string, VendorAuditStamp>();
  for (const response of items.responses) {
    let stamp = stamps.get(response.vendorId);
    if (!stamp) {
      stamp = await vendorAuditStamp(db, response.vendorId);
      stamps.set(response.vendorId, stamp);
    }
    add(
      reviewResponseDecisionStatements(db, {
        ...common,
        responseId: response.id,
        decision: {
          decision: 'reject',
          reason: BAN_REJECTION_REASON,
          expected_updated_at: response.updatedAt,
        },
        vendorId: response.vendorId,
        reviewId: response.reviewId,
        product: response.product,
        now: ctx.now,
        stamp,
      }),
    );
  }
  return out;
}

/**
 * The batch's last statement when a ban rejects pending items. The per-item sentinels
 * catch an item that was decided or edited mid-ban, but an item submitted after
 * {@link loadBanPendingItems} carries none. This one fails the whole batch, ban
 * included, if the person still has anything pending once every reject has run. The
 * route's re-read then answers `409 BAN_PENDING_CHANGED`. It fails as "malformed
 * JSON", like every other sentinel in the batch.
 */
export function noPendingLeftSentinel(db: Db, profileId: string) {
  return db
    .select({
      // Hand-written, aliased SQL: Drizzle renders a column inside `sql` unqualified,
      // and `status` is on all three tables.
      guard: sql`CASE WHEN EXISTS (SELECT 1 FROM reviews AS r WHERE r.reviewer_id = ${profileId} AND r.status = 'pending')
        OR EXISTS (SELECT 1 FROM review_updates AS u INNER JOIN reviews AS ur ON ur.id = u.review_id WHERE ur.reviewer_id = ${profileId} AND u.status = 'pending')
        OR EXISTS (SELECT 1 FROM review_responses AS rr WHERE rr.author_profile_id = ${profileId} AND rr.status = 'pending')
        THEN json('ban-pending-remains') END`,
    })
    .from(ONE_ROW);
}
