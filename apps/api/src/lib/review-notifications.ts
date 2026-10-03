/**
 * Vendor notifications for reviews and replies (AECI-1180 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.12): the pieces the two admin moderation
 * routes, the notification feed and the specs share.
 *
 * Two feed members, both `notification.sent` audit rows like every other row of
 * `GET /api/vendor/notifications` (there is no notifications table):
 *
 *   - **`review`** (registry id `portal-review`): a review of a product the vendor
 *     owns was approved. One row per owning vendor in `product_vendors`, primary or
 *     not, written in the approve batch of `PATCH /api/admin/reviews/:id`. A vendor
 *     with no seat still gets its row, so the feed is complete when it is seated. Not
 *     plan-gated. The seats are also emailed post-commit
 *     ({@link emailOwnersOfApprovedReview}, registry id `vendor-review-published`).
 *   - **`review_response`** (registry id `portal-review-response`): AECi approved,
 *     rejected or removed the vendor's reply. One row to the reply's vendor, in the
 *     decision batch of `PATCH /api/admin/review-responses/:id`. No email, as for
 *     contests (§11b.8).
 *
 * Every row records its registry id as `metadata.notificationId` (AECI-1199,
 * `lib/notifications/registry.ts`).
 *
 * The rows carry no reviewer data. `metadata.vendorId` is the RECIPIENT, which is
 * what the feed's `json_extract(metadata, '$.vendorId')` filter matches. There is
 * no notice to the reviewer in this version (§11c.12, ruling 3).
 */

