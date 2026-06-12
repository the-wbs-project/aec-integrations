/**
 * Admin moderation API (AECI-204 / Phase 5.13) — the functional review
 * read + write surface behind `requireAdmin()`:
 *
 *   GET   /api/admin/reviews     — the moderation queue, filtered by status,
 *                                   sorted by queue age or recency, paginated.
 *   PATCH /api/admin/reviews/:id — approve / reject a *pending* review.
 *
 * Source of truth: `docs/API_CONTRACTS.md` §6.10, `STAGE_1_PHASE_5_SPEC.md` §7.2
 * / §22.1. The FSM (`workflow_instances`/`workflow_transitions`), Slack alerts,
 * Linear sync, and the queue UI are all out of scope (Phase 6 / 5.14). Phase 5
 * drives moderation directly off `review.status` + the audit log.
 *
 * On **approve**: `status='approved'`, `moderated_by/at`, recompute the
 * product's denormalized `review_count` + rating averages (only approved reviews
 * count — `recomputeProductCounts`), and purge the `product:<slug>` Cache-Tag so
 * the public list/summary refresh. On **reject**: `status='rejected'` + a
 * REQUIRED `rejection_reason`; no recompute / no purge (a pending review was
 * never publicly counted). `appendAuditLog()` runs in the same transaction as
 * every transition (failure rolls the transition back).
 *
 * `reviewer_email` is admin-only and lives only in `auth.users.email` (no column
 * on `profiles`/`reviews`). The Worker's Accelerate connection runs as a
 * privileged Postgres role that bypasses GRANTs/RLS (`AUTH_AND_RLS.md` §1), so
 * we read it with a parameterized cross-schema `$queryRaw`. The lookup is
 * injected (`fetchEmails`) for testability and wrapped so an `auth`-schema read
 * failure degrades to `reviewer_email: null` + a warn — the queue must stay
 * usable, never 500 — and anonymized reviews (`reviewer_id IS NULL`) are
 * likewise null.
 */

import {
  ApiErrorCode,
  AdminReviewSchema,
  ListPendingReviewsQuerySchema,
  ListPendingReviewsResponseSchema,
  ModerateReviewSchema,
  callCloudflarePurge,
  type ListPendingReviewsResponse,
  type ModerateReviewResponse,
} from '@aeci/shared';
import {
  appendAuditLog,
  type AuditLogClient,
  type AuditLogForwarder,
} from '@aeci/shared/audit-log';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import { recomputeProductCounts, type RecomputeClient } from '../lib/product-counts';
import { adminReviewSelect, toAdminReview, type RawAdminReviewRow } from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';
import type { AcceleratedPrisma } from '../prisma';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

// ─── Loose structural Prisma surfaces ────────────────────────────────────────
// Same approach as `routes/reviews.ts` / `routes/promote.ts`: we touch a known
// slice of the generated client, so we type it structurally and `as unknown as`
// it rather than dragging in the full edge-client generics (whose
// `$transaction` / `aggregate` types fight `recomputeProductCounts`). A real
// accelerated client and the test fakes both satisfy these.

/** Read surface for `GET /api/admin/reviews`. `findMany` narrows to the admin
 *  row shape via `adminReviewSelect`. */
type AdminReviewsClient = {
  review: {
    findMany(args: {
      where: Record<string, unknown>;
      orderBy: unknown;
      skip: number;
      take: number;
      select: typeof adminReviewSelect;
    }): Promise<RawAdminReviewRow[]>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
  };
};

/** Transaction surface for the moderate write: the guarded `updateMany`, plus
 *  the recompute (`RecomputeClient`) and audit (`AuditLogClient`) surfaces. */
type ModerateTx = {
  review: {
    updateMany(args: {
      where: { id: string; status: string };
      data: Record<string, unknown>;
    }): Promise<{ count: number }>;
  };
} & RecomputeClient &
  AuditLogClient;

/** Read + transaction surface for `PATCH /api/admin/reviews/:id`. The single
 *  `findUnique` selects the full `adminReviewSelect`, so the preloaded row both
 *  gates the transition (status) and builds the response (no post-commit read).*/
