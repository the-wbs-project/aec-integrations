/**
 * User-session auth for the API Worker (AECI-193 / Phase 5.2).
 *
 * The SSR Worker forwards the user's Supabase access token as
 * `Authorization: Bearer <jwt>` over the service binding; this middleware
 * verifies it **locally** against the Supabase project's public JWKS
 * (`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`) using `jose` — no DB
 * round-trip and no Supabase client on this Worker (AUTH_AND_RLS.md §4).
 * Tokens are ES256-signed (verified during the AECI-193 spike; the
 * integration suite guards the signing-key alg against regression).
 *
 * Mirrors the shape of `review-auth.ts` (the M2M bearer guard): a factory
 * returning Hono middleware that throws `ApiError(401, UNAUTHENTICATED)` on
 * any failure, rendered by the sub-router's `errorHandler()` as the canonical
 * `docs/API_CONTRACTS.md` §3.3 envelope. All failure modes — missing header,
 * malformed token, bad signature, expired, wrong issuer/audience, missing
 * `SUPABASE_URL` — collapse to the same 401 (fail-closed, no oracle).
 *
 * `jose`'s `createRemoteJWKSet` is Workers-clean (WebCrypto + fetch, no
 * `nodejs_compat`): it fetches the JWKS lazily on first verify (inside a
 * request context, as Workers require) and caches/refetches per its own
 * cooldown rules. We memoize one key-set per `SUPABASE_URL` at module level so
 * the isolate reuses the cached keys across requests.
 */

import { ApiErrorCode } from '@aeci/shared';
// From the shared transport, not `../posthog`: this registers identity rather
// than emitting telemetry, and route specs that `vi.mock('../posthog')` must
// not silently switch it off (see the same note in `authz.ts`).
import { rememberPosthogDistinctId } from '@aeci/shared/posthog';
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';

import type { Env } from '../env';
import { ApiError } from '../errors';

/** What a verified token resolves to. `email` is informational and optional. */
export type AuthenticatedUser = {
  userId: string;
  email?: string;
};

/** Hono `Variables` contributed by `requireUserAuth()`. */
export type UserAuthVariables = {
  user: AuthenticatedUser;
};

export type UserAuthOptions = {
  /**
   * Test seam: inject a local key resolver (e.g. jose's `createLocalJWKSet`)
   * so unit tests verify offline. Production callers omit it and get the
   * remote JWKS for `c.env.SUPABASE_URL`.
   */
  getKey?: JWTVerifyGetKey;
};

export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/** One remote JWKS per Supabase URL, shared across requests in this isolate. */
const remoteJwksByUrl = new Map<string, JWTVerifyGetKey>();

function remoteJwks(supabaseUrl: string): JWTVerifyGetKey {
  let keySet = remoteJwksByUrl.get(supabaseUrl);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(`${supabaseUrl}/auth/v1/.well-known/jwks.json`));
    remoteJwksByUrl.set(supabaseUrl, keySet);
  }
  return keySet;
}

export function unauthenticated(): ApiError {
  return new ApiError(401, ApiErrorCode.UNAUTHENTICATED, 'Missing or invalid user credentials');
}

/**
 * Verify a Supabase user JWT against the project's JWKS and resolve the
 * authenticated user. Shared by `requireUserAuth()` (pure JWT guard) and the
 * Phase 5.5 authz middleware (`lib/authz.ts`, JWT + role/ban). Throws
 * `ApiError(401, UNAUTHENTICATED)` on any failure — signature, expiry, issuer,
 * audience, malformed token, JWKS fetch, missing `sub` — so callers fail
 * closed without an oracle.
 */
export async function verifySupabaseJwt(
  token: string,
  supabaseUrl: string,
  getKey?: JWTVerifyGetKey,
): Promise<AuthenticatedUser> {
  return verifyWithClockTolerance(token, supabaseUrl, 0, getKey);
}

