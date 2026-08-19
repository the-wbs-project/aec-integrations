/**
 * User-session authorization middleware for the API Worker (AECI-196 /
 * Phase 5.5). Implements `AUTH_AND_RLS.md` §4 (Layer 1 — the layer where
 * authorization is actually enforced: the privileged D1 binding has no RLS
 * (ADR 0016 / AECI-254), so this Worker is the real enforcement point).
 *
 * Three guards, all built on the AECI-193 JWT verification
 * (`lib/user-auth.ts`, jose + Supabase JWKS — no DB round-trip to verify):
 *
 *   - `requireAuth()`   — valid JWT + profile exists + not banned.
 *   - `requireAdmin()`  — all of the above + `profiles.role = 'admin'`.
 *   - `requireVendor()` — all of `requireAuth()` + `profiles.role =
 *     'vendor_admin'` + a non-null `profiles.vendor_id` (AECI-520 / Stage 2;
 *     `STAGE_2_VENDOR_PORTAL_SPEC.md` §4).
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
 *   3. Re-fetch `profiles.role` + `vendor_id` + `banned_at` from the DB on
 *      every request (§4.5 — never trust client-side claims about role).
 *      Missing profile → 401; banned → `403` (`REVIEW_BANNED` on review writes
 *      via `bannedCode`, else `FORBIDDEN`); wrong role for the route → `403
 *      FORBIDDEN`.
 *
 * AECI-611 adds a FOURTH thing to the session, on the `requireVendor()` branch
 * only: the caller's entitlement tier (`STAGE_2_PAID_TIERS_SPEC.md` §4). That
 * branch's profile re-fetch becomes a `leftJoin` onto `vendor_entitlements`, so
 * the tier arrives in the SAME round-trip the guard was already paying for, and
 * `requireCapability()` below is a pure in-memory assertion. The ban check still
 * runs FIRST — a banned seat is rejected before any entitlement question is
 * asked (AECI-524).
 *
 * On success the handler gets `c.get('auth')` = `{ userId, email?, role,
 * vendorId }`. `userId` is the verified token `sub` (the `auth.users` UUID) —
 * handlers MUST server-set `reviewer_id` / actor columns from it; the client
 * can never supply it. `vendorId` is likewise server-derived and is the ONLY
 * source a `/api/vendor/*` handler may scope by — the Worker never trusts a
 * client-supplied vendor id (the D1/Drizzle replacement for the RLS row filter,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4). For the §4.3 audit-log pattern,
 * `auditActorType()` maps the verified role onto the `audit_log.actor_type`
 * value, and every state-changing write emits an `auditInsert()`
 * (`lib/audit.ts`) inside its atomic `db.batch()` (ADR 0016 / AECI-249).
 *
 * The guarded endpoints themselves land in Phase 5.6 / 5.11 / 5.13.
 */

import { ApiErrorCode } from '@aeci/shared';
import type { AuditLogActorType } from '@aeci/shared/audit-log';
import {
  ENTITLEMENT_STATUSES,
  hasCapability,
  tierFor,
  type Capability,
  type EntitlementStatus,
  type EntitlementTier,
} from '@aeci/shared/entitlements';
import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { JWTVerifyGetKey } from 'jose';

import { getDb, type Db } from '../db/client';
import { profiles, vendorEntitlements } from '../db/schema';
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
  /**
   * `profiles.vendor_id`, re-fetched from the DB this request (AECI-520).
   * Non-null for every `vendor_admin` that passes `requireVendor()`; null for
   * `reviewer`/`admin` sessions. Handlers scope `/api/vendor/*` reads AND
   * writes by this value — never by anything the client sent.
   */
  vendorId: string | null;
  /**
   * The caller's entitlement tier (AECI-611 / `STAGE_2_PAID_TIERS_SPEC.md` §4).
   *
   * **Always present, never optional.** An optional field invites
   * `session.entitlementTier ?? 'verified'` at a call site, which is the one
   * default that must never exist. `'unclaimed'` for every non-vendor session
   * and for any vendor without an ACTIVE `vendor_entitlements` row — resolved
   * fail-closed by `tierFor` (no row, a `pending`/`expired`/`revoked` status, or
   * a tier this build does not know all land on `'unclaimed'` → zero
   * capabilities → writes 403).
   *
   * Named `entitlementTier` and **not `tier`** (§10 R4): `profiles.trust_tier`
   * is a REVIEWER concept on the neighbouring table whose CHECK vocabulary
   * literally contains the string `'verified'`. A bare `tier` on the session
   * would read as that one at every call site.
   */
  entitlementTier: EntitlementTier;
  /**
   * Term detail for the §8 dashboard readout — `null` for non-vendor sessions,
   * for a vendor with no `vendor_entitlements` row, and for a row whose `status`
   * is outside the §2.2 vocabulary (fail closed: no readable term).
   *
   * Deliberately NOT the authorization input. `entitlementTier` is the only
   * thing `requireCapability` consults; this exists so the dashboard can say
   * "expires 2027-01-01" or "arrangement pending" rather than only "locked".
   */
  entitlement: { status: EntitlementStatus; periodEnd: string | null } | null;
};

