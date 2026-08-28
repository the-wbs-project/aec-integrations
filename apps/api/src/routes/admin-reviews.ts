/**
 * Admin moderation API (AECI-204 / Phase 5.13) — Drizzle/D1 (ADR 0016 / AECI-253,
 * AECI-254).
 *
 *   GET   /api/admin/reviews     — the moderation queue (status filter, paginated).
 *   PATCH /api/admin/reviews/:id — approve / reject a *pending* review.
 *
 * Moderation is one atomic `db.batch`: the guarded `UPDATE … WHERE status='pending'`
 * + the `review.approved|rejected` audit + the lean workflow history (find-or-create
 * the `review_moderation` instance, append the `pending → approved|rejected`
 * transition, mark the instance complete). The denormalized count recompute on
 * approve runs as a separate post-batch step (`lib/recompute-counts.ts`).
 *
 * `reviewer_email` (admin-only, lives in `auth.users`) is read via the GoTrue
 * Admin API (seam #2, `lib/supabase-admin.ts`), injected for tests and degrading
 * to `reviewer_email: null` — the queue must stay usable, never 500.
 */

import {
  ApiErrorCode,
  ListPendingReviewsQuerySchema,
  ListPendingReviewsResponseSchema,
  ModerateReviewResponseSchema,
  ModerateReviewSchema,
  REPEAT_OFFENDER_THRESHOLD,
  type ListPendingReviewsResponse,
  type ModerateReviewResponse,
  type RepeatOffenderPrompt,
} from '@aeci/shared';
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
import { and, asc, count, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb } from '../db/client';
import type { Db } from '../db/client';
import { reviews, workflowInstances } from '../db/schema';
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
import { adminReviewConfig, toAdminReview, type RawAdminReviewRow } from '../lib/drizzle-helpers';
import { sendReviewApprovedEmail, sendReviewRejectedEmail } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { recomputeProductCounts } from '../lib/recompute-counts';
import { fetchAuthUserEmails } from '../lib/supabase-admin';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** Injected reviewer-email seam (seam #2). Default hits the GoTrue Admin API. */
export type FetchReviewerEmails = (
  env: Env,
  reviewerIds: readonly string[],
) => Promise<Map<string, string>>;

/** Injected recompute seam (post-batch, approve-only). */
type RecomputeFn = (db: Db, productIds: Iterable<string>) => Promise<void>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeForwarder(c: AdminContext): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY && !c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'admin-moderation',
    });
  };
}

