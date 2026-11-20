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
 *
 * The tick box (counsel Q63, ruling 53). When a Terms version that reduces rights is in
 * force and this account has not ticked a box covering it, the ensure writes no row and
 * answers `terms_acceptance: { version }`. The callback then sends the reader to
 * `/auth/terms`, whose box posts to `POST /api/auth/terms/accept` (below, on the
 * cookie-reading `requireAuth()` router). Every other
 * sign-in answers `terms_acceptance: null`.
 */

import {
  AcceptTermsRequestSchema,
  AcceptTermsResponseSchema,
  ApiErrorCode,
  EnsureProfileResponseSchema,
  TermsPendingResponseSchema,
  type AcceptTermsResponse,
  type TermsPendingResponse,
  type EnsureProfileResponse,
  type LegalInForceMaps,
} from '@aeci/shared';
import { forwardAuditLog } from '@aeci/shared/audit-log';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { ensureProfileRow, profileAuditForwarder } from '../lib/profile-provisioning';
import {
  recordSignInTermsAcceptance,
  SIGN_IN_ACCEPTANCE_SOURCE,
  readTermsBoxPending,
  TERMS_BOX_ACCEPTANCE_SOURCE,
  writeTermsBoxAcceptance,
} from '../lib/reader-legal-acceptance';
import type { AuthzVariables } from '../lib/authz';
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

    // AECI-1637: the sign-in is the Terms acceptance, unless a version that reduces
    // rights waits for the tick box (ruling 53). Never throws (header).
    const terms = await recordSignInTermsAcceptance(db, {
      profileId: userId,
      email,
      headers: c.req.raw.headers,
      now: clock(),
      created,
      maps: deps.maps,
    });
    if (terms.entry) forwardAuditBatch(c, [terms.entry], [], SIGN_IN_ACCEPTANCE_SOURCE);

    const body: EnsureProfileResponse = {
      created,
      terms_acceptance: terms.boxVersion ? { version: terms.boxVersion } : null,
    };
    validateResponseInDev(c.env, () => EnsureProfileResponseSchema.parse(body));
    return json(body);
  };
}

export interface AcceptTermsDeps {
  now?: () => Date;
  /** The in-force maps (`LEGAL_IN_FORCE_MAPS` when absent). Injected by specs. */
  maps?: LegalInForceMaps;
}

/**
 * `POST /api/auth/terms/accept` (AECI-1637, counsel Q63, ruling 53): the reader ticked the
 * box on `/auth/terms` for a Terms version that reduces their rights. The browser calls it
 * over the `/api/*` proxy with the session cookie, so the guard is `requireAuth()` (it reads
 * the cookie; `requireUserAuth()` reads only a bearer), then `rateLimit('write')`. A banned
 * account gets the guard's `403`. The profile is the session's `userId` and the email the
 * session's, never the body's. The pending check, the row and its audit row are
 * `writeTermsBoxAcceptance` (`lib/reader-legal-acceptance.ts`). `422
 * LEGAL_ACCEPTANCE_NOT_PENDING` for a version not waiting for this account; a box already
 * ticked for it answers 200 again, nothing written. No cache purge: no page shows it.
 */
export function createAcceptTermsHandler(
  dbFor: DbFactory = getDb,
  deps: AcceptTermsDeps = {},
): (c: Context<{ Bindings: Env; Variables: AuthzVariables }>) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const { userId, email } = c.get('auth');
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
    }
    const input = AcceptTermsRequestSchema.parse(raw);
    const { db } = writeDb(c, dbFor);
    const result = await writeTermsBoxAcceptance(db, {
      profileId: userId,
      email,
      headers: c.req.raw.headers,
      now: clock(),
      version: input.version,
      maps: deps.maps,
    });
    if (result.entry) forwardAuditBatch(c, [result.entry], [], TERMS_BOX_ACCEPTANCE_SOURCE);
    const body: AcceptTermsResponse = { version: input.version, accepted_at: result.acceptedAt };
    validateResponseInDev(c.env, () => AcceptTermsResponseSchema.parse(body));
    return json(body);
  };
}

/**
 * `GET /api/auth/terms/pending` (AECI-1637, counsel Q3 and Q63): what `/auth/terms` shows,
 * the version waiting for this account's tick with its date, its published summary and the
 * version that applies until then (`readTermsBoxPending`). `requireAuth()` only, the cookie
 * guard: a read, so never rate-limited (`docs/waf-rate-limits.md` §6). No audit row.
 */
export function createTermsPendingHandler(
  dbFor: DbFactory = getDb,
  deps: AcceptTermsDeps = {},
): (c: Context<{ Bindings: Env; Variables: AuthzVariables }>) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const { userId } = c.get('auth');
    const { db } = dbFor(c.env);
    const body: TermsPendingResponse = {
      pending: await readTermsBoxPending(db, userId, clock(), deps.maps),
    };
    validateResponseInDev(c.env, () => TermsPendingResponseSchema.parse(body));
    return json(body);
  };
}
