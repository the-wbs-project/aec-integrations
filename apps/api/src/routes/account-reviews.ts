/**
 * Phase 5.11 (AECI-225) reviewer-scoped own-reviews list.
 *
 *   GET /api/account/reviews — the signed-in user's OWN reviews, paginated,
 *   newest-first, in every status (pending / approved / rejected).
 *
 * Auth + scope:
 *   - `requireAuth()` (registered in `index.ts`) sets `c.get('auth')`; the scope
 *     filter is `reviewerId = session.userId` — **server-set, never
 *     client-supplied**. A `?reviewer_id=…` query param has no effect: the schema
 *     doesn't read it and the `where` is built from the verified session `sub`.
 *   - Unlike the public list, there is NO `status` filter, so the author sees
 *     pending + approved + rejected (with `rejection_reason`).
 *
 * Contracts:
 *   - Query shape: `AccountReviewsQuerySchema` (page/perPage) from `@aeci/shared`.
 *   - Response shape: `AccountReviewsResponseSchema` — `PaginatedResponse<AccountReview>`.
 *     No PII / admin-only columns (`reviewer_email`, `toxicity_score`, moderation
 *     fields, `locale`) — see `accountReviewSelect`.
 *   - `Cache-Control: private, no-store` applied by `json()`.
 *   - 4xx envelope produced by `errorHandler()` in `errors.ts`.
 *
 * Pagination is page-based (Phase 2 Spec §7.3), consistent with the public and
 * admin reviews lists; the issue's "cursor" wording is a noted deviation
 * (`API_CONTRACTS.md` §6.8). Structure mirrors `routes/product-reviews.ts`.
 */

import {
  AccountReviewsQuerySchema,
  AccountReviewsResponseSchema,
  type AccountReviewsResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { json } from '../http';
import { validateResponseInDev, type PrismaFactory } from '../lib/handler-utils';
import type { AuthzVariables } from '../lib/authz';
import { accountReviewSelect, toAccountReview } from '../lib/prisma-helpers';
import { getPrisma } from '../prisma';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

export function createGetAccountReviewsHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');

    const query = AccountReviewsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const prisma = prismaFor(c.env);

    // Server-set scope: the verified token `sub`, never a client value. No
    // `status` filter — the author sees every status of their own reviews.
    const where = { reviewerId: session.userId };
    const skip = (query.page - 1) * query.perPage;

    const [rows, total] = await Promise.all([
      prisma.review.findMany({
        where,
        // Newest-first (§6.1); `id` tiebreaks a `created_at` collision so
        // pagination is stable across pages.
        orderBy: [{ createdAt: 'desc' as const }, { id: 'asc' as const }],
        skip,
        take: query.perPage,
        select: accountReviewSelect,
      }),
      prisma.review.count({ where }),
    ]);

    const body: AccountReviewsResponse = {
      data: rows.map(toAccountReview),
      page: query.page,
      perPage: query.perPage,
      total,
    };

    validateResponseInDev(c.env, () => {
      AccountReviewsResponseSchema.parse(body);
    });

    return json(body);
  };
}
