/**
 * `GET /api/admin/summary` (AECI-203 / Phase 5.12) — the admin shell's badge feed.
 *
 * Admin-gated (`requireAdmin()`, registered in `index.ts`) read-only count of
 * `pending` reviews for the moderation-queue badge (`STAGE_1_SPEC.md` §22.1).
 * `requireAdmin()` is the single enforcement point (`STAGE_1_PHASE_5_SPEC.md`
 * §7.1): it verifies the JWT (bearer or the `sb-…-auth-token` cookie the SSR
 * Worker forwards), loads `profiles.role`, and rejects non-admins with `403`
 * (and missing token / profile with `401`) BEFORE this handler runs.
 *
 * This endpoint doubles as the SSR admin gate: the `/admin` resolver reads a 200
 * as "the caller is an admin" and a 401/403 as "render a 404" (don't reveal the
 * surface). Because it is a read, there is NO `appendAuditLog` write and no cache
 * work.
 *
 * The full paginated moderation queue (`GET /api/admin/reviews`) is Phase 5.13 —
 * this endpoint deliberately exposes only the aggregate count the shell needs.
 *
 * Loose structural Prisma surface + `prismaFor` test seam mirror
 * `routes/reviews.ts`.
 */

import type { AdminSummaryResponse } from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { json } from '../http';
import type { AuthzVariables } from '../lib/authz';
import type { PrismaFactory } from '../lib/handler-utils';
import { getPrisma } from '../prisma';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

// ─── Loose structural Prisma surface ─────────────────────────────────────────
// We touch a single aggregate (`review.count`), so type it structurally and
// `as unknown as` it rather than dragging in the full edge-client types. A real
// accelerated client and the test fake both satisfy this.
type AdminSummaryClient = {
  review: { count(args: { where: { status: string } }): Promise<number> };
};

// ─── Handler ─────────────────────────────────────────────────────────────────

export function createAdminSummaryHandler(
  prismaFor: PrismaFactory = getPrisma,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const prisma = prismaFor(c.env) as unknown as AdminSummaryClient;
    const pendingReviews = await prisma.review.count({ where: { status: 'pending' } });
    const body: AdminSummaryResponse = { pending_reviews: pendingReviews };
    return json(body);
  };
}
