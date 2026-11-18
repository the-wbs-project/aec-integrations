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
 *
 * ── The sign-in Terms acceptance (AECI-1637) ────────────────────────────────────
 * Signing in is the acceptance (ruling of 2026-11-13). Once the profile exists, this
 * handler records the acceptance of the Terms version in force: one `terms_acceptances`
 * row and its `terms.accepted` audit row in one `db.batch`, once per account per version
 * (`lib/reader-legal-acceptance.ts`). The IP and browser are the eyeball request's: the
 * callback forwards `CF-Connecting-IP` and `User-Agent` on this call. Only this caller
 * writes it, not the `GET /api/account` self-heal. It never fails the ensure: a failure
 * is logged and the answer is unchanged. While no Terms version is in force (today) it
 * reads and writes nothing.
 */

import type { LegalInForceMaps } from '@aeci/shared';
import { forwardAuditLog } from '@aeci/shared/audit-log';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { ensureProfileRow, profileAuditForwarder } from '../lib/profile-provisioning';
import {
  recordSignInTermsAcceptance,
  SIGN_IN_ACCEPTANCE_SOURCE,
} from '../lib/reader-legal-acceptance';
import type { UserAuthVariables } from '../lib/user-auth';

export interface EnsureProfileDeps {
  now?: () => Date;
  /** The in-force maps (`LEGAL_IN_FORCE_MAPS` when absent). Injected by specs. */
  maps?: LegalInForceMaps;
}

export function createEnsureProfileHandler(
  dbFor: DbFactory = getDb,
  deps: EnsureProfileDeps = {},
): (c: Context<{ Bindings: Env; Variables: UserAuthVariables }>) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const { userId, email } = c.get('user');
    const { db } = writeDb(c, dbFor);

    const { created, auditEntry } = await ensureProfileRow(db, userId, 'auth-callback');
    if (auditEntry) {
      c.executionCtx.waitUntil(
        forwardAuditLog(auditEntry, profileAuditForwarder(c, 'auth-callback')),
      );
    }

    // AECI-1637: the sign-in is the Terms acceptance. Never throws (header).
    const accepted = await recordSignInTermsAcceptance(db, {
      profileId: userId,
      email,
      headers: c.req.raw.headers,
      now: clock(),
      maps: deps.maps,
    });
    if (accepted) forwardAuditBatch(c, [accepted], [], SIGN_IN_ACCEPTANCE_SOURCE);

    return json({ created });
  };
}
