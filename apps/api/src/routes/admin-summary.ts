/**
 * `GET /api/admin/summary` (AECI-203 / Phase 5.12) — the admin shell's badge feed.
 *
 * Admin-gated (`requireAdmin()`, registered in `index.ts`) read-only counts of
 * the three Operations queues — pending reviews (`STAGE_1_SPEC.md` §22.1), open
 * correction requests, and open vendor claims (AECI-922). The console renders
 * one per nav item and their SUM on the closed Operations trigger, which is only
 * honest because the three sets are disjoint; `lib/admin-queue-counts.ts` owns
 * that rule and is shared verbatim with `GET /api/account`, so the console badge
 * and the header badge cannot report different backlogs.
 *
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
 * The full paginated queues (`GET /api/admin/reviews`, `/requests`, `/claims`)
 * live elsewhere — this endpoint deliberately exposes only the aggregate counts
 * the shell's nav needs.
 *
 * Loose structural DB surface + the `getDb` test seam mirror
 * `routes/reviews.ts`.
 */

import type { AdminSummaryResponse } from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import { readAdminQueueCounts } from '../lib/admin-queue-counts';
import type { DbFactory } from '../lib/handler-utils';

// ─── Handler ─────────────────────────────────────────────────────────────────
// The `requireAdmin()` gate (index.ts) enforces access + sets `c.get('auth')`;
// this handler reads no auth context, so it is typed on Bindings alone.

export function createAdminSummaryHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const { db } = dbFor(c.env);
    const body: AdminSummaryResponse = await readAdminQueueCounts(db);
    return json(body);
  };
}
