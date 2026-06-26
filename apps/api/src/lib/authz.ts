/**
 * User-session authorization middleware for the API Worker (AECI-196 /
 * Phase 5.5). Implements `AUTH_AND_RLS.md` §4 (Layer 1 — the layer where
 * authorization is actually enforced: the privileged D1 binding has no RLS
 * (ADR 0016 / AECI-254), so this Worker is the real enforcement point).
 *
 * Two guards, both built on the AECI-193 JWT verification
 * (`lib/user-auth.ts`, jose + Supabase JWKS — no DB round-trip to verify):
 *
 *   - `requireAuth()`  — valid JWT + profile exists + not banned.
 *   - `requireAdmin()` — all of the above + `profiles.role = 'admin'`.
 *
 * Order of checks (AUTH_AND_RLS.md §4.1–4.2), all BEFORE the handler runs —
 * i.e. before any D1 write:
 *
 *   1. Extract the JWT: `Authorization: Bearer <jwt>` (the canonical
 *      service-binding path — the SSR Worker turns the `@supabase/ssr` cookie
 *      session into a bearer header) or, failing that, the browser's
 *      `sb-<ref>-auth-token` session cookie (the raw `/api/*` passthrough
 *      forwards cookies untouched). The cookie is TRANSPORT ONLY: the access
 *      token inside it goes through full JWKS verification, so nothing in the
 *      cookie is trusted.
 *   2. Verify or hard-fail `401 UNAUTHENTICATED` (§4.1 — a missing token on
 *      an authenticated route is 401, never anonymous treatment).
 *   3. Re-fetch `profiles.role` + `banned_at` from the DB on every request
 *      (§4.5 — never trust client-side claims about role). Missing profile →
 *      401; banned → `403` (`REVIEW_BANNED` on review writes via
 *      `bannedCode`, else `FORBIDDEN`); non-admin on an admin route → `403
 *      FORBIDDEN`.
 *
 * On success the handler gets `c.get('auth')` = `{ userId, email?, role }`.
 * `userId` is the verified token `sub` (the `auth.users` UUID) — handlers
 * MUST server-set `reviewer_id` / actor columns from it; the client can never
 * supply it. For the §4.3 audit-log pattern, `auditActorType()` maps the
 * verified role onto the `audit_log.actor_type` value, and every
 * state-changing write emits an `auditInsert()` (`lib/audit.ts`) inside its
 * atomic `db.batch()` (ADR 0016 / AECI-249).
 *
 * The guarded endpoints themselves land in Phase 5.6 / 5.11 / 5.13.
 */

import { ApiErrorCode } from '@aeci/shared';
import type { AuditLogActorType } from '@aeci/shared/audit-log';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { JWTVerifyGetKey } from 'jose';

import { getDb } from '../db/client';
import { profiles } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import type { DbFactory } from './handler-utils';
import { extractBearer, unauthenticated, verifySupabaseJwt } from './user-auth';

/** The verified session a guarded handler receives via `c.get('auth')`. */
export type AuthenticatedSession = {
  /** Verified token `sub` — the `auth.users` / `profiles` UUID. Server-set
   *  source for `reviewer_id` and audit `actorId`; never client-supplied. */
  userId: string;
  email?: string;
  /** `profiles.role`, re-fetched from the DB this request. */
  role: string;
};

/** Hono `Variables` contributed by `requireAuth()` / `requireAdmin()`. */
export type AuthzVariables = {
  auth: AuthenticatedSession;
};

export type AuthzOptions = {
  /** Test seam: local key resolver (jose `createLocalJWKSet`) so unit tests
   *  verify offline. Production callers omit it → remote JWKS. */
  getKey?: JWTVerifyGetKey;
  /** Test seam: Drizzle/D1 client factory. Production callers omit it → the
   *  per-request `getDb` client over `env.DB` (ADR 0016 / AECI-254). */
  dbFor?: DbFactory;
  /**
   * Error code for the banned rejection. Review-write endpoints pass
   * `REVIEW_BANNED` (Phase 5 spec §4.5 / API_CONTRACTS.md §4); everything
   * else defaults to `FORBIDDEN`. The status is 403 either way.
   */
  bannedCode?: typeof ApiErrorCode.FORBIDDEN | typeof ApiErrorCode.REVIEW_BANNED;
};

const SESSION_COOKIE_RE = /^(sb-.+-auth-token)(?:\.(\d+))?$/;