/** Non-vendor sessions (`requireAuth()` / `requireAdmin()`) carry the
 *  fail-closed floor: `/api/vendor/*` is the only entitlement-gated surface, and
 *  a reviewer or admin session must never resolve to a paid tier. */
const NO_ENTITLEMENT = {
  entitlementTier: 'unclaimed',
  entitlement: null,
} as const satisfies Pick<AuthenticatedSession, 'entitlementTier' | 'entitlement'>;

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

/**
 * Map the verified role onto the `audit_log.actor_type` value (§4.3).
 *
 * `vendor_admin` deliberately maps to `'user'`: the `audit_log_actor_type_check`
 * CHECK is `('user','admin','system','workflow')` and the Stage 2 vendor-portal
 * epic ships no migration (`STAGE_2_VENDOR_PORTAL_SPEC.md` §1.2). Vendor writes
 * are identified by their `actorId` plus `metadata.source = 'vendor-portal'`,
 * the same way admin moderation and the Linear sync distinguish themselves.
 */
export function auditActorType(session: Pick<AuthenticatedSession, 'role'>): AuditLogActorType {
  return session.role === 'admin' ? 'admin' : 'user';
}

/** The authorization columns every guard variant re-fetches (§4.5). */
type ProfileAuthz = {
  role: string;
  vendorId: string | null;
  bannedAt: string | null;
  banReason: string | null;
};

/** …plus the joined entitlement projection, on the vendor branch only. */
type VendorProfileAuthz = ProfileAuthz & {
  entTier: string | null;
  entStatus: string | null;
  entPeriodEnd: string | null;
};

/**
 * The `vendor_admin` read: the same four authorization columns, plus the
 * caller's entitlement, in ONE round-trip (§4.1).
 *
 * `leftJoin`, not `innerJoin`: a vendor with no entitlement row must still
 * authenticate, still pass `requireVendor()`, and still read its dashboard — it
 * simply resolves to `'unclaimed'` and cannot write (§4.3). The join predicate
 * is on `profiles.vendor_id`, which is NULL for a half-granted seat; SQL NULL
 * never matches, so that row also lands on `'unclaimed'` rather than on some
 * other vendor's entitlement. `vendor_entitlements_vendor_key` is UNIQUE, so
 * this can never fan out to more than one row.
 */
async function findVendorProfile(db: Db, userId: string): Promise<VendorProfileAuthz | undefined> {
  const rows = await db
    .select({
      role: profiles.role,
      vendorId: profiles.vendorId,
      bannedAt: profiles.bannedAt,
      banReason: profiles.banReason,
      entTier: vendorEntitlements.tier,
      entStatus: vendorEntitlements.status,
      entPeriodEnd: vendorEntitlements.periodEnd,
    })
    .from(profiles)
    .leftJoin(vendorEntitlements, eq(vendorEntitlements.vendorId, profiles.vendorId))
    .where(eq(profiles.id, userId))
    .limit(1);
  return rows[0];
}

/**
 * Resolve the joined projection to the session's entitlement fields, fail-closed
 * on every axis.
 *
 * `tierFor` owns the tier decision (no row / non-`active` status / unknown tier
 * → `'unclaimed'`). The term readout is dropped whenever `status` is outside the
 * §2.2 vocabulary, so a value the DB CHECK should have rejected cannot be echoed
 * to the dashboard as if it meant something.
 */
function entitlementFor(
  row: Pick<VendorProfileAuthz, 'entTier' | 'entStatus' | 'entPeriodEnd'>,
): Pick<AuthenticatedSession, 'entitlementTier' | 'entitlement'> {
  if (row.entTier === null || row.entStatus === null) return NO_ENTITLEMENT;
  const status = row.entStatus;
  return {
    entitlementTier: tierFor({ tier: row.entTier, status }),
    // The `null` arm is unreachable while `vendor_entitlements_status_check`
    // holds, and is kept anyway: it is what makes the session type honest
    // instead of a cast, and it is the behaviour we want if that CHECK is ever
    // widened — degrade to "no term on record", never echo an unknown status.
    entitlement: isEntitlementStatus(status) ? { status, periodEnd: row.entPeriodEnd } : null,
  };
}

/** Whether a raw `vendor_entitlements.status` is in the §2.2 vocabulary. The DB
 *  CHECK enforces this; the narrowing exists so the session type is honest
 *  rather than cast, and so a loosened CHECK degrades to "no term" not garbage. */
function isEntitlementStatus(status: string): status is EntitlementStatus {
  return (ENTITLEMENT_STATUSES as readonly string[]).includes(status);
}