import type { ReviewResponseDecision, ReviewResponseNotificationEvent } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from '@aeci/shared/concurrency';
import { asc, eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { productVendors, vendors } from '../db/schema';
import { logToPosthog } from '../posthog';
import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import { sendVendorReviewPublishedEmail, type EmailContext } from './email';
import type { PortalNotificationId } from './notifications/registry';
import { REVIEW_RESPONSE_ENTITY_TYPE } from './review-responses';
import { loadVendorSeatRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

/** The registry id a review-approval feed row records. */
export type ReviewPortalNotificationId = Extract<PortalNotificationId, 'portal-review'>;

/** The registry id a reply-decision feed row records. */
export type ReviewResponsePortalNotificationId = Extract<
  PortalNotificationId,
  'portal-review-response'
>;

/** `vendor-review-published:{reviewId}:{profileId}`. Per seat, because the ledger key
 *  is unique across all sends and each seat is its own send (AECI-1202). */
export const vendorReviewPublishedKey = (reviewId: string, profileId: string) =>
  `vendor-review-published:${reviewId}:${profileId}`;

/** `metadata.kind` on the row a review approval writes. */
export const REVIEW_NOTIFICATION_KIND = 'review';

/** `metadata.kind` on the row an admin reply decision writes. */
export const REVIEW_RESPONSE_NOTIFICATION_KIND = 'review_response';

/** The product as the rows snapshot it. */
export interface NotifiedProduct {
  id: string;
  slug: string;
  name: string;
}

/** What a `review` row records. Every field is a snapshot taken at approval. */
export interface ReviewNotificationMetadata {
  kind: typeof REVIEW_NOTIFICATION_KIND;
  /** The registry entry (AECI-1199). */
  notificationId: ReviewPortalNotificationId;
  vendorId: string;
  reviewId: string;
  productId: string;
  product: { slug: string; name: string };
  reviewTitle: string;
}

/** What a `review_response` row records. `reason` only on reject and remove. */
export interface ReviewResponseNotificationMetadata {
  kind: typeof REVIEW_RESPONSE_NOTIFICATION_KIND;
  /** The registry entry (AECI-1199). */
  notificationId: ReviewResponsePortalNotificationId;
  vendorId: string;
  event: ReviewResponseNotificationEvent;
  responseId: string;
  reviewId: string;
  productId: string;
  product: { slug: string; name: string };
  reason?: string;
}

/** The event each admin decision tells the vendor about. */
export const REVIEW_RESPONSE_NOTIFICATION_EVENT = {
  approve: 'approved',
  reject: 'rejected',
  remove: 'removed',
} as const satisfies Record<ReviewResponseDecision, ReviewResponseNotificationEvent>;

type Actor = { actorId: string | null; actorType: AuditLogEntry['actorType'] };

// ─── Recipients ──────────────────────────────────────────────────────────────

/** One owning vendor of a product: a recipient of the `review` notice. */
export interface ReviewOwner {
  vendorId: string;
  vendorSlug: string;
}

/**
 * Every vendor that owns the product in `product_vendors`, primary or not
 * (ruling 4). Nothing else decides who is told: not the plan, not a seat, not the
 * primary flag. Ordered by vendor id so the batch is deterministic.
 */
export async function loadReviewOwners(db: Db, productId: string): Promise<ReviewOwner[]> {
  return db
    .select({ vendorId: vendors.id, vendorSlug: vendors.slug })
    .from(productVendors)
    .innerJoin(vendors, eq(vendors.id, productVendors.vendorId))
    .where(eq(productVendors.productId, productId))
    .orderBy(asc(vendors.id));
}

// ─── The feed rows ───────────────────────────────────────────────────────────

/**
 * The `notification.sent` rows for one approved review: one per owner. Push them
 * into the approve batch AFTER the guarded `UPDATE`, so they commit with it and a
 * failed batch leaves none. `entity_type` is `review` and `entity_id` the review.
 */
export function reviewApprovedNotifications(
  notification: ReviewPortalNotificationId,
  actor: Actor,
  owners: readonly ReviewOwner[],
  review: { id: string; title: string; product: NotifiedProduct },
): AuditLogEntry[] {
  return owners.map((owner) => {
    const metadata: ReviewNotificationMetadata = {
      kind: REVIEW_NOTIFICATION_KIND,
      notificationId: notification,
      vendorId: owner.vendorId,
      reviewId: review.id,
      productId: review.product.id,
      product: { slug: review.product.slug, name: review.product.name },
      reviewTitle: review.title,
    };
    return {
      actorId: actor.actorId,
      actorType: actor.actorType,
      action: NOTIFICATION_SENT_ACTION,
      entityType: 'review',
      entityId: review.id,
      metadata,
    };
  });
}

/**
 * The `notification.sent` row for one admin decision on a reply, to the reply's
 * vendor. `entity_type` is `review_response` and `entity_id` the reply.
 */
export function reviewResponseDecisionNotification(
  notification: ReviewResponsePortalNotificationId,
  actor: Actor,
  input: {
    responseId: string;
    decision: ReviewResponseDecision;
    vendorId: string;
    reviewId: string;
    product: NotifiedProduct;
    reason: string | null;
  },
): AuditLogEntry {
  const metadata: ReviewResponseNotificationMetadata = {
    kind: REVIEW_RESPONSE_NOTIFICATION_KIND,
    notificationId: notification,
    vendorId: input.vendorId,
    event: REVIEW_RESPONSE_NOTIFICATION_EVENT[input.decision],
    responseId: input.responseId,
    reviewId: input.reviewId,
    productId: input.product.id,
    product: { slug: input.product.slug, name: input.product.name },
    ...(input.reason ? { reason: input.reason } : {}),
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: REVIEW_RESPONSE_ENTITY_TYPE,
    entityId: input.responseId,
    metadata,
  };
}

// ─── The email ───────────────────────────────────────────────────────────────

/** What the email needs about the approved review. No reviewer data. */
export interface ApprovedReviewForEmail {
  id: string;
  title: string;
  ratingOverall: number;
  ratingOnboarding: number;
  product: NotifiedProduct;
}

/**
 * Email every owning vendor's seats about one approved review (§11c.12). Runs
 * post-commit inside `ctx.waitUntil`, and NEVER throws: a failure warns and the
 * moderation response is already decided.
 *
 * - Seats are the unbanned `vendor_admin` profiles of each owner, with addresses
 *   from `fetchAuthUserEmails` (itself bounded), read by `loadVendorSeatRecipients`.
 *   No mute applies: the AECI-1204 nudge mute covers the attestation digest only.
 *   An owner with no seat, or no resolvable address, is simply not emailed. Its
 *   feed row still exists.
 * - The vendors fan out under `mapWithConcurrency(…, WORKER_CONNECTION_LIMIT, …)`,
 *   and a vendor's seats are sent one after another, so at most that many sends
 *   are in flight. `sendTransactionalEmail` releases every Resend response body.
 * - Each seat's send carries the dedupe key {@link vendorReviewPublishedKey}, so a
 *   replay of the same approval is a `duplicate` with no Resend call (AECI-1202).
 *   Outside production the tier policy suppresses every outside address (AECI-1198).
 */
export async function emailOwnersOfApprovedReview(
  c: EmailContext,
  db: Db,
  owners: readonly ReviewOwner[],
  review: ApprovedReviewForEmail,
  fetchSeatEmails: FetchSeatEmails,
): Promise<void> {
  if (owners.length === 0) return;
  try {
    const seatsByVendor = await loadVendorSeatRecipients(
      db,
      c.env,
      owners.map((o) => o.vendorId),
      fetchSeatEmails,
    );
    const reachable = owners.filter((o) => (seatsByVendor.get(o.vendorId) ?? []).length > 0);
    const results = await mapWithConcurrency(reachable, WORKER_CONNECTION_LIMIT, async (owner) => {
      for (const seat of seatsByVendor.get(owner.vendorId) ?? []) {
        await sendVendorReviewPublishedEmail(c, {
          to: seat.email,
          vendorSlug: owner.vendorSlug,
          reviewId: review.id,
          dedupeKey: vendorReviewPublishedKey(review.id, seat.profileId),
          productName: review.product.name,
          productSlug: review.product.slug,
          title: review.title,
          ratingOverall: review.ratingOverall,
          ratingOnboarding: review.ratingOnboarding,
        });
      }
    });
    for (const result of results) {
      if (result.status === 'rejected') warn(c, result.reason);
    }
  } catch (error) {
    warn(c, error);
  }
}

function warn(c: EmailContext, error: unknown): void {
  logToPosthog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message: 'review-published vendor email failed',
    source: 'review-notifications',
    outcome: error instanceof Error ? error.message : String(error),
  });
}