/** Decode a base64url (or base64) string to UTF-8 text; null on bad input. */
function base64UrlDecode(value: string): string | null {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Pull `access_token` out of a reassembled `@supabase/ssr` cookie value. */
function accessTokenFromCookieValue(value: string): string | null {
  const json = value.startsWith('base64-') ? base64UrlDecode(value.slice('base64-'.length)) : value;
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    const token = (parsed as Record<string, unknown>)?.['access_token'];
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Extract the Supabase access token from `@supabase/ssr` session cookies:
 * `sb-<ref>-auth-token` either whole or chunked (`.0`, `.1`, …) with a
 * `base64-`-prefixed base64url JSON value containing `access_token`. Returns
 * null when absent or unparseable — the caller 401s; nothing here is trusted
 * before JWKS verification.
 */
export function extractSessionCookieToken(cookies: Record<string, string>): string | null {
  const whole = new Map<string, string>();
  const chunks = new Map<string, Map<number, string>>();
  for (const [name, value] of Object.entries(cookies)) {
    const match = SESSION_COOKIE_RE.exec(name);
    if (!match) continue;
    const [, base, index] = match;
    if (base === undefined) continue;
    if (index === undefined) {
      whole.set(base, value);
    } else {
      const byIndex = chunks.get(base) ?? new Map<number, string>();
      byIndex.set(Number(index), value);
      chunks.set(base, byIndex);
    }
  }

  for (const [base, byIndex] of chunks) {
    const joined = [...byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v)
      .join('');
    const token = accessTokenFromCookieValue(joined);
    if (token) return token;
    whole.delete(base); // chunked form supersedes a stale whole cookie
  }
  for (const value of whole.values()) {
    const token = accessTokenFromCookieValue(value);
    if (token) return token;
  }
  return null;
}

/** Map the verified role onto the `audit_log.actor_type` value (§4.3). */
export function auditActorType(session: Pick<AuthenticatedSession, 'role'>): AuditLogActorType {
  return session.role === 'admin' ? 'admin' : 'user';
}

function createAuthzMiddleware(
  requiredRole: 'admin' | null,
  options: AuthzOptions,
): MiddlewareHandler<{ Bindings: Env; Variables: AuthzVariables }> {
  return async (c, next) => {
    const supabaseUrl = c.env.SUPABASE_URL;
    // Bearer wins; a present-but-invalid bearer token fails verification (no
    // silent fallback to the cookie — fail closed, no oracle).
    const token =
      extractBearer(c.req.header('Authorization')) ?? extractSessionCookieToken(getCookie(c));
    if (!supabaseUrl || !token) throw unauthenticated();

    const user = await verifySupabaseJwt(token, supabaseUrl, options.getKey);

    // Re-fetch role + ban state on every request (§4.5 — never trust client
    // claims). The D1 binding is privileged (no RLS), so this read is the
    // authorization source of truth. Only reached AFTER the JWT verifies.
    const { db } = (options.dbFor ?? getDb)(c.env);
    const profile = await db.query.profiles.findFirst({
      columns: { role: true, bannedAt: true, banReason: true },
      where: eq(profiles.id, user.userId),
    });
    // A verified token with no profiles row is an identity we can't authorize
    // (sync trigger lag or a deleted account) — 401, not anonymous treatment.
    if (!profile) throw unauthenticated();
    if (profile.bannedAt) {
      throw new ApiError(
        403,
        options.bannedCode ?? ApiErrorCode.FORBIDDEN,
        profile.banReason ?? 'Account suspended',
      );
    }
    if (requiredRole === 'admin' && profile.role !== 'admin') {
      throw new ApiError(403, ApiErrorCode.FORBIDDEN, 'Admin role required');
    }

    c.set('auth', { userId: user.userId, email: user.email, role: profile.role });

    await next();
  };
}

/**
 * Guard for authenticated user endpoints (e.g. `POST /api/reviews`,
 * `DELETE /api/account`): valid JWT, profile exists, not banned. Pass
 * `bannedCode: ApiErrorCode.REVIEW_BANNED` on review writes.
 */
export function requireAuth(
  options: AuthzOptions = {},
): MiddlewareHandler<{ Bindings: Env; Variables: AuthzVariables }> {
  return createAuthzMiddleware(null, options);
}

/**
 * Guard for admin endpoints (`/api/admin/*`): everything `requireAuth()`
 * checks, plus `profiles.role = 'admin'` — enforced before the handler (and
 * therefore before any D1 write).
 */
export function requireAdmin(
  options: AuthzOptions = {},
): MiddlewareHandler<{ Bindings: Env; Variables: AuthzVariables }> {
  return createAuthzMiddleware('admin', options);
}
