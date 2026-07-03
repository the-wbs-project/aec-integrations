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
import { and, asc, count, desc, eq, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { reviews } from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import type { AuthzVariables } from '../lib/authz';
import { accountReviewConfig, toAccountReview } from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

export function createGetAccountReviewsHandler(
  dbFor: DbFactory = getDb,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');

    const query = AccountReviewsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);

    // Server-set scope: the verified token `sub`, never a client value. No
    // `status` filter — the author sees every status of their own reviews. An
    // optional `product_id` (AECI-260) only NARROWS to one product; it can never
    // widen scope. No `archived` exclusion is needed: there is no archive flow
    // yet, so `total >= 1` here already matches the server's non-archived
    // duplicate rule (`routes/reviews.ts`) — revisit if archiving lands.
    const conds: SQL[] = [eq(reviews.reviewerId, session.userId)];
    if (query.product_id) conds.push(eq(reviews.productId, query.product_id));
    const where = and(...conds);

    const [rows, countRows] = await Promise.all([
      db.query.reviews.findMany({
        ...accountReviewConfig,
        where,
        // Newest-first (§6.1); `id` tiebreaks a `created_at` collision.
        orderBy: [desc(reviews.createdAt), asc(reviews.id)],
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(reviews).where(where),
    ]);

    const body: AccountReviewsResponse = {
      data: rows.map(toAccountReview),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      AccountReviewsResponseSchema.parse(body);
    });

    return json(body);
  };
}