function makeWorkflowForwarder(c: AdminContext): WorkflowTransitionForwarder | undefined {
  if (!c.env.DD_API_KEY && !c.env.POSTHOG_PROJECT_KEY) return undefined;
  return (entry) => {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`.trim(),
      from_state: entry.fromState ?? undefined,
      to_state: entry.toState,
      workflow_id: entry.workflowId,
      source: 'admin-moderation',
    });
  };
}

async function parseJsonBody<T>(c: AdminContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

function emitModeration(
  c: AdminContext,
  action: 'approve' | 'reject',
  outcome: 'ok' | 'invalid_state',
): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.moderation.action', 1, [
    `action:${action}`,
    `outcome:${outcome}`,
  ]);
}

/**
 * Enqueue a purge of the moderated product's `Cache-Tag` (WC-5 / ADR 0020 §3). The
 * SSR Worker's queue consumer issues the actual `ctx.cache.purge()` and emits
 * `aeci.cache.purge{source:moderation}` — the API Worker's own zone-HTTP purge is
 * inert against native Workers Cache. Best-effort: no-ops without the queue binding
 * (local/preview), and a `queue.send` rejection is logged (a `warn`) and
 * swallowed so it never affects the committed moderation.
 */
async function purgeProductTag(c: AdminContext, slug: string): Promise<void> {
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue) return;
  try {
    await queue.send({ tags: [`product:${slug}`], source: 'moderation' });
  } catch (error) {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `Cache purge enqueue failed for product:${slug}`,
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
}

// ─── GET /api/admin/reviews ────────────────────────────────────────────────────

export function createAdminReviewsListHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchReviewerEmails = fetchAuthUserEmails,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListPendingReviewsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const where = eq(reviews.status, query.status);
    const direction = query.sort === 'created_at' ? desc : asc;

    const [rows, countRows] = await Promise.all([
      db.query.reviews.findMany({
        ...adminReviewConfig,
        where,
        orderBy: [direction(reviews.createdAt), asc(reviews.id)],
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(reviews).where(where),
    ]);

    const reviewerIds = rows.map((row) => row.reviewerId).filter((id): id is string => id !== null);
    const emailByReviewerId = await fetchEmails(c.env, reviewerIds);

    const body: ListPendingReviewsResponse = {
      data: rows.map((row) => toAdminReview(row, emailByReviewerId)),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      ListPendingReviewsResponseSchema.parse(body);
    });

    return json(body);
  };
}

// ─── PATCH /api/admin/reviews/:id ──────────────────────────────────────────────

export function createModerateReviewHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchReviewerEmails = fetchAuthUserEmails,
  recompute: RecomputeFn = recomputeProductCounts,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing review id', { field: 'id' });
    }

    const payload = await parseJsonBody(c, ModerateReviewSchema);
    const { db } = writeDb(c, dbFor);

    // Preload the full admin row — it gates the transition (status) and builds the
    // response (the values we set are merged in after commit; no post-commit read).
    const existing = (await db.query.reviews.findFirst({
      ...adminReviewConfig,
      where: eq(reviews.id, id),
    })) as RawAdminReviewRow | undefined;
    if (!existing) throw notFoundError('review', { id });
    if (existing.status !== 'pending') {
      emitModeration(c, payload.action, 'invalid_state');
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        `Review is ${existing.status}; only pending reviews can be moderated.`,
      );
    }

    const approve = payload.action === 'approve';
    const newStatus = approve ? 'approved' : 'rejected';
    const rejectionReason = approve ? null : (payload.rejection_reason as string);
    const moderatedAt = new Date().toISOString();

    // Read the workflow instance up front (find-or-create can't be conditional
    // inside a batch). Reviews pre-dating the AECI-210 retrofit have none.
    const existingWf = await db.query.workflowInstances.findFirst({
      columns: { id: true },
      where: and(
        eq(workflowInstances.workflowType, 'review_moderation'),
        eq(workflowInstances.entityId, id),
      ),
    });
    const workflowId = existingWf?.id ?? crypto.randomUUID();

    const auditEntry: AuditLogEntry = {
      actorId: userId,
      actorType: auditActorType(session),
      action: approve ? 'review.approved' : 'review.rejected',
      entityType: 'review',
      entityId: id,
      metadata: {
        source: 'admin-moderation',
        product_id: existing.product.id,
        ...(approve ? {} : { rejection_reason: rejectionReason }),
      },
    };
    const workflowEntry: WorkflowTransitionEntry = {
      workflowId,
      fromState: 'pending',
      toState: newStatus,
      actorId: userId,
      reason: rejectionReason,
      metadata: {
        source: 'admin-moderation',
        product_id: existing.product.id,
        ...(approve ? {} : { rejection_reason: rejectionReason }),
      },
    };

    // The guarded update (`WHERE status='pending'`) makes the state change safe
    // under a concurrent moderation; the preload gate covers the common case (a
    // rare two-admin race could leave a no-op update with its audit — acceptable
    // under the §26.3 lean relaxation). Audit + workflow are atomic with it.
    const stmts: BatchStmt[] = [
      db
        .update(reviews)
        .set({
          status: newStatus,
          moderatedBy: userId,
          moderatedAt,
          ...(approve ? {} : { rejectionReason }),
        })
        .where(and(eq(reviews.id, id), eq(reviews.status, 'pending'))),
      auditInsert(db, auditEntry),
      existingWf
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
    ];
    await db.batch(stmts as BatchTuple);

    // Approve-only: recompute the product's denormalized counts (a rejected review
    // was never counted). Separate post-batch step under D1.
    if (approve) {
      await recompute(db, [existing.product.id]);
    }

    emitModeration(c, payload.action, 'ok');

    if (approve && c.env.CACHE_PURGE_QUEUE) {
      c.executionCtx.waitUntil(purgeProductTag(c, existing.product.slug));
    }
    c.executionCtx.waitUntil(
      Promise.all([
        forwardAuditLog(auditEntry, makeForwarder(c)),
        forwardWorkflowTransition(workflowEntry, makeWorkflowForwarder(c)),
      ]),
    );

    const moderatedRow: RawAdminReviewRow = {
      ...existing,
      status: newStatus,
      moderatedAt,
      rejectionReason: approve ? existing.rejectionReason : rejectionReason,
    };
    const emailByReviewerId = await fetchEmails(
      c.env,
      existing.reviewerId ? [existing.reviewerId] : [],
    );

    // §11.1 reviewer notification, fire-and-forget. Reuses the email already
    // fetched for the response; fails open (absent key/email → silent skip).
    const reviewerEmail = existing.reviewerId
      ? emailByReviewerId.get(existing.reviewerId)
      : undefined;
    c.executionCtx.waitUntil(
      approve
        ? sendReviewApprovedEmail(c, {
            to: reviewerEmail,
            productName: existing.product.name,
            productSlug: existing.product.slug,
          })
        : sendReviewRejectedEmail(c, {
            to: reviewerEmail,
            productName: existing.product.name,
            reason: rejectionReason ?? '',
          }),
    );

    const repeatOffender = await computeRepeatOffenderPrompt(
      db,
      approve ? null : existing.reviewerId,
      emailByReviewerId,
    );

    const body: ModerateReviewResponse = {
      review: toAdminReview(moderatedRow, emailByReviewerId),
      repeat_offender: repeatOffender,
    };

    validateResponseInDev(c.env, () => {
      ModerateReviewResponseSchema.parse(body);
    });

    return json(body);
  };
}

/** AECI-218 repeat-offender prompt: reject-only, identified reviewers, ≥ threshold
 *  total rejected. Best-effort — a count failure degrades to no prompt (the
 *  moderation already committed). */
async function computeRepeatOffenderPrompt(
  db: Db,
  reviewerId: string | null,
  emailByReviewerId: ReadonlyMap<string, string>,
): Promise<RepeatOffenderPrompt | null> {
  if (!reviewerId) return null;
  let rejectedCount: number;
  try {
    const [row] = await db
      .select({ value: count() })
      .from(reviews)
      .where(and(eq(reviews.reviewerId, reviewerId), eq(reviews.status, 'rejected')));
    rejectedCount = row?.value ?? 0;
  } catch (error) {
    console.warn('admin-reviews: repeat-offender count failed', error);
    return null;
  }
  if (rejectedCount < REPEAT_OFFENDER_THRESHOLD) return null;
  return {
    reviewer_id: reviewerId,
    reviewer_email: emailByReviewerId.get(reviewerId) ?? null,
    rejected_count: rejectedCount,
  };
}
