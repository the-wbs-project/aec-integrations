/**
 * Reviewer updates to published reviews — the shared server pieces (AECI-1613,
 * `STAGE_1_SPEC.md` §4.7a, `DATABASE_SCHEMA.md` §7.4).
 *
 * The reviewer route (`routes/account-review-updates.ts`), the admin queue
 * (`routes/admin-review-updates.ts`), the vendor `reviews` cursor and both public
 * review reads import from here, so each rule has one home:
 *
 *   - {@link publishedReviewUpdatesQuery}: the public render predicate (the update is
 *     `approved` and its review is `approved`) and the public order,
 *     `published_at ASC, id ASC`. {@link loadPublishedReviewUpdates} runs it for an
 *     id list.
 *   - {@link withPublicReviewExtras} / {@link attachReviewExtras}: the one mapper both
 *     public review reads use, so the list and the product-detail embed cannot drift.
 *   - {@link reviewUpdateChangedSentinel}: the `changes()` abort every admin decision
 *     batch carries right after its guarded write.
 *
 * Nothing here writes `reviews` and nothing here reads a count or a ranking column.
 * The only ranking reach of `review_updates` is the averages rule in
 * `lib/recompute-counts.ts` (`review-reply-ranking-firewall.spec.ts`).
 */

import type {
  AccountReviewUpdate,
  PublicReview,
  PublicReviewUpdate,
  PublicVendorResponse,
  ReviewUpdateDecision,
  ReviewUpdateStatus,
} from '@aeci/shared';
import { and, asc, eq, inArray, isNotNull, sql, type SQLWrapper } from 'drizzle-orm';

import type { Db } from '../db/client';
import { reviewUpdates, reviews } from '../db/schema';
import { toPublicReview, type RawPublicReviewRow } from './drizzle-helpers';
import { ONE_ROW } from './integration-claims';
import { chunked } from './promote-claims';
import { loadPublishedVendorResponses } from './review-responses';

/** `audit_log.entity_type` on every update transition. */
export const REVIEW_UPDATE_ENTITY_TYPE = 'review_update';

/** The audit actions. The reviewer writes the first; an admin the other three. */
export const REVIEW_UPDATE_ACTIONS = {
  submitted: 'review_update.submitted',
  approved: 'review_update.approved',
  rejected: 'review_update.rejected',
  removed: 'review_update.removed',
} as const;

/** The audit action each admin decision writes. */
export const REVIEW_UPDATE_DECISION_ACTIONS = {
  approve: REVIEW_UPDATE_ACTIONS.approved,
  reject: REVIEW_UPDATE_ACTIONS.rejected,
  remove: REVIEW_UPDATE_ACTIONS.removed,
} as const satisfies Record<ReviewUpdateDecision, string>;

/** The token {@link reviewUpdateChangedSentinel} raises on. */
export const REVIEW_UPDATE_CHANGED_TOKEN = 'review-update-changed';

export type ReviewUpdateRow = typeof reviewUpdates.$inferSelect;

/**
 * The batch statement that ABORTS an update decision when the guarded
 * `UPDATE … WHERE id = ? AND status = <from>` before it changed no row. Push it
 * IMMEDIATELY after the guarded write, and the audit row after it. The loser of a
 * two-admin race then commits nothing: no audit row, no feed row, no purge, no
 * email. The `reviewResponseChangedSentinel` pattern: `json()` on a non-JSON token
 * raises and rolls the batch back; FROM a one-row constant so it is evaluated once.
 */
