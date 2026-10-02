/**
 * `POST /api/activity/arrival` (AECI-1208, `docs/API_CONTRACTS.md`).
 *
 * The arrival beacon. The browser's `ArrivalCaptureService` sends it once per app
 * instance, after hydration, when the visitor is signed in and the landing URL
 * carried `utm_source`, `utm_campaign` or `n`. The API never sees the landing URL
 * otherwise: an SSR landing makes its API calls from the resolver, and later
 * loads replay them from TransferState.
 *
 * Guarded by `requireAuth()` then `rateLimit('write')` (`docs/waf-rate-limits.md`
 * §6.2). The body is the strict `ActivityArrivalRequestSchema`. The write is the
 * same profile-gated upsert the activity middleware runs (`lib/user-activity.ts`),
 * inline rather than in `waitUntil` because the write is the whole point of the
 * request. It creates the day's row if this is the first request of the day, sets
 * no surface bit, and fills the arrival group only while the row has none: the
 * first arrival of the day wins, so a reload that resends is harmless.
 *
 * A per-user service log (ADR 0022, 2026-10-02 amendment): no `audit_log` row.
 */

import { ActivityArrivalRequestSchema } from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { ApiError } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { upsertUserActivity } from '../lib/user-activity';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

export function createActivityArrivalHandler(
  dbFor: DbFactory = getDb,
  now: () => Date = () => new Date(),
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }
    const body = ActivityArrivalRequestSchema.parse(raw);

    const { db } = writeDb(c, dbFor);
    await upsertUserActivity(db, {
      userId: session.userId,
      role: session.role,
      vendorId: session.vendorId,
      at: now(),
      surfaces: 0,
      arrival: {
        utmSource: body.utm_source ?? null,
        utmCampaign: body.utm_campaign ?? null,
        notificationId: body.n ?? null,
      },
    });

    return new Response(null, { status: 204 });
  };
}