type ModerateClient = {
  review: {
    findUnique(args: {
      where: { id: string };
      select: typeof adminReviewSelect;
    }): Promise<RawAdminReviewRow | null>;
  };
  $transaction<T>(fn: (tx: ModerateTx) => Promise<T>): Promise<T>;
};

/** Injected `recomputeProductCounts` seam (mirrors `score` in `routes/reviews.ts`)
 *  so the approve path can assert the recompute fired without reconstructing the
 *  aggregate math. */
type RecomputeFn = (db: RecomputeClient, productIds: Iterable<string>) => Promise<void>;

/** Injected reviewer-email lookup seam. The default hits `auth.users`; tests
 *  pass a canned map. */
export type FetchReviewerEmails = (
  prisma: AcceleratedPrisma,
  reviewerIds: string[],
) => Promise<Map<string, string>>;

// ─── Reviewer email lookup (auth.users) ──────────────────────────────────────

/**
 * Resolve `auth.users.email` for a page's reviewers, keyed by `reviewer_id`.
 * Parameterized `$queryRaw` (never interpolation — `AUTH_AND_RLS.md` §6 forbids
 * user-supplied SQL): the ids are joined into a single scalar text param and
 * split + cast to `uuid[]` in Postgres, which avoids any array-parameter
 * serialization ambiguity through Accelerate. UUIDs cannot contain commas, so
 * the join is unambiguous. One query per page (≤100 ids).
 */
export const fetchReviewerEmails: FetchReviewerEmails = async (prisma, reviewerIds) => {
  const ids = [...new Set(reviewerIds)].filter((id) => id.length > 0);
  if (ids.length === 0) return new Map();

  const rows = await prisma.$queryRaw<Array<{ id: string; email: string | null }>>`
    SELECT id::text AS id, email
    FROM auth.users
    WHERE id = ANY(string_to_array(${ids.join(',')}, ',')::uuid[])
  `;

  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.email) map.set(row.id, row.email);
  }
  return map;
};

/** Wrap the email lookup so an `auth`-schema failure degrades to an empty map
 *  (→ `reviewer_email: null`) + a warn, never a 500. */
async function safeFetchEmails(
  c: AdminContext,
  fetchEmails: FetchReviewerEmails,
  prisma: AcceleratedPrisma,
  reviewerIds: string[],
): Promise<Map<string, string>> {
  if (reviewerIds.length === 0) return new Map();
  try {
    return await fetchEmails(prisma, reviewerIds);
  } catch (error) {
    try {
      logToDatadog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: 'Admin reviews: reviewer email lookup failed',
        data_gap: 'reviewer_email_lookup_failed',
      });
    } catch {
      console.warn('admin-reviews: reviewer email lookup failed', error);
    }
    return new Map();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Mirrors
 *  `routes/reviews.ts`, tagged `source: admin-moderation`. */
function makeForwarder(c: AdminContext): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
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
  // ZodError bubbles to `errorHandler()` → canonical VALIDATION_FAILED envelope
  // (the reject-reason refine surfaces here, keyed to `rejection_reason`).
  return schema.parse(raw);
}

/** Best-effort, post-commit Cache-Tag purge for an approved review's product.
 *  No-op without CF creds; never throws (telemetry is wrapped). */