export function reviewUpdateChangedSentinel(db: Db) {
  return db
    .select({
      guard: sql`CASE WHEN changes() = 0 THEN json(${REVIEW_UPDATE_CHANGED_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/** Did a batch fail because {@link reviewUpdateChangedSentinel} fired? SQLite
 *  reports only "malformed JSON", and the sentinel is the only `json()` call in a
 *  decision batch, so the match is unambiguous. */
export function isReviewUpdateRaceError(error: unknown): boolean {
  return causeChainMatches(error, /malformed JSON/i);
}

/** Did a submit INSERT lose to another submit of the same review on the partial
 *  unique index `review_updates_one_pending_key`? SQLite names the column, not the
 *  index. */
export function isReviewUpdatePendingConflict(error: unknown): boolean {
  return causeChainMatches(
    error,
    /review_updates_one_pending_key|UNIQUE constraint failed: review_updates\.review_id/,
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

/** The reviewer's own update on the wire. The moderator and the toxicity score
 *  never cross it. */
export function toAccountReviewUpdate(row: ReviewUpdateRow): AccountReviewUpdate {
  return {
    id: row.id,
    status: row.status as ReviewUpdateStatus,
    body: row.body,
    rating_overall: row.ratingOverall,
    rating_onboarding: row.ratingOnboarding,
    rejection_reason: row.rejectionReason,
    published_at: row.publishedAt,
    moderated_at: row.moderatedAt,
    created_at: row.createdAt,
  };
}

/**
 * Every update of the given reviews, any status, keyed by review id, oldest first.
 * The reviewer's own list (`GET /api/account/reviews`). The caller has already
 * scoped the review ids to the session's own reviews.
 */
export async function loadAccountReviewUpdates(
  db: Db,
  reviewIds: readonly string[],
): Promise<Map<string, AccountReviewUpdate[]>> {
  if (reviewIds.length === 0) return new Map();
  const chunks = await Promise.all(
    chunked([...new Set(reviewIds)]).map((ids) =>
      db
        .select()
        .from(reviewUpdates)
        .where(inArray(reviewUpdates.reviewId, ids))
        .orderBy(asc(reviewUpdates.createdAt), asc(reviewUpdates.id)),
    ),
  );
  const out = new Map<string, AccountReviewUpdate[]>();
  for (const row of chunks.flat()) {
    const list = out.get(row.reviewId) ?? [];
    list.push(toAccountReviewUpdate(row));
    out.set(row.reviewId, list);
  }
  return out;
}

/**
 * The one query for published updates. Both rules in SQL: the update is
 * `approved` with a `published_at`, and its review is `approved`. Ordered
 * `published_at ASC, id ASC`. Body, ratings and date only: no reviewer data.
 *
 * `reviewIds` is an id list or a subquery of review ids. Product detail passes the
 * subquery of its first review page so the updates ride its one `db.batch`.
 */
export function publishedReviewUpdatesQuery(db: Db, reviewIds: readonly string[] | SQLWrapper) {
  return db
    .select({
      id: reviewUpdates.id,
      reviewId: reviewUpdates.reviewId,
      body: reviewUpdates.body,
      ratingOverall: reviewUpdates.ratingOverall,
      ratingOnboarding: reviewUpdates.ratingOnboarding,
      publishedAt: reviewUpdates.publishedAt,
    })
    .from(reviewUpdates)
    .innerJoin(reviews, eq(reviews.id, reviewUpdates.reviewId))
    .where(
      and(
        inArray(reviewUpdates.reviewId, reviewIds),
        eq(reviewUpdates.status, 'approved'),
        isNotNull(reviewUpdates.publishedAt),
        eq(reviews.status, 'approved'),
      ),
    )
    .orderBy(asc(reviewUpdates.publishedAt), asc(reviewUpdates.id));
}

type PublishedReviewUpdateRow = Awaited<ReturnType<typeof publishedReviewUpdatesQuery>>[number];

/** Pure. Group {@link publishedReviewUpdatesQuery} rows by review id, keeping the
 *  rows' order inside each list. */
export function groupReviewUpdates(
  rows: readonly PublishedReviewUpdateRow[],
): Map<string, PublicReviewUpdate[]> {
  const out = new Map<string, PublicReviewUpdate[]>();
  for (const row of rows) {
    const list = out.get(row.reviewId) ?? [];
    list.push({
      body: row.body,
      rating_overall: row.ratingOverall,
      rating_onboarding: row.ratingOnboarding,
      published_at: row.publishedAt!,
    });
    out.set(row.reviewId, list);
  }
  return out;
}

/** Published updates for a set of review ids, keyed by review id, in public order.
 *  Chunked under D1's 100-bound-parameter cap. */
export async function loadPublishedReviewUpdates(
  db: Db,
  reviewIds: readonly string[],
): Promise<Map<string, PublicReviewUpdate[]>> {
  if (reviewIds.length === 0) return new Map();
  const chunks = await Promise.all(
    chunked([...new Set(reviewIds)]).map((ids) => publishedReviewUpdatesQuery(db, ids)),
  );
  // A review's updates all fall in the chunk that holds its id, so appending keeps
  // each list ordered.
  return groupReviewUpdates(chunks.flat());
}

/**
 * Map a page of approved review rows to `PublicReview`, each with its published
 * vendor replies (§11c.14) and its approved reviewer updates (AECI-1613). The one
 * helper behind `GET /api/products/:slug/reviews`. Product detail loads the same two
 * lists inside its own batch and calls {@link attachReviewExtras} directly.
 *
 * Two extra queries per page, run together, never one per review. The rows keep
 * their order, and the review's own fields are exactly what they are without an
 * update: the original stays as it was published.
 */
export async function withPublicReviewExtras(
  db: Db,
  rows: readonly RawPublicReviewRow[],
): Promise<PublicReview[]> {
  const ids = rows.map((r) => r.id);
  const [replies, updates] = await Promise.all([
    loadPublishedVendorResponses(db, ids),
    loadPublishedReviewUpdates(db, ids),
  ]);
  return attachReviewExtras(rows, replies, updates);
}

/** Pure. The mapping half of {@link withPublicReviewExtras}. */
export function attachReviewExtras(
  rows: readonly RawPublicReviewRow[],
  repliesByReview: ReadonlyMap<string, PublicVendorResponse[]>,
  updatesByReview: ReadonlyMap<string, PublicReviewUpdate[]>,
): PublicReview[] {
  return rows.map((row) => ({
    ...toPublicReview(row),
    vendor_responses: repliesByReview.get(row.id) ?? [],
    updates: updatesByReview.get(row.id) ?? [],
  }));
}