function createAuthzMiddleware(
  requiredRole: 'admin' | 'vendor_admin' | null,
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
    //
    // The vendor branch takes the entitlement join instead (AECI-611 §4.1); the
    // other two keep the EXACT `findFirst` they have always run. That asymmetry
    // is deliberate, not an optimization left half-done: an admin session has
    // `vendor_id = null`, so an unconditional join would be a `LEFT JOIN … ON
    // NULL` on every `/api/admin/*` request, and `requireAuth()` fronts the
    // review-submit hot path (`POST /api/reviews`, `DELETE /api/account`) where
    // there is no entitlement question to ask. Branching keeps both byte-
    // identical to before this issue: zero added latency, zero regression
    // surface. Do not "simplify" this to always join.
    const { db } = (options.dbFor ?? getDb)(c.env);
    const profile: ProfileAuthz | undefined =
      requiredRole === 'vendor_admin'
        ? await findVendorProfile(db, user.userId)
        : await db.query.profiles.findFirst({
            columns: { role: true, vendorId: true, bannedAt: true, banReason: true },
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
    if (requiredRole === 'vendor_admin') {
      // A site `admin` is NOT a vendor: there is no impersonation at launch
      // (STAGE_2_VENDOR_PORTAL_SPEC.md §4 / the AECI-520 AC). Admins act on
      // vendor data through `/api/admin/*`, which keeps the audit trail honest
      // about who wrote what.
      if (profile.role !== 'vendor_admin') {
        throw new ApiError(403, ApiErrorCode.FORBIDDEN, 'Vendor admin role required');
      }
      // A `vendor_admin` with no `vendor_id` is a half-granted seat — there is
      // nothing to scope its queries by, so it is not authorized for anything.
      if (!profile.vendorId) {
        throw new ApiError(403, ApiErrorCode.FORBIDDEN, 'Vendor account is not linked to a vendor');
      }
    }

    c.set('auth', {
      userId: user.userId,
      email: user.email,
      role: profile.role,
      vendorId: profile.vendorId,
      // Only the vendor branch ran the join, so only it can resolve to anything
      // but the fail-closed floor.
      ...(requiredRole === 'vendor_admin'
        ? entitlementFor(profile as VendorProfileAuthz)
        : NO_ENTITLEMENT),
    });

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

/**
 * Guard for the vendor portal (`/api/vendor/*`, AECI-520): everything
 * `requireAuth()` checks, plus `profiles.role = 'vendor_admin'` AND a non-null
 * `profiles.vendor_id` — enforced before the handler, and therefore before any
 * D1 write (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4).
 *
 * The ban check runs FIRST (inherited from `createAuthzMiddleware`), which is
 * the §7 / AECI-524 moderation gate: a banned seat fails every `/api/vendor/*`
 * call with a 403 while the vendor itself stays verified and its other seats
 * keep working.
 *
 * Passing the guard only proves *which* vendor the caller is. It does NOT scope
 * any query — handlers must still filter every read and write by
 * `c.get('auth').vendorId`. There is no RLS behind this (ADR 0016); the guard
 * plus that filter IS the enforcement.
 */
export function requireVendor(
  options: AuthzOptions = {},
): MiddlewareHandler<{ Bindings: Env; Variables: AuthzVariables }> {
  return createAuthzMiddleware('vendor_admin', options);
}

/** Any Hono context carrying a session — every guarded handler's `c`. */
export type AuthzContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/**
 * The entitlement gate (AECI-611 / `STAGE_2_PAID_TIERS_SPEC.md` §3.3a, §4.2).
 *
 * A **DB-free** assertion over `c.get('auth').entitlementTier`, which
 * `createAuthzMiddleware` already loaded on the vendor branch — no seam, no
 * mock, no round-trip. Call it in a WRITE handler immediately after
 * `sessionVendorId(c)`, i.e. after the caller's vendor is known and (for a
 * product write) after ownership has settled, so a non-owner still gets the
 * flat 404 that does not confirm the row exists.
 *
 * **Reads are never gated** (§4.3 / R13). `GET /api/vendor/me` and
 * `GET /api/vendor/seats` must not call this: `/vendor` is gated by
 * `vendorMeResolver`, which maps 401/403/404 onto a 404 render, so gating `me`
 * would 404 the entire dashboard for a vendor whose entitlement lapsed — hiding
 * the renewal notice from exactly the cohort being billed.
 *
 * **403, not 402.** 402 Payment Required is semantically tempting and wrong: it
 * leaks a billing model into a wire contract that must stay payer-model-
 * agnostic (§8.1(4)), and `API_CONTRACTS.md` §4.1 has no 402 row. The message
 * points at activation and **never at ranking or placement** — an entitlement
 * buys capability, never position (no pay-for-placement).
 */
export function requireCapability(c: AuthzContext, capability: Capability): void {
  const tier = c.get('auth').entitlementTier;
  if (hasCapability(tier, capability)) return;
  throw entitlementRequired(capability, tier);
}

/** The one `ENTITLEMENT_REQUIRED` constructor, so the status, the copy, and the
 *  `details` shape stay identical across the route-level gate and the
 *  field-level one in `splitPatch` (`routes/vendor.ts`). */
export function entitlementRequired(
  capability: Capability,
  tier: EntitlementTier,
  fields?: readonly string[],
): ApiError {
  return new ApiError(
    403,
    ApiErrorCode.ENTITLEMENT_REQUIRED,
    'This action requires an active Verified plan. Contact AEC Integrations to activate or renew it.',
    { details: fields ? { capability, tier, fields: [...fields] } : { capability, tier } },
  );
}
