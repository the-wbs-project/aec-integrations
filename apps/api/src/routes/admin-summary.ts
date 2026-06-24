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
 * surface). Because it is a read, there is NO audit-log write and no cache
 * work.
 *
 * The full paginated moderation queue (`GET /api/admin/reviews`) is Phase 5.13 —
 * this endpoint deliberately exposes only the aggregate count the shell needs.
 *
 * Loose structural Prisma surface + `prismaFor` test seam mirror
 * `routes/reviews.ts`.
 */

import type { AdminSummaryResponse } from '@aeci/shared';
import { count, eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { reviews } from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import type { DbFactory } from '../lib/handler-utils';

// ─── Handler ─────────────────────────────────────────────────────────────────
// The `requireAdmin()` gate (index.ts) enforces access + sets `c.get('auth')`;
// this handler reads no auth context, so it is typed on Bindings alone.

export function createAdminSummaryHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const { db } = dbFor(c.env);
    const rows = await db
      .select({ value: count() })
      .from(reviews)
      .where(eq(reviews.status, 'pending'));
    const body: AdminSummaryResponse = { pending_reviews: rows[0]?.value ?? 0 };
    return json(body);
  };
}
