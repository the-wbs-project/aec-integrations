/**
 * The verified email of the caller's session, if any (AECI-1435, ADR 0042).
 *
 * A claim or listing request skips the emailed confirmation only when the visitor is
 * signed in AND the session's verified email is the address they typed. This helper
 * answers the first half. The caller compares.
 *
 * **Strict verification only.** The token comes from `Authorization: Bearer` or the
 * `sb-*` session cookie, the extraction `lib/authz.ts` uses, and is checked by
 * `verifySupabaseJwt`: signature, issuer, audience and an unexpired `exp`. Never the
 * grace-window verifier, which exists for an analytics flag and must never decide
 * anything (`lib/user-auth.ts`).
 *
 * **Fail closed.** No token, no `SUPABASE_URL`, a bad or expired token, a JWKS fetch
 * failure, or a token with no `email` claim all return `null`, which sends the
 * submit down the confirm path. Nothing here throws: an anonymous visitor is the
 * normal case, not an error.
 *
 * The email is trimmed and lowercased, the comparison form `inviteRedeemState` uses.
 */

import { getCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { JWTVerifyGetKey } from 'jose';

import type { Env } from '../env';
import { extractSessionCookieToken } from './authz';
import { extractBearer, verifySupabaseJwt } from './user-auth';

/** A typed or session address in its comparison form. */
export function normalizeRequestEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** The seam the submit handlers take, so a spec can stand in for a session. */
export type SessionEmailResolver = (c: Context<{ Bindings: Env }>) => Promise<string | null>;

/**
 * The lowercased verified email of the caller's Supabase session, or `null`.
 * `getKey` is the test seam (`createLocalJWKSet`); production uses the remote JWKS.
 */
export async function verifiedSessionEmail(
  c: Context<{ Bindings: Env }>,
  getKey?: JWTVerifyGetKey,
): Promise<string | null> {
  const supabaseUrl = c.env.SUPABASE_URL;
  if (!supabaseUrl) return null;
  // Bearer wins, as in `lib/authz.ts`. A present but invalid bearer does not fall
  // back to the cookie: it fails, which here means the confirm path.
  const token =
    extractBearer(c.req.header('Authorization')) ?? extractSessionCookieToken(getCookie(c));
  if (!token) return null;
  try {
    const user = await verifySupabaseJwt(token, supabaseUrl, getKey);
    const email = user.email?.trim();
    return email ? normalizeRequestEmail(email) : null;
  } catch {
    return null;
  }
}

/** True when the session's verified email is the typed address. */
export function sessionMatchesTypedEmail(sessionEmail: string | null, typedEmail: string): boolean {
  if (!sessionEmail) return false;
  return normalizeRequestEmail(sessionEmail) === normalizeRequestEmail(typedEmail);
}
