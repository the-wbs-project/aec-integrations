import type { ReviewReplyStatusFilter, ReviewResponseStatus } from '@aeci/shared';

import { readVendorApiError } from '../vendor-api-error';

/**
 * Copy for the portal Reviews tab (AECI-1179, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11c.16). Kept apart from the component so the spec can assert the exact
 * wording and the error map without rendering.
 */

/** The reply state a row shows. `none` is "no reply yet". */
export type ReviewReplyState = 'none' | ReviewResponseStatus;

export function reviewReplyStateLabel(state: ReviewReplyState): string {
  switch (state) {
    case 'none':
      return $localize`:@@vendor.reviews.state.none:No reply`;
    case 'pending':
      return $localize`:@@vendor.reviews.state.pending:Pending approval`;
    case 'published':
      return $localize`:@@vendor.reviews.state.published:Published`;
    case 'rejected':
      return $localize`:@@vendor.reviews.state.rejected:Rejected`;
    case 'withdrawn':
      return $localize`:@@vendor.reviews.state.withdrawn:Withdrawn`;
    case 'removed':
      return $localize`:@@vendor.reviews.state.removed:Removed`;
  }
}

/** One sentence under the pill: what the state means for the public page. */
export function reviewReplyStateHint(state: ReviewReplyState): string {
  switch (state) {
    case 'none':
      return $localize`:@@vendor.reviews.hint.none:You have not replied to this review.`;
    case 'pending':
      return $localize`:@@vendor.reviews.hint.pending:AEC Integrations checks every reply before it shows. Until then it is not on the product page.`;
    case 'published':
      return $localize`:@@vendor.reviews.hint.published:This reply shows under the review on the product page.`;
    case 'rejected':
      return $localize`:@@vendor.reviews.hint.rejected:AEC Integrations did not publish this reply. You can change it and send it again.`;
    case 'withdrawn':
      return $localize`:@@vendor.reviews.hint.withdrawn:You took this reply down. You can send it again.`;
    case 'removed':
      return $localize`:@@vendor.reviews.hint.removed:AEC Integrations took this reply off the product page. It cannot be changed or replaced.`;
  }
}

/** The reply-status filter's options, in the order a vendor works through them. */
export const REVIEW_FILTER_ORDER: readonly ReviewReplyStatusFilter[] = [
  'none',
  'pending',
  'published',
  'rejected',
  'withdrawn',
  'removed',
];

export function reviewFilterLabel(filter: ReviewReplyStatusFilter): string {
  return filter === 'none'
    ? $localize`:@@vendor.reviews.filter.none:No reply yet`
    : reviewReplyStateLabel(filter);
}

/** What the vendor is doing in the reply form. */
export type ReviewComposeMode = 'create' | 'edit' | 'resubmit';

/**
 * The visible message for a failed reply write, by API error code. Every
 * `REVIEW_RESPONSE_*` code, the plan gate and the rate limit are named. A `null`
 * code (offline, a 5xx with no envelope) gets the generic retry line.
 */
export function reviewWriteErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'REVIEW_RESPONSE_EXISTS':
      return $localize`:@@vendor.reviews.error.exists:This review already has your reply, maybe from a colleague. The list now shows it, so you can edit it.`;
    case 'REVIEW_RESPONSE_WRONG_STATE':
      return $localize`:@@vendor.reviews.error.wrongState:This reply changed while you were working on it. The list now shows where it stands.`;
    case 'REVIEW_RESPONSE_REMOVED':
      return $localize`:@@vendor.reviews.error.removed:AEC Integrations removed this reply. It cannot be changed or replaced.`;
    case 'REVIEW_RESPONSE_NO_CHANGE':
      return $localize`:@@vendor.reviews.error.noChange:The reply is the same as before, so nothing was saved. Change the text, or cancel.`;
    case 'ENTITLEMENT_REQUIRED':
      return $localize`:@@vendor.reviews.error.entitlement:Replying to reviews is part of Managed for this product. You can still withdraw a reply.`;
    case 'NOT_FOUND':
      return $localize`:@@vendor.reviews.error.notFound:This review is no longer on the product page. The list now shows what is.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.reviews.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@vendor.reviews.error.invalid:Write a reply of 1 to 2,000 characters.`;
    default:
      return info?.status === 429
        ? $localize`:@@vendor.reviews.error.rate:Too many requests in a short time. Wait a minute and try again.`
        : $localize`:@@vendor.reviews.error.generic:Could not save that. Try again.`;
  }
}

/**
 * True for the refusals after which the list re-reads, because the row's state
 * on screen is no longer the server's (§11c.16, "re-read on 409"). A validation,
 * no-change, rate-limit or plan refusal keeps the form as it is.
 */
export function reviewWriteErrorReloads(err: unknown): boolean {
  const info = readVendorApiError(err);
  return (
    info?.status === 409 ||
    info?.code === 'REVIEW_RESPONSE_EXISTS' ||
    info?.code === 'REVIEW_RESPONSE_WRONG_STATE' ||
    info?.code === 'REVIEW_RESPONSE_REMOVED' ||
    info?.code === 'NOT_FOUND'
  );
}