async function purgeProductTag(c: AdminContext, slug: string): Promise<void> {
  const creds = { apiToken: c.env.CF_PURGE_API_TOKEN, zoneId: c.env.CF_ZONE_ID };
  const outcome = await callCloudflarePurge(fetch, creds, [`product:${slug}`]);
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.cache.purge', 1, [
      'source:moderation',
      `outcome:${outcome.ok ? 'ok' : 'cf_failed'}`,
    ]);
    if (!outcome.ok) {
      logToDatadog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: `Cache purge failed for product:${slug}`,
        outcome: `cf_${outcome.status}: ${outcome.message}`,
      });
    }
  } catch (error) {
    console.warn('admin-reviews: purge telemetry failed', error);
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

/** `GET /api/admin/reviews` — the moderation queue. */
export function createAdminReviewsListHandler(
  prismaFor: PrismaFactory = getPrisma,
  fetchEmails: FetchReviewerEmails = fetchReviewerEmails,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const query = ListPendingReviewsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const prisma = prismaFor(c.env);
    const db = prisma as unknown as AdminReviewsClient;

    const where = { status: query.status };
    const skip = (query.page - 1) * query.perPage;
    // `queue_age` works the backlog oldest-first; `created_at` is newest-first.
    // `id` tiebreaks a `created_at` collision so pagination is stable across
    // pages. `as const` keeps the literal narrow (inline orderBy otherwise
    // widens to `string` and drops Prisma's select-narrowing).
    const direction = query.sort === 'created_at' ? ('desc' as const) : ('asc' as const);

    const [rows, total] = await Promise.all([
      db.review.findMany({
        where,
        orderBy: [{ createdAt: direction }, { id: 'asc' as const }],
        skip,
        take: query.perPage,
        select: adminReviewSelect,
      }),
      db.review.count({ where }),
    ]);

    const reviewerIds = rows.map((row) => row.reviewerId).filter((id): id is string => id !== null);
    const emailByReviewerId = await safeFetchEmails(c, fetchEmails, prisma, reviewerIds);

    const body: ListPendingReviewsResponse = {
      data: rows.map((row) => toAdminReview(row, emailByReviewerId)),
      page: query.page,
      perPage: query.perPage,
      total,
    };

    validateResponseInDev(c.env, () => {
      ListPendingReviewsResponseSchema.parse(body);
    });

    return json(body);
  };
}

/** `PATCH /api/admin/reviews/:id` — approve / reject a pending review. */
export function createModerateReviewHandler(
  prismaFor: PrismaFactory = getPrisma,
  fetchEmails: FetchReviewerEmails = fetchReviewerEmails,
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

    const prisma = prismaFor(c.env);
    const db = prisma as unknown as ModerateClient;

    // Preload the full admin row: it both gates the transition (status) and
    // builds the response — the values we set ourselves are merged in after the
    // commit, so there is no post-commit re-read.
    const existing = await db.review.findUnique({ where: { id }, select: adminReviewSelect });
    if (!existing) throw notFoundError('review', { id });
    if (existing.status !== 'pending') {
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        `Review is ${existing.status}; only pending reviews can be moderated.`,
      );
    }

    const approve = payload.action === 'approve';
    const newStatus = approve ? 'approved' : 'rejected';
    const rejectionReason = approve ? null : (payload.rejection_reason as string);
    const moderatedAt = new Date();
    const forward = makeForwarder(c);

    await db.$transaction(async (tx) => {
      // Atomic guard: only transition a still-pending row. If a concurrent
      // moderation already moved it, `count` is 0 → 422 (rolls back) — closes
      // the two-admins-racing window the preload check can't.
      const updated = await tx.review.updateMany({
        where: { id, status: 'pending' },
        data: {
          status: newStatus,
          moderatedBy: userId,
          moderatedAt,
          ...(approve ? {} : { rejectionReason }),
        },
      });
      if (updated.count !== 1) {
        throw new ApiError(
          422,
          ApiErrorCode.INVALID_STATE_TRANSITION,
          'Review is no longer pending.',
        );
      }

      // Denormalized counts recompute on approval ONLY (§5.6 note): a rejected
      // review was never counted, so nothing public changes.
      if (approve) {
        await recompute(tx, [existing.product.id]);
      }

      await appendAuditLog(
        tx,
        {
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
        },
        forward,
      );
    });

    // Post-commit, approve-only: purge the product Cache-Tag so the public
    // list/summary refresh. Best-effort via `waitUntil`; no-op without CF creds.
    if (approve && c.env.CF_PURGE_API_TOKEN && c.env.CF_ZONE_ID) {
      c.executionCtx.waitUntil(purgeProductTag(c, existing.product.slug));
    }

    // Build the response from the preloaded row + the values we just committed.
    const moderatedRow: RawAdminReviewRow = {
      ...existing,
      status: newStatus,
      moderatedAt,
      rejectionReason: approve ? existing.rejectionReason : rejectionReason,
    };
    const emailByReviewerId = await safeFetchEmails(
      c,
      fetchEmails,
      prisma,
      existing.reviewerId ? [existing.reviewerId] : [],
    );
    const body: ModerateReviewResponse = toAdminReview(moderatedRow, emailByReviewerId);

    validateResponseInDev(c.env, () => {
      AdminReviewSchema.parse(body);
    });

    return json(body);
  };
}
