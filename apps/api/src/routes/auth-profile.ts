/**
 * `POST /api/auth/profile/ensure` (AECI-195 / Phase 5.4) — Drizzle/D1 (ADR 0016).
 *
 * Idempotent profile provisioning (split-identity seam #1, AECI-251/254). Under
 * D1 there is no `handle_new_user` trigger, so this endpoint is the PRIMARY
 * profile creator: `requireUserAuth()` runs first, so the row id is always the
 * verified token's `sub`. The SSR `/auth/callback` handler calls it after the
 * PKCE code exchange, retries it, and signs the user out if it keeps failing
 * (AECI-770). `GET /api/account` runs the same insert as a self-heal.
 *
 * The insert, the no-clobber contract (AECI-527) and the audit ordering live in
 * `lib/profile-provisioning.ts` so both callers share one implementation.
 * `auth-profile.spec.ts` regression-tests the no-clobber property.
 */

import { forwardAuditLog } from '@aeci/shared/audit-log';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { ensureProfileRow, profileAuditForwarder } from '../lib/profile-provisioning';
import type { UserAuthVariables } from '../lib/user-auth';

export function createEnsureProfileHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env; Variables: UserAuthVariables }>) => Promise<Response> {
  return async (c) => {
    const { userId } = c.get('user');
    const { db } = writeDb(c, dbFor);

    const { created, auditEntry } = await ensureProfileRow(db, userId, 'auth-callback');
    if (auditEntry) {
      c.executionCtx.waitUntil(
        forwardAuditLog(auditEntry, profileAuditForwarder(c, 'auth-callback')),
      );
    }

    return json({ created });
  };
}
