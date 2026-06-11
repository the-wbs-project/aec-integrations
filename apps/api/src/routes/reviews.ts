/**
 * `POST /api/reviews` (AECI-197 / Phase 5.6) — the review submission write path
 * and the first authenticated user write in the product.
 *
 * Auth-gated (`requireAuth({ bannedCode: REVIEW_BANNED })`, registered in
 * `index.ts`) insert of a `status='pending'` review into the existing `reviews`
 * table for the Phase 5 moderation pipeline to pick up. `reviewer_id` is the
 * verified token `sub` from `c.get('auth')` — server-set, never client-supplied
 * — and `locale` is resolved server-side (see `resolveLocale`); neither is a
 * body field. Public display, the form, and toxicity scoring are out of scope
 * (5.7 / 5.8 / 5.9 / 5.10).
 *
 * Dedup is enforced two ways (`API_CONTRACTS.md` §6.6):
 *   1. an app-level pre-check (`review.findFirst` on a non-archived row), and
 *   2. a backstop: the DB partial unique index
 *      `reviews_unique_per_user_product` — a row racing past the pre-check trips
 *      a Prisma `P2002`, which we map to `409 REVIEW_DUPLICATE` (never a 500),
 *      reusing the structural P2002 detection from `routes/promote.ts`.
 *
 * Every insert writes an `audit_log` row (`review.submitted`, AUTH_AND_RLS.md
 * §4.4) in the same transaction (`appendAuditLog` — failure rolls back). The
 * write pattern + loose structural client type mirror `routes/requests.ts` /
 * `routes/auth-profile.ts`.
 *
 * Crucially, this does NOT recompute the product's denormalized `review_count`
 * / rating averages — that happens on approval only (5.13).
 */

