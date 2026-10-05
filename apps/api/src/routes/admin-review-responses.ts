/**
 * Vendor replies to reviews, AECi side (AECI-1177 / `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11c; `ADMIN_PANEL_SPEC.md` §5.13; `API_CONTRACTS.md` §6.10) — Drizzle/D1.
 *
 *   GET   /api/admin/review-responses      — the queue, by status, oldest first.
 *   PATCH /api/admin/review-responses/:id  — approve, reject or remove one reply.
 *
 * This is the tenth named write exception in `ADMIN_PANEL_SPEC.md` §2: a
 * MODERATION write on vendor-authored content. Four rules of this module's own:
 *
 * ── 1. THE GUARD IS STATUS PLUS VERSION ─────────────────────────────────────
 * `REVIEW_RESPONSE_DECISIONS` (`@aeci/shared`) gives each decision exactly one
 * from-state: approve and reject from `pending`, remove from `published`. Any
 * other from-state is `409 REVIEW_RESPONSE_WRONG_STATE` and writes nothing. The
 * web queue reads the same table to decide which buttons a card carries.
 *
 * Status alone is not enough. A vendor edit of a pending reply stays `pending`
 * with a new body, and a withdraw-and-resubmit ends `pending` again. So every
 * decision names the version it read in `expected_updated_at`, and a stored
 * `updated_at` that differs is `409 REVIEW_RESPONSE_CHANGED`. The admin never
 * approves text they did not see.
 *
 * ── 2. ONE BATCH, BEHIND THE SENTINEL ───────────────────────────────────────
 * The guarded `UPDATE … WHERE id = ? AND status = <from> AND updated_at = <expected>`,
 * then `reviewResponseChangedSentinel` straight after it, then the `audit_log` row,
 * then whatever {@link reviewResponseDecisionNotifications} returns (§11c.7). A lost
 * race (another admin decided it, or the vendor edited or withdrew it between the
 * read and the batch) rolls the whole batch back. A re-read then answers
 * `WRONG_STATE` when the status moved and `CHANGED` when only the version did. So
 * a loser commits no audit row, no notification and no purge.
 *
 * ── 3. ONLY VISIBILITY PURGES ───────────────────────────────────────────────
 * Approve makes a reply appear and remove takes one down, so both purge
 * `product:{slug}` after commit with source `moderation`. Reject purges nothing: a
 * pending reply was never on the page. No re-crawl, no IndexNow, no Algolia write.
 * Review moderation does not do those either (`routes/admin-reviews.ts`).
 *
 * ── 4. THE FIREWALL ─────────────────────────────────────────────────────────
 * No statement here writes `reviews`, a count, an average or a ranking input, and
 * nothing calls `recomputeProductCounts` (§11c.10). No `workflow_instances` or
 * `workflow_transitions` row: the state lives in `review_responses.status`.
 */

