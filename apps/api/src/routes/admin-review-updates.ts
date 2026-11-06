/**
 * Reviewer updates to published reviews, AECi side (AECI-1613, `STAGE_1_SPEC.md`
 * §4.7a, `ADMIN_PANEL_SPEC.md` §5.20, `API_CONTRACTS.md` §6.10) — Drizzle/D1.
 *
 *   GET   /api/admin/review-updates      — the queue, by status, oldest first.
 *   PATCH /api/admin/review-updates/:id  — approve, reject or remove one update.
 *
 * ── 1. THE GUARD IS STATUS ──────────────────────────────────────────────────
 * `REVIEW_UPDATE_DECISIONS` (`@aeci/shared`) gives each action exactly one
 * from-state: approve and reject from `pending`, remove from `approved`. Any other is
 * `409 REVIEW_UPDATE_WRONG_STATE` and writes nothing. An update is immutable after
 * submit, so unlike a vendor reply there is no version to compare: the status alone
 * says the admin decided the text they read.
 *
 * ── 2. ONE BATCH, BEHIND THE SENTINEL ───────────────────────────────────────
 * The guarded `UPDATE … WHERE id = ? AND status = <from>`, then
 * `reviewUpdateChangedSentinel`, then the `audit_log` row, then on approve one
 * `portal-review-update` feed row per owning vendor. A lost race rolls the whole
 * batch back and answers `WRONG_STATE`: no audit row, no feed row, no purge, no
 * recompute, no email.
 *
 * ── 3. VISIBILITY AND THE AVERAGES ──────────────────────────────────────────
 * Approve shows an update and remove takes one down. Both change the review's
 * effective rating when the update carries ratings, so both recompute the product's
 * averages (`recomputeProductCounts`, the one averages rule) and purge
 * `product:{slug}` with source `moderation` after commit. Reject changes neither.
 * `review_count` never moves: an update is not a review. No Algolia write is queued,
 * as review approval queues none.
 *
 * ── 4. EMAIL ────────────────────────────────────────────────────────────────
 * Approve and reject email the reviewer, through the ledger with the shared key
 * `review-update-decision:{updateId}`, so one update gets one decision email. Remove
 * sends none, as a review has no removal email. No vendor email.
 *
 * No `workflow_instances` or `workflow_transitions` row: the state lives in
 * `review_updates.status`, and the closed workflow type CHECK stays closed.
 */

