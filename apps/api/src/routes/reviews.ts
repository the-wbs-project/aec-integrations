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
 * §26.5 forwards run AFTER commit via `waitUntil`.
 *
 * The body is scored for toxicity via Anthropic Claude before the insert and the
 * result stored in `toxicity_score` (AECI-258, supersedes the AECI-198 / Phase
 * 5.7 Perspective path, `lib/toxicity.ts`). It is a moderation-queue triage
 * signal only — **flag, never auto-reject** — and fail-open: an outage (or no
 * key) stores `null` and the review still enters the queue. The score is
 * admin-only and never appears in the submit response.
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
import { and, count, eq, gte, ne } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import { products, reviews, workflowInstances } from '../db/schema';
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
import { sendReviewSubmittedEmail } from '../lib/email';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { scoreToxicity } from '../lib/toxicity';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/**
 * `STAGE_1_SPEC.md` §15.1: "Rate limit on `/api/reviews` POST: 3 per
 * authenticated user per hour". AECI-773 is the first time this is honoured
 * literally. It never could be at the edge — Cloudflare Pro WAF counts by client
 * IP only (per-user is an Enterprise feature) AND its window maxes at one
 * minute, so Rule B has only ever been a per-minute per-IP approximation of an
 * hourly per-user intent. The native `ratelimits` binding fixes the first half
 * (`rateLimit('write')` on this route is per user) but not the second: its
 * `simple.period` is a strict enum of 10 or 60 seconds. So the hourly half is a
 * D1 count, on the shipped `INVITE_DAILY_LIMIT` model
 * (`routes/vendor-seat-invites.ts`) — counted over a table we already have,
 * with no KV, no Durable Object, and no new binding.
 */
export const REVIEW_HOURLY_LIMIT = 3;
const REVIEW_LIMIT_WINDOW_MS = 3_600_000;

const KNOWN_LOCALES: ReadonlySet<string> = new Set([DEFAULT_LOCALE]);

function resolveLocale(headerValue: string | undefined): string {
  const value = headerValue?.trim();
  return value && KNOWN_LOCALES.has(value) ? value : DEFAULT_LOCALE;
}

/** Telemetry forwarder (PostHog + the dual-run Datadog leg) for the audit write; each vendor leg no-ops without its own key. */
function makeForwarder(c: AuthContext): AuditLogForwarder | undefined {
  if (!c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'review-form',
    });
  };
}

/** Telemetry forwarder (PostHog + the dual-run Datadog leg) for the workflow-transition write; each vendor leg no-ops without its own key. */
function makeWorkflowForwarder(c: AuthContext): WorkflowTransitionForwarder | undefined {
  if (!c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
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

function emitSubmit(
  c: AuthContext,
  outcome: 'ok' | 'duplicate' | 'product_not_found' | 'rate_limited',
): void {
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
    const { db } = writeDb(c, dbFor);

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

    // AECI-773 / §15.1 — the hourly per-user cap. Placed AFTER the existence and
    // duplicate checks so a caller cannot spend their hourly budget probing for
    // products that do not exist, and BEFORE the toxicity call so a rejected
    // submission never reaches a paid Anthropic request.
    //
    // Two semantics that are silent if wrong. **Every status counts** — this
    // deliberately does NOT reuse the dedup index's `status <> 'archived'`
    // predicate, because if a rejected review stopped counting, a moderation
    // loop would become a slot-refund machine. And `reviews.reviewer_id` is
    // `ON DELETE SET NULL`, so a GDPR erasure naturally resets the counter;
    // that is acceptable and is written down rather than left to be found.
    //
    // Cost: one indexed seek. `reviews_reviewer_idx` covers `reviewer_id` and
    // the partial `WHERE reviewer_id IS NOT NULL` is usable because a bound
    // non-null value implies it. `created_at` is not in that index, so the plan
    // is seek then filter — but `reviews_unique_per_user_product` caps a user at
    // one review per product, so the fan-out is the number of products they have
    // ever reviewed. Single digits. Deliberately NO new composite index: it would
    // be asymptotically better and practically pointless, and drizzle-kit
    // generation over this table family has already produced one destructive
    // recreate (migration 0027, guarded by `src/test/migration-0027.spec.ts`).
    const since = new Date(Date.now() - REVIEW_LIMIT_WINDOW_MS).toISOString();
    const [recent] = await db
      .select({ value: count() })
      .from(reviews)
      .where(and(eq(reviews.reviewerId, userId), gte(reviews.createdAt, since)));
    if ((recent?.value ?? 0) >= REVIEW_HOURLY_LIMIT) {
      emitSubmit(c, 'rate_limited');
      throw new ApiError(
        429,
        ApiErrorCode.RATE_LIMITED,
        'You have submitted the maximum number of reviews for now. Try again in an hour.',
        { retryAfterSeconds: REVIEW_LIMIT_WINDOW_MS / 1000 },
      );
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
        // Trim free-text firm; a blank/whitespace-only value stores null so it
        // never inflates the distinct contributing-firms count (AECI-284).
        reviewerFirm: payload.reviewer_firm?.trim() || null,
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

    // Best-effort §26.5 forwards + the §11.1 "in moderation" confirmation email,
    // all fire-and-forget AFTER the atomic commit. The email fails open: an absent
    // RESEND_API_KEY or session email is a silent skip and never affects the 201.
    c.executionCtx.waitUntil(
      Promise.all([
        forwardWorkflowTransition(workflowEntry, makeWorkflowForwarder(c)),
        forwardAuditLog(auditEntry, makeForwarder(c)),
        sendReviewSubmittedEmail(c, { to: session.email }),
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