/**
 * The same verification as {@link verifySupabaseJwt}, but tolerating a token
 * whose `exp` passed up to `graceSeconds` ago (AECI-689).
 *
 * **This must never be used to authorize anything, and the name is the guard.**
 * There is exactly one legitimate caller — `lib/operator-session.ts`, deciding
 * the `page_views.is_operator` analytics flag — and the distinction that makes
 * it sound is that `is_operator` is not an authorization decision. It grants no
 * access, reads no private data and changes no response. It decides whether a
 * row counts as the operator's own traffic in the operator's own analytics
 * (`ADMIN_PANEL_SPEC.md` §13 D13).
 *
 * **What is still enforced, and why §13 D13's first property survives intact.**
 * The signature is verified against the project's JWKS exactly as above, and the
 * issuer and audience are still checked. Only the expiry clock moves. So the
 * token remains *server-derived, never claimed*: a caller cannot assert their
 * way into the flag, because forging one means signing a JWT with Supabase's
 * key. An expired-but-validly-signed token is not a usable credential, but it is
 * conclusive evidence of **who is holding the browser**, which is the only
 * question `is_operator` asks.
 *
 * The failure it exists to stop is real and measured: on 2026-08-26 an operator
 * browsed for 105 minutes across a token expiry and wrote 22 page views flagged
 * as a stranger's (§13 D15(a)).
 *
 * `apps/api/src/lib/user-auth.spec.ts` pins that `requireUserAuth` and
 * `lib/authz.ts` still reject an expired token, so this cannot leak sideways
 * without a test failing.
 */
export async function verifySupabaseJwtWithinGrace(
  token: string,
  supabaseUrl: string,
  graceSeconds: number,
  getKey?: JWTVerifyGetKey,
): Promise<AuthenticatedUser> {
  return verifyWithClockTolerance(token, supabaseUrl, graceSeconds, getKey);
}

async function verifyWithClockTolerance(
  token: string,
  supabaseUrl: string,
  clockTolerance: number,
  getKey?: JWTVerifyGetKey,
): Promise<AuthenticatedUser> {
  let sub: string | undefined;
  let email: string | undefined;
  try {
    const { payload } = await jwtVerify(token, getKey ?? remoteJwks(supabaseUrl), {
      issuer: `${supabaseUrl}/auth/v1`,
      audience: 'authenticated',
      // `jose` applies this to `exp` AND `nbf`. Zero for every authorization
      // caller, which is the default this file shipped with.
      clockTolerance,
    });
    sub = payload.sub;
    email = typeof payload['email'] === 'string' ? payload['email'] : undefined;
  } catch {
    // Signature, expiry, issuer, audience, malformed-token, and JWKS-fetch
    // failures all collapse to the same 401 — fail closed, leak nothing.
    throw unauthenticated();
  }
  if (!sub) throw unauthenticated();
  return { userId: sub, email };
}

/**
 * Hono middleware requiring a valid Supabase user JWT in
 * `Authorization: Bearer <jwt>`. On success sets `c.get('user')` to
 * `{ userId, email? }` (`userId` = the token's `sub`, the `auth.users` UUID
 * that RLS policies key on). On any failure throws
 * `ApiError(401, UNAUTHENTICATED)` before the handler runs.
 */
export function requireUserAuth(
  options: UserAuthOptions = {},
): MiddlewareHandler<{ Bindings: Env; Variables: UserAuthVariables }> {
  return async (c, next) => {
    const supabaseUrl = c.env.SUPABASE_URL;
    const token = extractBearer(c.req.header('Authorization'));
    if (!supabaseUrl || !token) throw unauthenticated();

    const user = await verifySupabaseJwt(token, supabaseUrl, options.getKey);
    c.set('user', user);
    // One of the two places in this Worker where a genuine Supabase user id
    // exists (the other is `lib/authz.ts`). Registering it here is what puts
    // `posthogDistinctId` on every log this request emits — AECI-644 / §AW3.
    rememberPosthogDistinctId(c.req.raw, user.userId);

    await next();
  };
}