import {
  AdminReviewResponseSchema,
  ApiErrorCode,
  DecideReviewResponseSchema,
  ListAdminReviewResponsesQuerySchema,
  ListAdminReviewResponsesResponseSchema,
  REVIEW_RESPONSE_DECISIONS,
  type AdminReviewResponse,
  type DecideReviewResponseInput,
  type ListAdminReviewResponsesResponse,
  type ReviewResponseStatus,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, count, eq, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { products, reviewResponses, reviews, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';
import {
  REVIEW_RESPONSE_DECISION_ACTIONS,
  REVIEW_RESPONSE_ENTITY_TYPE,
  isReviewResponseRaceError,
  reviewResponseChangedSentinel,
} from '../lib/review-responses';
import { reviewResponseDecisionNotification } from '../lib/review-notifications';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import { parseJsonBody, purgeTags } from './vendor-shared';
import { vendorAuditStamp } from '../lib/audit-vendor';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The author-email seam (seam #2). The default reaches the GoTrue Admin API;
 *  specs inject a fake. */
export type FetchAuthorEmails = (
  env: Env,
  profileIds: readonly string[],
) => Promise<Map<string, string>>;

/** `audit_log.metadata.source` on every admin decision, as review moderation. */
const AUDIT_SOURCE = 'admin-moderation';

// ─── The read ────────────────────────────────────────────────────────────────

/** Everything a card needs, in one SELECT. `vendorOwnsProduct` is §11c.11 rule 3,
 *  read in SQL so a co-owner dropped from `product_vendors` shows the warning. */
function selectAdminRows(db: Db) {
  return db
    .select({
      id: reviewResponses.id,
      status: reviewResponses.status,
      body: reviewResponses.body,
      rejectionReason: reviewResponses.rejectionReason,
      authorProfileId: reviewResponses.authorProfileId,
      moderatedAt: reviewResponses.moderatedAt,
      publishedAt: reviewResponses.publishedAt,
      createdAt: reviewResponses.createdAt,
      updatedAt: reviewResponses.updatedAt,
      vendorId: vendors.id,
      vendorSlug: vendors.slug,
      vendorName: vendors.companyName,
      productId: products.id,
      productSlug: products.slug,
      productName: products.name,
      productLogoUrl: products.logoUrl,
      reviewId: reviews.id,
      reviewStatus: reviews.status,
      reviewTitle: reviews.title,
      reviewBody: reviews.body,
      reviewRatingOverall: reviews.ratingOverall,
      reviewRatingOnboarding: reviews.ratingOnboarding,
      reviewCreatedAt: reviews.createdAt,
      vendorOwnsProduct: sql<number>`EXISTS (SELECT 1 FROM product_vendors pv WHERE pv.product_id = ${reviews.productId} AND pv.vendor_id = ${reviewResponses.vendorId})`,
    })
    .from(reviewResponses)
    .innerJoin(reviews, eq(reviews.id, reviewResponses.reviewId))
    .innerJoin(products, eq(products.id, reviews.productId))
    .innerJoin(vendors, eq(vendors.id, reviewResponses.vendorId));
}

type AdminRow = Awaited<ReturnType<ReturnType<typeof selectAdminRows>['where']>>[number];

function toAdminReviewResponse(
  row: AdminRow,
  emails: ReadonlyMap<string, string>,
): AdminReviewResponse {
  return {
    id: row.id,
    status: row.status as ReviewResponseStatus,
    body: row.body,
    rejection_reason: row.rejectionReason,
    vendor: { id: row.vendorId, slug: row.vendorSlug, name: row.vendorName },
    vendor_owns_product: Boolean(row.vendorOwnsProduct),
    author_email: row.authorProfileId ? (emails.get(row.authorProfileId) ?? null) : null,
    product: {
      id: row.productId,
      slug: row.productSlug,
      name: row.productName,
      logo_url: row.productLogoUrl,
    },
    review: {
      id: row.reviewId,
      status: row.reviewStatus as AdminReviewResponse['review']['status'],
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

/** Author emails for a page. Degrades to an empty map rather than failing the
 *  queue: the card then shows no address (`API_CONTRACTS.md` §6.10). */
async function authorEmails(
  c: AdminContext,
  fetchEmails: FetchAuthorEmails,
  rows: readonly AdminRow[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.map((r) => r.authorProfileId).filter((id): id is string => id !== null)),
  ];
  if (ids.length === 0) return new Map();
  try {
    return await fetchEmails(c.env, ids);
  } catch (error) {
    console.warn('admin-review-responses: author email lookup failed', error);
    return new Map();
  }
}

async function loadAdminRow(db: Db, id: string): Promise<AdminRow | undefined> {
  const [row] = await selectAdminRows(db).where(eq(reviewResponses.id, id)).limit(1);
  return row;
}

// ─── GET /api/admin/review-responses ─────────────────────────────────────────

export function createAdminReviewResponsesListHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchAuthorEmails = fetchAuthUserEmails,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListAdminReviewResponsesQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where: SQL = eq(reviewResponses.status, query.status);

    // Oldest first, so the longest wait is on top. Served by
    // `review_responses_status_updated_idx (status, updated_at)`. `id` breaks a
    // tie so pages are stable (AECI-825).
    const [rows, totalRows] = await Promise.all([
      selectAdminRows(db)
        .where(where)
        .orderBy(asc(reviewResponses.updatedAt), asc(reviewResponses.id))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(reviewResponses).where(where),
    ]);
    const emails = await authorEmails(c, fetchEmails, rows);

    const body: ListAdminReviewResponsesResponse = {
      data: rows.map((row) => toAdminReviewResponse(row, emails)),
      page: query.page,
      perPage: query.perPage,
      total: totalRows[0]?.value ?? 0,
    };
    validateResponseInDev(c.env, () => ListAdminReviewResponsesResponseSchema.parse(body));
    return json(body);
  };
}

// ─── PATCH /api/admin/review-responses/:id ───────────────────────────────────

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
  actor: { actorId: string; actorType: AuditLogEntry['actorType'] };
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

/** The columns one decision writes (§11c.6 "Columns per transition"). */
function decisionColumns(
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

function wrongStateError(status: string): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.REVIEW_RESPONSE_WRONG_STATE,
    `This reply is ${status}, so that decision is not allowed.`,
    { details: { status } },
  );
}

/** The vendor replaced the version the admin read (rule 1). `details.updated_at`
 *  is the stored version, so a client can tell its copy is stale. */
function changedError(status: string, updatedAt: string): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.REVIEW_RESPONSE_CHANGED,
    'The vendor changed this reply after you loaded it. Read the new version before deciding.',
    { details: { status, updated_at: updatedAt } },
  );
}