import {
  AdminReviewUpdateSchema,
  ApiErrorCode,
  DecideReviewUpdateSchema,
  ListAdminReviewUpdatesQuerySchema,
  ListAdminReviewUpdatesResponseSchema,
  REVIEW_UPDATE_DECISIONS,
  type AdminReviewUpdate,
  type DecideReviewUpdateInput,
  type ListAdminReviewUpdatesResponse,
  type ReviewUpdateStatus,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, count, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import { products, reviewUpdates, reviews } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { sendReviewUpdateApprovedEmail, sendReviewUpdateRejectedEmail } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { recomputeProductCounts } from '../lib/recompute-counts';
import { loadReviewOwners, reviewUpdatePublishedNotifications } from '../lib/review-notifications';
import {
  REVIEW_UPDATE_DECISION_ACTIONS,
  REVIEW_UPDATE_ENTITY_TYPE,
  isReviewUpdateRaceError,
  reviewUpdateChangedSentinel,
} from '../lib/review-updates';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import { logToPosthog } from '../posthog';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The reviewer-email seam (seam #2). The default reaches the GoTrue Admin API;
 *  specs inject a fake. */
export type FetchReviewerEmails = (
  env: Env,
  profileIds: readonly string[],
) => Promise<Map<string, string>>;

/** Injected recompute seam (post-commit, approve and remove). */
type RecomputeFn = (db: Db, productIds: Iterable<string>) => Promise<void>;

/** `audit_log.metadata.source` on every admin decision, as review moderation. */
const AUDIT_SOURCE = 'admin-moderation';

/** `review-update-decision:{updateId}`: one decision email per update, ever. */
export const reviewUpdateDecisionKey = (updateId: string) => `review-update-decision:${updateId}`;

async function parseJsonBody<T>(c: AdminContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

// ─── The read ────────────────────────────────────────────────────────────────

/** Everything a card needs, in one SELECT: the update, its review in full, the
 *  product, and the reviewer id for the address lookup. */
function selectAdminRows(db: Db) {
  return db
    .select({
      id: reviewUpdates.id,
      status: reviewUpdates.status,
      body: reviewUpdates.body,
      ratingOverall: reviewUpdates.ratingOverall,
      ratingOnboarding: reviewUpdates.ratingOnboarding,
      rejectionReason: reviewUpdates.rejectionReason,
      toxicityScore: reviewUpdates.toxicityScore,
      moderatedAt: reviewUpdates.moderatedAt,
      publishedAt: reviewUpdates.publishedAt,
      createdAt: reviewUpdates.createdAt,
      updatedAt: reviewUpdates.updatedAt,
      productId: products.id,
      productSlug: products.slug,
      productName: products.name,
      productLogoUrl: products.logoUrl,
      reviewId: reviews.id,
      reviewerId: reviews.reviewerId,
      reviewStatus: reviews.status,
      reviewTitle: reviews.title,
      reviewBody: reviews.body,
      reviewRatingOverall: reviews.ratingOverall,
      reviewRatingOnboarding: reviews.ratingOnboarding,
      reviewCreatedAt: reviews.createdAt,
    })
    .from(reviewUpdates)
    .innerJoin(reviews, eq(reviews.id, reviewUpdates.reviewId))
    .innerJoin(products, eq(products.id, reviews.productId));
}

type AdminRow = Awaited<ReturnType<ReturnType<typeof selectAdminRows>['where']>>[number];

function toAdminReviewUpdate(
  row: AdminRow,
  emails: ReadonlyMap<string, string>,
): AdminReviewUpdate {
  return {
    id: row.id,
    status: row.status as ReviewUpdateStatus,
    body: row.body,
    rating_overall: row.ratingOverall,
    rating_onboarding: row.ratingOnboarding,
    rejection_reason: row.rejectionReason,
    toxicity_score: row.toxicityScore,
    reviewer_email: row.reviewerId ? (emails.get(row.reviewerId) ?? null) : null,
    product: {
      id: row.productId,
      slug: row.productSlug,
      name: row.productName,
      logo_url: row.productLogoUrl,
    },
    review: {
      id: row.reviewId,
      status: row.reviewStatus as AdminReviewUpdate['review']['status'],
      title: row.reviewTitle,
      body: row.reviewBody,
      rating_overall: row.reviewRatingOverall,
      rating_onboarding: row.reviewRatingOnboarding,
      created_at: row.reviewCreatedAt,
    },
    moderated_at: row.moderatedAt,
    published_at: row.publishedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** Reviewer emails for a page. Degrades to an empty map rather than failing the
 *  queue: the card then shows no address. */
async function reviewerEmails(
  c: AdminContext,
  fetchEmails: FetchReviewerEmails,
  rows: readonly AdminRow[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.reviewerId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  try {
    return await fetchEmails(c.env, ids);
  } catch (error) {
    console.warn('admin-review-updates: reviewer email lookup failed', error);
    return new Map();
  }
}

async function loadAdminRow(db: Db, id: string): Promise<AdminRow | undefined> {
  const [row] = await selectAdminRows(db).where(eq(reviewUpdates.id, id)).limit(1);
  return row;
}

// ─── GET /api/admin/review-updates ───────────────────────────────────────────

export function createAdminReviewUpdatesListHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchReviewerEmails = fetchAuthUserEmails,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListAdminReviewUpdatesQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where = eq(reviewUpdates.status, query.status);

    // Oldest first, so the longest wait is on top. Served by
    // `review_updates_status_created_idx (status, created_at)`. `id` breaks a tie.
    const [rows, totalRows] = await Promise.all([
      selectAdminRows(db)
        .where(where)
        .orderBy(asc(reviewUpdates.createdAt), asc(reviewUpdates.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(reviewUpdates).where(where),
    ]);
    const emails = await reviewerEmails(c, fetchEmails, rows);

    const body: ListAdminReviewUpdatesResponse = {
      data: rows.map((row) => toAdminReviewUpdate(row, emails)),
      page: query.page,
      perPage: query.perPage,
      total: totalRows[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => ListAdminReviewUpdatesResponseSchema.parse(body));
    return json(body);
  };
}

// ─── PATCH /api/admin/review-updates/:id ─────────────────────────────────────

/** The columns one decision writes. */
function decisionColumns(
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

function wrongStateError(status: string): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.REVIEW_UPDATE_WRONG_STATE,
    `This update is ${status}, so that action is not allowed.`,
    { details: { status } },
  );
}

/** Enqueue the `product:{slug}` purge. Best-effort: no-ops without the queue
 *  binding, and a send failure warns and never affects the committed decision. */
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

export function createDecideReviewUpdateHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchReviewerEmails = fetchAuthUserEmails,
  recompute: RecomputeFn = recomputeProductCounts,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing update id', {
        field: 'id',
      });
    }
    const payload = await parseJsonBody(c, DecideReviewUpdateSchema);
    const { db } = writeDb(c, dbFor);

    const row = await loadAdminRow(db, id);
    if (!row) throw notFoundError('review_update', { id });
    const plan = REVIEW_UPDATE_DECISIONS[payload.action];
    if (row.status !== plan.from) throw wrongStateError(row.status);

    const now = new Date().toISOString();
    const reason = payload.action === 'approve' ? null : payload.reason;
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const product = { id: row.productId, slug: row.productSlug, name: row.productName };
    const audit: AuditLogEntry = {
      ...actor,
      action: REVIEW_UPDATE_DECISION_ACTIONS[payload.action],
      entityType: REVIEW_UPDATE_ENTITY_TYPE,
      entityId: id,
      productId: row.productId,
      beforeState: { status: plan.from },
      afterState: { status: plan.to, ...(reason ? { rejection_reason: reason } : {}) },
      metadata: {
        source: AUDIT_SOURCE,
        reviewId: row.reviewId,
        productId: row.productId,
        ...(reason ? { reason } : {}),
      },
    };

    // Approve only: one feed row per owning vendor, primary or not, on every plan.
    // Owners are read before the batch because a batch statement cannot fan out.
    const owners = payload.action === 'approve' ? await loadReviewOwners(db, row.productId) : [];
    const notifications = reviewUpdatePublishedNotifications(
      'portal-review-update',
      actor,
      owners,
      {
        id,
        reviewId: row.reviewId,
        reviewTitle: row.reviewTitle,
        rerated: row.ratingOverall !== null,
        product,
      },
    );

    const stmts: BatchStmt[] = [
      db
        .update(reviewUpdates)
        .set(decisionColumns(payload, session.userId, now))
        .where(and(eq(reviewUpdates.id, id), eq(reviewUpdates.status, plan.from))),
      // Immediately after the guarded UPDATE: a lost race aborts here, before the
      // audit row and the feed rows.
      reviewUpdateChangedSentinel(db),
      auditInsert(db, audit),
      ...notifications.map((entry) => auditInsert(db, entry)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isReviewUpdateRaceError(error)) throw error;
      const [current] = await db
        .select({ status: reviewUpdates.status })
        .from(reviewUpdates)
        .where(eq(reviewUpdates.id, id))
        .limit(1);
      throw wrongStateError(current?.status ?? 'missing');
    }

    // Post-commit (rule 3). The recompute lands before the purge is enqueued, so a
    // re-render after the purge reads the new averages.
    if (plan.purges) {
      await recompute(db, [row.productId]);
      c.executionCtx.waitUntil(purgeProductTag(c, row.productSlug));
    }
    forwardAuditBatch(c, [audit, ...notifications], []);

    const after = await loadAdminRow(db, id);
    if (!after) throw notFoundError('review_update', { id });
    const emails = await reviewerEmails(c, fetchEmails, [after]);

    // Rule 4: the reviewer's decision email, fire-and-forget and fail-open.
    const reviewerEmail = after.reviewerId ? emails.get(after.reviewerId) : undefined;
    const dedupe = {
      dedupeKey: reviewUpdateDecisionKey(id),
      entity: { type: 'review_update', id },
    };
    if (payload.action === 'approve') {
      c.executionCtx.waitUntil(
        sendReviewUpdateApprovedEmail(c, {
          to: reviewerEmail,
          productName: row.productName,
          productSlug: row.productSlug,
          ...dedupe,
        }),
      );
    } else if (payload.action === 'reject') {
      c.executionCtx.waitUntil(
        sendReviewUpdateRejectedEmail(c, {
          to: reviewerEmail,
          productName: row.productName,
          reason: payload.reason,
          ...dedupe,
        }),
      );
    }

    const body = toAdminReviewUpdate(after, emails);
    validateResponseInDev(c.env, () => AdminReviewUpdateSchema.parse(body));
    return json(body);
  };
}
