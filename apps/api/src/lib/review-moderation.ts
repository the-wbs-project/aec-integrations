/**
 * Review moderation: the statement builder for an approve or reject of a `pending`
 * review (AECI-204, AECI-1203, AECI-1949).
 *
 * Two callers assemble the same batch, so the rule has one home:
 *
 *   - `PATCH /api/admin/reviews/:id` (`routes/admin-reviews.ts`), one review at a
 *     time, with its email and post-commit work kept in the route;
 *   - `PATCH /api/admin/reviewers/:id` with `reject_pending: true`
 *     (`routes/admin-reviewers.ts`), which rejects every pending review of the
 *     banned person inside the ban's own batch and sends no review email (ruling 1
 *     of 2026-11-26).
 *
 * The same holds for the other two pending kinds, a reviewer's update to a published
 * review ({@link reviewUpdateDecisionStatements}) and a vendor reply
 * ({@link reviewResponseDecisionStatements}).
 *
 * The builders send nothing and read nothing. The caller preloads what each needs: a
 * review's `review_moderation` instance id (find-or-create cannot be conditional
 * inside a batch), a reply's `updated_at` and its vendor's audit stamp.
 */

type Actor = { actorId: string; actorType: AuditLogEntry['actorType'] };

import {
  REVIEW_RESPONSE_DECISIONS,
  REVIEW_UPDATE_DECISIONS,
  type DecideReviewResponseInput,
  type DecideReviewUpdateInput,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { reviewResponses, reviewUpdates, reviews, workflowInstances } from '../db/schema';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from './audit';
import type { VendorAuditStamp } from './audit-vendor';
import { ONE_ROW } from './integration-claims';
import { reviewResponseDecisionNotification } from './review-notifications';
import {
  REVIEW_RESPONSE_DECISION_ACTIONS,
  REVIEW_RESPONSE_ENTITY_TYPE,
  reviewResponseChangedSentinel,
} from './review-responses';
import {
  REVIEW_UPDATE_DECISION_ACTIONS,
  REVIEW_UPDATE_ENTITY_TYPE,
  reviewUpdateChangedSentinel,
} from './review-updates';

/** The statements of one moderation and the entries they insert, for the
 *  post-commit forward (`forwardAuditBatch`). */
export interface ModerationBatch {
  stmts: BatchStmt[];
  audits: AuditLogEntry[];
  transitions: WorkflowTransitionEntry[];
}

export interface ReviewDecisionInput {
  reviewId: string;
  productId: string;
  decision: 'approve' | 'reject';
  /** Required on reject, `null` on approve. */
  rejectionReason: string | null;
  moderatedAt: string;
  actor: Actor;
  /** The preloaded `review_moderation` instance, or `null` when the review has none
   *  (reviews older than the AECI-210 retrofit). */
  existingWorkflowId: string | null;
  /** `audit_log.metadata.source`. Default `admin-moderation`. */
  source?: string;
  /** Merged into the audit and transition metadata after the default keys. */
  extraMetadata?: Record<string, unknown>;
  /** Rows that ride the batch after the transition (the approve's vendor feed). */
  notifications?: readonly AuditLogEntry[];
}

/**
 * One approve or reject of a `pending` review: the guarded `UPDATE … WHERE
 * status='pending'`, {@link reviewStillInStateSentinel} straight after it, the
 * `review.approved|rejected` audit row, the `review_moderation` instance completed
 * (found or created), the `pending → approved|rejected` transition, then the
 * notification rows. A lost race aborts the whole batch at the sentinel.
 */
export function reviewDecisionStatements(db: Db, input: ReviewDecisionInput): ModerationBatch {
  const { reviewId: id, productId, rejectionReason, moderatedAt, actor } = input;
  const approve = input.decision === 'approve';
  const newStatus = approve ? 'approved' : 'rejected';
  const workflowId = input.existingWorkflowId ?? crypto.randomUUID();
  const source = input.source ?? 'admin-moderation';
  const metadata = (): Record<string, unknown> => ({
    source,
    product_id: productId,
    ...(approve ? {} : { rejection_reason: rejectionReason }),
    ...input.extraMetadata,
  });

  const auditEntry: AuditLogEntry = {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: approve ? 'review.approved' : 'review.rejected',
    entityType: 'review',
    entityId: id,
    // AECI-1192: the product the review is about. A review is not vendor-held, so
    // there is no `vendor_id`.
    productId,
    metadata: metadata(),
  };
  const workflowEntry: WorkflowTransitionEntry = {
    workflowId,
    fromState: 'pending',
    toState: newStatus,
    actorId: actor.actorId,
    reason: rejectionReason,
    metadata: metadata(),
  };
  const notifications = input.notifications ?? [];

  const stmts: BatchStmt[] = [
    db
      .update(reviews)
      .set({
        status: newStatus,
        moderatedBy: actor.actorId,
        moderatedAt,
        ...(approve ? {} : { rejectionReason }),
      })
      .where(and(eq(reviews.id, id), eq(reviews.status, 'pending'))),
    // Directly after the UPDATE: `changes()` must read the guarded write.
    reviewStillInStateSentinel(db),
    auditInsert(db, auditEntry),
    input.existingWorkflowId
      ? db
          .update(workflowInstances)
          .set({ currentState: newStatus, completedAt: moderatedAt, finalOutcome: newStatus })
          .where(eq(workflowInstances.id, workflowId))
      : db.insert(workflowInstances).values({
          id: workflowId,
          workflowType: 'review_moderation',
          entityId: id,
          currentState: newStatus,
          completedAt: moderatedAt,
          finalOutcome: newStatus,
        }),
    workflowTransitionInsert(db, workflowEntry),
    ...notifications.map((entry) => auditInsert(db, entry)),
  ];
  return { stmts, audits: [auditEntry, ...notifications], transitions: [workflowEntry] };
}

// ─── Review updates (AECI-1613) ──────────────────────────────────────────────

export interface ReviewUpdateDecisionInput {
  updateId: string;
  decision: DecideReviewUpdateInput;
  reviewId: string;
  productId: string;
  actor: Actor;
  now: string;
  /** `audit_log.metadata.source`. Default `admin-moderation`. */
  source?: string;
  /** Merged into the audit metadata after the default keys. */
  extraMetadata?: Record<string, unknown>;
  /** The approve's vendor feed rows, after the audit row. */
  notifications?: readonly AuditLogEntry[];
}

/** The columns one update decision writes. */
function reviewUpdateDecisionColumns(
  decision: DecideReviewUpdateInput,
  adminId: string,
  now: string,
): Partial<typeof reviewUpdates.$inferInsert> {
  const to = REVIEW_UPDATE_DECISIONS[decision.action].to;
  const base = { status: to, moderatedBy: adminId, moderatedAt: now, updatedAt: now };
  switch (decision.action) {
    case 'approve':
      return { ...base, publishedAt: now };
    case 'reject':
      return { ...base, rejectionReason: decision.reason };
    case 'remove':
      return { ...base, rejectionReason: decision.reason, publishedAt: null };
  }
}

/**
 * One decision on a reviewer update: the guarded `UPDATE … WHERE id = ? AND status =
 * <from>`, `reviewUpdateChangedSentinel` straight after it, the audit row, then the
 * notification rows. No workflow row: the state lives in `review_updates.status`.
 */
export function reviewUpdateDecisionStatements(
  db: Db,
  input: ReviewUpdateDecisionInput,
): ModerationBatch {
  const { updateId: id, decision, actor } = input;
  const plan = REVIEW_UPDATE_DECISIONS[decision.action];
  const reason = decision.action === 'approve' ? null : decision.reason;
  const audit: AuditLogEntry = {
    ...actor,
    action: REVIEW_UPDATE_DECISION_ACTIONS[decision.action],
    entityType: REVIEW_UPDATE_ENTITY_TYPE,
    entityId: id,
    productId: input.productId,
    beforeState: { status: plan.from },
    afterState: { status: plan.to, ...(reason ? { rejection_reason: reason } : {}) },
    metadata: {
      source: input.source ?? 'admin-moderation',
      reviewId: input.reviewId,
      productId: input.productId,
      ...(reason ? { reason } : {}),
      ...input.extraMetadata,
    },
  };
  const notifications = input.notifications ?? [];
  const stmts: BatchStmt[] = [
    db
      .update(reviewUpdates)
      .set(reviewUpdateDecisionColumns(decision, actor.actorId, input.now))
      .where(and(eq(reviewUpdates.id, id), eq(reviewUpdates.status, plan.from))),
    // Immediately after the guarded UPDATE: a lost race aborts here, before the
    // audit row and the feed rows.
    reviewUpdateChangedSentinel(db),
    auditInsert(db, audit),
    ...notifications.map((entry) => auditInsert(db, entry)),
  ];
  return { stmts, audits: [audit, ...notifications], transitions: [] };
}

// ─── Vendor replies (AECI-1177) ──────────────────────────────────────────────

/** What a decision batch knows about the reply it decides. */
export interface ReviewResponseDecisionContext {
  responseId: string;
  decision: DecideReviewResponseInput['decision'];
  /** The reply's vendor: the recipient of the decision notice. */
  vendorId: string;
  reviewId: string;
  /** The reviewed product, snapshotted onto the feed row. */
  product: { id: string; slug: string; name: string };
  /** The reason on a reject or remove; `null` on approve. */
  reason: string | null;
  actor: Actor;
}

/**
 * The vendor's `notification.sent` rows for one decision (§11c.12, AECI-1180). They
 * ride the decision batch AFTER the sentinel and the audit row, so a lost race
 * commits none.
 *
 * Exactly one row, to the reply's vendor: `metadata.kind = 'review_response'`,
 * `metadata.event` (`approved | rejected | removed`), and `metadata.reason` on
 * reject and remove. No email follows a decision, as for contests (§11b.8).
 */
export function reviewResponseDecisionNotifications(
  ctx: ReviewResponseDecisionContext,
): AuditLogEntry[] {
  return [
    reviewResponseDecisionNotification('portal-review-response', ctx.actor, {
      responseId: ctx.responseId,
      decision: ctx.decision,
      vendorId: ctx.vendorId,
      reviewId: ctx.reviewId,
      product: ctx.product,
      reason: ctx.reason,
    }),
  ];
}

export interface ReviewResponseDecisionInput {
  responseId: string;
  /** Carries `expected_updated_at`, the version the guarded UPDATE matches. */
  decision: DecideReviewResponseInput;
  vendorId: string;
  reviewId: string;
  product: { id: string; slug: string; name: string };
  actor: Actor;
  now: string;
  /** `vendorAuditStamp(db, vendorId)`, read by the caller. */
  stamp: VendorAuditStamp;
  /** `audit_log.metadata.source`. Default `admin-moderation`. */
  source?: string;
  /** Merged into the audit metadata after the default keys. */
  extraMetadata?: Record<string, unknown>;
}

/** The columns one reply decision writes (§11c.6 "Columns per transition"). */
function reviewResponseDecisionColumns(
  decision: DecideReviewResponseInput,
  adminId: string,
  now: string,
): Partial<typeof reviewResponses.$inferInsert> {
  const to = REVIEW_RESPONSE_DECISIONS[decision.decision].to;
  const base = { status: to, moderatedBy: adminId, moderatedAt: now, updatedAt: now };
  switch (decision.decision) {
    case 'approve':
      return { ...base, publishedAt: now };
    case 'reject':
      return { ...base, rejectionReason: decision.reason };
    case 'remove':
      return { ...base, rejectionReason: decision.reason, publishedAt: null };
  }
}

/**
 * One decision on a vendor reply: the guarded `UPDATE … WHERE id = ? AND status =
 * <from> AND updated_at = <expected>`, `reviewResponseChangedSentinel` straight
 * after it, the audit row, then the vendor's portal notice (§11c.7).
 */
export function reviewResponseDecisionStatements(
  db: Db,
  input: ReviewResponseDecisionInput,
): ModerationBatch {
  const { responseId: id, decision, actor } = input;
  const plan = REVIEW_RESPONSE_DECISIONS[decision.decision];
  const reason = decision.decision === 'approve' ? null : decision.reason;
  const audit: AuditLogEntry = {
    ...actor,
    action: REVIEW_RESPONSE_DECISION_ACTIONS[decision.decision],
    entityType: REVIEW_RESPONSE_ENTITY_TYPE,
    entityId: id,
    // AECI-1192 / AECI-1193: the reply is the vendor's, about one product.
    ...input.stamp,
    productId: input.product.id,
    beforeState: { status: plan.from },
    afterState: { status: plan.to, ...(reason ? { rejection_reason: reason } : {}) },
    metadata: {
      source: input.source ?? 'admin-moderation',
      vendorId: input.vendorId,
      reviewId: input.reviewId,
      productId: input.product.id,
      ...(reason ? { reason } : {}),
      ...input.extraMetadata,
    },
  };
  const notifications = reviewResponseDecisionNotifications({
    responseId: id,
    decision: decision.decision,
    vendorId: input.vendorId,
    reviewId: input.reviewId,
    product: input.product,
    reason,
    actor,
  });
  const stmts: BatchStmt[] = [
    db
      .update(reviewResponses)
      .set(reviewResponseDecisionColumns(decision, actor.actorId, input.now))
      .where(
        and(
          eq(reviewResponses.id, id),
          eq(reviewResponses.status, plan.from),
          eq(reviewResponses.updatedAt, decision.expected_updated_at),
        ),
      ),
    // Immediately after the guarded UPDATE: a lost race aborts here, before the
    // audit row and the notification.
    reviewResponseChangedSentinel(db),
    auditInsert(db, audit),
    ...notifications.map((entry) => auditInsert(db, entry)),
  ];
  return { stmts, audits: [audit, ...notifications], transitions: [] };
}

// ─── The review sentinel ─────────────────────────────────────────────────────

/**
 * A batch statement that ABORTS the moderation batch when the guarded
 * `UPDATE … WHERE status = <from>` just before it changed no row (AECI-1203): another
 * moderator moved the review out of the action's from-state (`pending` for approve and
 * reject, `approved` for remove, AECI-1643) between this handler's read and its batch.
 * Modelled on
 * `contestStillOpenSentinel` (`lib/integration-contests.ts`). `changes()` is the row
 * count of the connection's last write, which inside the batch is the guarded UPDATE.
 * When it is 0, `json('review-not-in-state')` is malformed JSON and raises, so the audit
 * row and the workflow writes roll back with it. FROM a one-row constant, so the guard
 * is evaluated exactly once.
 */
export function reviewStillInStateSentinel(db: Db) {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json('review-not-in-state') END` })
    .from(ONE_ROW);
}

/**
 * True for the error {@link reviewStillInStateSentinel} raises, in D1 or SQLite. SQLite
 * reports only "malformed JSON" and never echoes the token. Nothing else in the
 * moderation batch calls `json()`, so the match is unambiguous.
 */
export function isReviewRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (/malformed JSON/i.test(String((current as { message?: unknown }).message ?? current))) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
