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
  let sub: string | undefined;
  let email: string | undefined;
  try {
    const { payload } = await jwtVerify(token, getKey ?? remoteJwks(supabaseUrl), {
      issuer: `${supabaseUrl}/auth/v1`,
      audience: 'authenticated',
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

    c.set('user', await verifySupabaseJwt(token, supabaseUrl, options.getKey));

    await next();
  };
}
