/**
 * `POST /api/reviews` (AECI-197 / Phase 5.6) — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 * Auth-gated insert of a `status='pending'` review. `reviewer_id` is the verified
 * token `sub` (server-set); `locale` resolves server-side. Toxicity is scored
 * BEFORE the write (an external call must not sit inside the atomic unit) and is
 * a flag-only triage signal (fail-open to null).
 *
 * D1 has no interactive transactions, so the review insert + its `review_moderation`
 * workflow instance + genesis transition + the `review.submitted` audit row are a
 * single atomic `db.batch([...])` (the §26.1 invariant, AECI-249). Ids are
 * generated up front so nothing depends on batch return values. The best-effort
 * Datadog forwards run AFTER commit via `waitUntil`.
 *
 * Dedup: an app-level pre-check + the DB partial-unique index
 * `reviews_unique_per_user_product` (a row racing past the pre-check trips a
 * UNIQUE violation → mapped to `409 REVIEW_DUPLICATE`, never a 500).
 */

import { ApiErrorCode, SubmitReviewSchema } from '@aeci/shared';
import type { SubmitReviewResponse } from '@aeci/shared';
import { DEFAULT_LOCALE } from '@aeci/shared/algolia';
import {
  forwardAuditLog,
  type AuditLogEntry,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import {
  forwardWorkflowTransition,
  type WorkflowTransitionEntry,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import { and, eq, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import { products, reviews, workflowInstances } from '../db/schema';
import { logToDatadog, submitCount } from '../datadog';
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
import type { DbFactory } from '../lib/handler-utils';
import { scoreToxicity } from '../lib/perspective';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

const KNOWN_LOCALES: ReadonlySet<string> = new Set([DEFAULT_LOCALE]);

function resolveLocale(headerValue: string | undefined): string {
  const value = headerValue?.trim();
  return value && KNOWN_LOCALES.has(value) ? value : DEFAULT_LOCALE;
}

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. */
function makeForwarder(c: AuthContext): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'review-form',
    });
  };
}

/** Datadog forwarder for the workflow-transition write; no-op without `DD_API_KEY`. */
function makeWorkflowForwarder(c: AuthContext): WorkflowTransitionForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`.trim(),
      from_state: entry.fromState ?? undefined,
      to_state: entry.toState,
      workflow_id: entry.workflowId,
      source: 'review-form',
    });
  };
}

async function parseJsonBody<T>(c: AuthContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

/**
 * True when `err` is a UNIQUE violation on the per-user-per-product index. Duck-
 * typed across both the D1 and better-sqlite3 error shapes (message + code) so it
 * stays trivially testable. SQLite reports the columns (`reviews.product_id,
 * reviews.reviewer_id`), not the index name.
 */
function isReviewDuplicateViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown };
  const msg =
    `${typeof e.message === 'string' ? e.message : ''} ${String(e.code ?? '')}`.toLowerCase();
  return msg.includes('unique') && /reviewer_id|reviews_unique_per_user_product/.test(msg);
}

const reviewDuplicateError = (): ApiError =>
  new ApiError(409, ApiErrorCode.REVIEW_DUPLICATE, 'You have already reviewed this product.');

function emitSubmit(c: AuthContext, outcome: 'ok' | 'duplicate' | 'product_not_found'): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.review.submit', 1, [`outcome:${outcome}`]);
}

export function createSubmitReviewHandler(
  dbFor: DbFactory = getDb,
  score: (c: AuthContext, body: string) => Promise<number | null> = scoreToxicity,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;

    const payload = await parseJsonBody(c, SubmitReviewSchema);
    const locale = resolveLocale(c.req.header('x-aeci-locale'));
    const { db } = dbFor(c.env);

    // Product must exist — a loose insert would FK-fail as a 500.
    const product = await db.query.products.findFirst({
      columns: { id: true },
      where: eq(products.id, payload.product_id),
    });
    if (!product) {
      emitSubmit(c, 'product_not_found');
      throw notFoundError('product', { id: payload.product_id });
    }

    // App-level dup pre-check (one non-archived review per product+reviewer); the
    // partial-unique index is the backstop for the race (handled below).
    const existing = await db.query.reviews.findFirst({
      columns: { id: true },
      where: and(
        eq(reviews.productId, payload.product_id),
        eq(reviews.reviewerId, userId),
        ne(reviews.status, 'archived'),
      ),
    });
    if (existing) {
      emitSubmit(c, 'duplicate');
      throw reviewDuplicateError();
    }

    // Toxicity scoring BEFORE the batch — fail-open to null (never auto-reject).
    const toxicityScore = await score(c, payload.body);

    // Ids generated up front so the batch needs no return values.
    const reviewId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();

    const workflowEntry: WorkflowTransitionEntry = {
      workflowId,
      fromState: null,
      toState: 'pending',
      actorId: userId,
      reason: 'review submitted',
      metadata: { source: 'review-form', product_id: payload.product_id },
    };
    const auditEntry: AuditLogEntry = {
      actorId: userId,
      actorType: auditActorType(session),
      action: 'review.submitted',
      entityType: 'review',
      entityId: reviewId,
      metadata: {
        source: 'review-form',
        product_id: payload.product_id,
        toxicity_score: toxicityScore,
      },
    };

    const stmts: BatchStmt[] = [
      db.insert(reviews).values({
        id: reviewId,
        productId: payload.product_id,
        reviewerId: userId,
        ratingOverall: payload.rating_overall,
        ratingOnboarding: payload.rating_onboarding,
        title: payload.title,
        body: payload.body,
        roleAtCompany: payload.role_at_company ?? null,
        yearsUsing: payload.years_using ?? null,
        wouldRecommend: payload.would_recommend ?? null,
        toxicityScore,
        locale,
      }),
      db.insert(workflowInstances).values({
        id: workflowId,
        workflowType: 'review_moderation',
        entityId: reviewId,
        currentState: 'pending',
        initiatedBy: userId,
      }),
      workflowTransitionInsert(db, workflowEntry),
      auditInsert(db, auditEntry),
    ];

    try {
      await db.batch(stmts as BatchTuple);
    } catch (err) {
      // A row racing past the pre-check trips the partial-unique index.
      if (isReviewDuplicateViolation(err)) {
        emitSubmit(c, 'duplicate');
        throw reviewDuplicateError();
      }
      throw err;
    }

    // Best-effort §26.5 forwards AFTER the atomic commit.
    c.executionCtx.waitUntil(
      Promise.all([
        forwardWorkflowTransition(workflowEntry, makeWorkflowForwarder(c)),
        forwardAuditLog(auditEntry, makeForwarder(c)),
      ]),
    );

    emitSubmit(c, 'ok');

    const body: SubmitReviewResponse = {
      id: reviewId,
      status: 'pending',
      message: 'Thanks — your review has been submitted and will appear once approved.',
    };
    return json(body, { status: 201 });
  };
}