import { ApiErrorCode, SubmitReviewSchema } from '@aeci/shared';
import type { SubmitReviewResponse } from '@aeci/shared';
// `DEFAULT_LOCALE` lives behind the dependency-free `algolia` subpath (it is not
// re-exported from the main barrel). The module has no I/O or runtime deps.
import { DEFAULT_LOCALE } from '@aeci/shared/algolia';
import { appendAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { logToDatadog } from '../datadog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import type { PrismaFactory } from '../lib/handler-utils';
import { getPrisma } from '../prisma';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

// ─── Loose structural Prisma surface ─────────────────────────────────────────
// Same approach as `routes/requests.ts`: we touch a small, known slice of the
// generated client, so we type it structurally and `as unknown as` it rather
// than dragging in the full edge-client generated types. A real accelerated
// client and the test fake both satisfy this.
type Row = { id: string };

type ReviewsTx = {
  review: {
    create(args: { data: Record<string, unknown>; select: { id: true } }): Promise<Row>;
  };
  auditLog: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
};

type ReviewsClient = {
  product: {
    findUnique(args: { where: { id: string }; select: { id: true } }): Promise<Row | null>;
  };
  review: {
    findFirst(args: { where: Record<string, unknown>; select: { id: true } }): Promise<Row | null>;
  };
  $transaction<T>(fn: (tx: ReviewsTx) => Promise<T>): Promise<T>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Known locales the API will honor on the trusted `x-aeci-locale` header. Only
 * `DEFAULT_LOCALE` ships at launch; when `@aeci/shared` grows a locale list,
 * widen this set there and import it. Until then this is the single seam.
 */
const KNOWN_LOCALES: ReadonlySet<string> = new Set([DEFAULT_LOCALE]);

/**
 * Resolve the review's `locale` from the trusted `x-aeci-locale` header,
 * falling back to `DEFAULT_LOCALE` for an absent or unrecognized value. The
 * header is set by the SSR Worker (it already does URL-prefix locale dispatch);
 * `locale` is never a client body field. This leaves a clean seam for when more
 * locales ship — no SSR change in this PR.
 */
function resolveLocale(headerValue: string | undefined): string {
  const value = headerValue?.trim();
  return value && KNOWN_LOCALES.has(value) ? value : DEFAULT_LOCALE;
}

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Mirrors
 *  the `routes/requests.ts` forwarder, tagged `source: review-form`. */
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

async function parseJsonBody<T>(c: AuthContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  // ZodError bubbles to `errorHandler()` → canonical VALIDATION_FAILED envelope.
  return schema.parse(raw);
}

/**
 * True when `err` is a Prisma `P2002` on the per-user-per-product unique index
 * (`reviews_unique_per_user_product`). Duck-typed (rather than
 * `instanceof PrismaClientKnownRequestError`) so it stays trivially testable and
 * doesn't pull the edge client's error class into the runtime path — the same
 * approach as `isSlugUniqueViolation` in `routes/promote.ts`. `meta.target` is
 * matched in both shapes Prisma emits: an array of columns and a
 * constraint-name string.
 */
function isReviewDuplicateViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const target = e.meta?.target;
  const asStr = Array.isArray(target) ? target.join(',') : String(target ?? '');
  // The index covers (product_id, reviewer_id); either column name (or the
  // constraint name) identifies it. A P2002 on any unrelated constraint returns
  // false and rethrows as a generic 500.
  return /reviewer_id|reviews_unique_per_user_product/.test(asStr.toLowerCase());
}

const reviewDuplicateError = (): ApiError =>
  new ApiError(409, ApiErrorCode.REVIEW_DUPLICATE, 'You have already reviewed this product.');

// ─── Handler ─────────────────────────────────────────────────────────────────

export function createSubmitReviewHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    // `userId` is the verified token `sub` (AUTH_AND_RLS.md §4) — the server
    // source for `reviewer_id` and the audit actor; the client never supplies it.
    const session = c.get('auth');
    const { userId } = session;

    const payload = await parseJsonBody(c, SubmitReviewSchema);
    const locale = resolveLocale(c.req.header('x-aeci-locale'));
    const prisma = prismaFor(c.env) as unknown as ReviewsClient;

    // Product must exist — loose-`product_id` insert would otherwise FK-fail as a
    // 500; a clean 404 lets the form surface it.
    const product = await prisma.product.findUnique({
      where: { id: payload.product_id },
      select: { id: true },
    });
    if (!product) throw notFoundError('product', { id: payload.product_id });

    // App-level dup pre-check: one non-archived review per (product, reviewer).
    // The DB partial unique index is the backstop for the race (handled below).
    const existing = await prisma.review.findFirst({
      where: { productId: payload.product_id, reviewerId: userId, status: { not: 'archived' } },
      select: { id: true },
    });
    if (existing) throw reviewDuplicateError();

    const forward = makeForwarder(c);

    const created = await prisma
      .$transaction(async (tx) => {
        // `status` ('pending'), `verifiedWorkEmail`, timestamps take their column
        // defaults. We deliberately do NOT touch the product's denormalized
        // `review_count` / rating averages — that happens on approval (5.13).
        const row = await tx.review.create({
          data: {
            productId: payload.product_id,
            reviewerId: userId,
            ratingOverall: payload.rating_overall,
            ratingOnboarding: payload.rating_onboarding,
            title: payload.title,
            body: payload.body,
            // Optional fields: omit (→ NULL default) when the client left them out.
            ...(payload.role_at_company !== undefined && {
              roleAtCompany: payload.role_at_company,
            }),
            ...(payload.years_using !== undefined && { yearsUsing: payload.years_using }),
            ...(payload.would_recommend !== undefined && {
              wouldRecommend: payload.would_recommend,
            }),
            locale,
          },
          select: { id: true },
        });
        await appendAuditLog(
          tx,
          {
            actorId: userId,
            actorType: auditActorType(session),
            action: 'review.submitted',
            entityType: 'review',
            entityId: row.id,
            metadata: { source: 'review-form', product_id: payload.product_id },
          },
          forward,
        );
        return row;
      })
      // A row racing past the pre-check trips `reviews_unique_per_user_product`
      // (Prisma P2002). Map it to the documented 409, not a generic 500; any
      // other failure rethrows and surfaces as 500.
      .catch((err: unknown): never => {
        if (isReviewDuplicateViolation(err)) throw reviewDuplicateError();
        throw err;
      });

    const body: SubmitReviewResponse = {
      id: created.id,
      status: 'pending',
      message: 'Thanks — your review has been submitted and will appear once approved.',
    };
    return json(body, { status: 201 });
  };
}