export function createDecideReviewResponseHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchAuthorEmails = fetchAuthUserEmails,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing reply id', { field: 'id' });
    }
    const payload = await parseJsonBody(c, DecideReviewResponseSchema);
    const { db } = writeDb(c, dbFor);

    const row = await loadAdminRow(db, id);
    if (!row) throw notFoundError('review_response', { id });
    const plan = REVIEW_RESPONSE_DECISIONS[payload.decision];
    if (row.status !== plan.from) throw wrongStateError(row.status);
    const expected = payload.expected_updated_at;
    if (row.updatedAt !== expected) throw changedError(row.status, row.updatedAt);

    const now = new Date().toISOString();
    const reason = payload.decision === 'approve' ? null : payload.reason;
    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const audit: AuditLogEntry = {
      ...actor,
      action: REVIEW_RESPONSE_DECISION_ACTIONS[payload.decision],
      entityType: REVIEW_RESPONSE_ENTITY_TYPE,
      entityId: id,
      // AECI-1192 / AECI-1193: the reply is the vendor's, about one product.
      ...(await vendorAuditStamp(db, row.vendorId)),
      productId: row.productId,
      beforeState: { status: plan.from },
      afterState: { status: plan.to, ...(reason ? { rejection_reason: reason } : {}) },
      metadata: {
        source: AUDIT_SOURCE,
        vendorId: row.vendorId,
        reviewId: row.reviewId,
        productId: row.productId,
        ...(reason ? { reason } : {}),
      },
    };
    const notifications = reviewResponseDecisionNotifications({
      responseId: id,
      decision: payload.decision,
      vendorId: row.vendorId,
      reviewId: row.reviewId,
      product: { id: row.productId, slug: row.productSlug, name: row.productName },
      reason,
      actor,
    });

    const stmts: BatchStmt[] = [
      db
        .update(reviewResponses)
        .set(decisionColumns(payload, session.userId, now))
        .where(
          and(
            eq(reviewResponses.id, id),
            eq(reviewResponses.status, plan.from),
            eq(reviewResponses.updatedAt, expected),
          ),
        ),
      // Immediately after the guarded UPDATE: a lost race aborts here, before the
      // audit row and the notification.
      reviewResponseChangedSentinel(db),
      auditInsert(db, audit),
      ...notifications.map((entry) => auditInsert(db, entry)),
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isReviewResponseRaceError(error)) throw error;
      const current = await db.query.reviewResponses.findFirst({
        columns: { status: true, updatedAt: true },
        where: eq(reviewResponses.id, id),
      });
      if (current?.status === plan.from && current.updatedAt !== expected) {
        throw changedError(current.status, current.updatedAt);
      }
      throw wrongStateError(current?.status ?? 'missing');
    }

    // Post-commit. A purge only when a visitor's view changes (rule 3).
    if (plan.purges) {
      c.executionCtx.waitUntil(purgeTags(c, [`product:${row.productSlug}`], 'moderation'));
    }
    forwardAuditBatch(c, [audit, ...notifications], []);

    const after = await loadAdminRow(db, id);
    if (!after) throw notFoundError('review_response', { id });
    const emails = await authorEmails(c, fetchEmails, [after]);
    const body = toAdminReviewResponse(after, emails);
    validateResponseInDev(c.env, () => AdminReviewResponseSchema.parse(body));
    return json(body);
  };
}
