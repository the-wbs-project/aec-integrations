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
 *      Missing profile → 401, unless the guard opted into the AECI-770
 *      `onMissingProfile` self-heal (only `GET /api/account` does); banned → `403` (`REVIEW_BANNED` on review writes
 *      via `bannedCode`, else `FORBIDDEN`); wrong role for the route → `403
 *      FORBIDDEN`.
 *
 * AECI-611 adds a FOURTH thing to the session, on the `requireVendor()` branch
 * only: the caller's plan (`STAGE_2_PAID_TIERS_SPEC.md` §4). Since AECI-1355 (E1.6)
 * the plan is read from `licenses`, not `vendor_entitlements`: that branch's
 * profile re-fetch becomes a two-statement `db.batch` (the profile and the vendor's
 * own licenses), so the plan arrives in the SAME round-trip the guard was
 * already paying for, and `requireCapability()` / `requireProductCapability()`
 * below are pure in-memory assertions. The ban check still runs FIRST — a banned
 * seat is rejected before any plan question is asked (AECI-524).
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
  hasCapability,
  type Capability,
  type EntitlementStatus,
  type EntitlementTier,
} from '@aeci/shared/entitlements';
// NOT via `../posthog` (the Worker's telemetry call-site surface): this is
// identity registration, not emission, and a dozen route specs `vi.mock` that
// surface to silence telemetry. Behind the mock, registration would silently
// stop happening — the exact silent under-coverage AECI-644 exists to avoid.
import { rememberPosthogDistinctId } from '@aeci/shared/posthog';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { JWTVerifyGetKey } from 'jose';

import { getDb, type Db } from '../db/client';
import { billingAccounts, licenses, profiles } from '../db/schema';
import type { Env } from '../env';
import { ApiError } from '../errors';
import type { DbFactory } from './handler-utils';
import type { MissingProfileHook } from './profile-provisioning';
import { extractBearer, unauthenticated, verifySupabaseJwt } from './user-auth';

/** The verified session a guarded handler receives via `c.get('auth')`. */
export type AuthenticatedSession = {
  /** Verified token `sub` — the `auth.users` / `profiles` UUID. Server-set
   *  source for `reviewer_id` and audit `actorId`; never client-supplied. */
  userId: string;
  email?: string;
  /** The provider's name for the user (`AuthenticatedUser.fullName`, AECI-1296).
   *  Informational only, never an authorization input. */
  fullName?: string;
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
   * The caller's VENDOR-level tier (AECI-611 / `STAGE_2_PAID_TIERS_SPEC.md` §4).
   *
   * **Always present, never optional.** An optional field invites
   * `session.entitlementTier ?? 'verified'` at a call site, which is the one
   * default that must never exist. Since AECI-1355 it is `'verified'` exactly
   * when the vendor holds at least one LIVE license (`licenses.ended_at IS NULL`)
   * on any of its billing accounts, assigned or not, and `'unclaimed'` for every
   * non-vendor session and every vendor with none.
   *
   * It gates the VENDOR-level writes only: `profile.edit` and the connector-powered
   * carve-out. A write on ONE product, and since the 2026-10-14 ruling every
   * attestation write and search-engine resubmission, gates on that product's own
   * license through {@link productTier}, never on this.
   *
   * Named `entitlementTier` and **not `tier`** (§10 R4): `profiles.trust_tier`
   * is a REVIEWER concept on the neighbouring table whose CHECK vocabulary
   * literally contains the string `'verified'`. A bare `tier` on the session
   * would read as that one at every call site.
   */
  entitlementTier: EntitlementTier;
  /**
   * Vendor-level term detail for the §8 dashboard readout and the §13.11
   * pilot-ended banner, DERIVED from `licenses` (AECI-1355) by
   * {@link sessionPlanFromLicenses}. `null` for non-vendor sessions and for a
   * vendor that has never held a license ("never bought", which the banner must
   * tell apart from "ended").
   *
   *  - any live license → `active`; `periodEnd` is the latest scheduled `ends_at`
   *    among the live licenses, `null` when any is monthly (`ends_at` NULL);
   *  - none live → the most recently ended license decides: `revoked` when its
   *    `end_reason` is `revoked`, else `expired`; `periodEnd` and `endedAt` are its own.
   *
   * Deliberately NOT the authorization input. `entitlementTier` is what
   * `requireCapability` consults; this exists so the dashboard can say
   * "expires 2027-01-01" or "ended on …" rather than only "locked".
   */
  entitlement: {
    status: EntitlementStatus;
    /** The RAW tier (AECI-1193): `verified` whenever the vendor holds or held a
     *  license. Not an authorization input: `entitlementTier` is. It lets a reader
     *  say "verified, expired", which the resolved `entitlementTier` (`unclaimed`
     *  once lapsed) cannot. Optional so a hand-built test session may omit it. */
    tier?: string;
    periodEnd: string | null;
    /** When the plan ended (AECI-1218, the pilot-ended banner's date line): the
     *  latest `licenses.ended_at` once no license is live. `null` while any is live.
     *  Optional so a hand-built test session may omit it; absent reads as `null`. */
    endedAt?: string | null;
  } | null;
  /**
   * The products this vendor holds a LIVE license for (AECI-1355,
   * `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 6): the products assigned to a live
   * license on the vendor's OWN billing accounts. The input of
   * {@link requireProductCapability}: a product is Managed for this vendor exactly
   * when its id is here. Only the payer gets Managed rights (ruled 2026-10-14): a
   * co-owned product licensed on the OTHER owner's account is not listed, so this
   * vendor stays Free on it. Empty for non-vendor sessions.
   *
   * Optional ONLY so the hand-built sessions in route specs still compile. Every
   * reader goes through {@link productTier}, which reads absence as "no product
   * licensed": the fail-closed direction, never a default that grants.
   */
  licensedProductIds?: readonly string[];
  /**
   * The vendor's OWN licenses as the guard read them (AECI-1355), on its own
   * billing accounts only: every LIVE license, assigned or not, plus the most
   * recently ENDED license per (billing account, assigned product), which is what
   * the pilot-ended banner and a product's "ended on" date need. Older ended licenses are history and are not read.
   * Feeds the per-product `plan` blocks and the audit plan snapshot
   * (`licensePlanSnapshot`). Empty for non-vendor sessions. Optional for the same
   * reason as `licensedProductIds`; absent reads as `[]`.
   */
  licenses?: readonly SessionLicense[];
};

/**
 * One license as the session carries it (AECI-1355). Snake case, as the issue's
 * contract names it, because it mirrors the stored columns one to one.
 * `end_reason` rides along so an ended plan reads `revoked` or `expired` without
 * a second read.
 */
export type SessionLicense = {
  product_id: string | null;
  source: string;
  ends_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
};

/** Non-vendor sessions (`requireAuth()` / `requireAdmin()`) carry the
 *  fail-closed floor: `/api/vendor/*` is the only entitlement-gated surface, and
 *  a reviewer or admin session must never resolve to a paid tier. The two license
 *  fields are left absent rather than `[]`, so those two guards set exactly the
 *  session they set before AECI-1355; absence reads as "no license" everywhere. */
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
  /**
   * Opt-in self-heal for a verified token with no `profiles` row (AECI-770). When
   * set, the guard calls it once and re-reads the profile; a row that is still
   * missing 401s as before. Absent (the default for every guard but
   * `GET /api/account`), a missing profile 401s immediately — the strict stance
   * writes and the admin/vendor surfaces keep. The hook may throw an `ApiError`
   * (the account self-heal throws 503 `PROFILE_UNAVAILABLE`).
   */
  onMissingProfile?: MissingProfileHook;
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

/** …plus the vendor's licenses, on the vendor branch only (AECI-1355). */
type VendorProfileAuthz = ProfileAuthz & {
  licenseRows: readonly SessionLicense[];
};

/**
 * The most recently ended license per (billing account, assigned product), as a
 * correlated predicate. `IS`, not `=`, so the unassigned licenses of an account
 * form one group too (`NULL IS NULL` is true in SQLite). `ended_at` is compared
 * as text, which is sound because every writer stores the one full ISO spelling
 * (`toIsoTimestamp` in `lib/license.ts`).
 */
const isLatestEndedInGroup = sql`${licenses.endedAt} = (
  SELECT max("prior"."ended_at") FROM "licenses" "prior"
  WHERE "prior"."billing_account_id" = ${licenses.billingAccountId}
    AND "prior"."assigned_product_id" IS ${licenses.assignedProductId})`;

/**
 * The `vendor_admin` read: the same four authorization columns, plus the vendor's
 * licenses, in ONE round-trip (§4.1, AECI-1355).
 *
 * Two statements in one `db.batch`. The license statement cannot take the
 * vendor id from the first statement's result, so it scopes by a subquery on
 * `profiles.vendor_id` for the same user instead of a second round trip. A
 * half-granted seat (`vendor_id` NULL) matches nothing, because SQL NULL never
 * equals anything, so it reads no licenses rather than another vendor's. The
 * guard then rejects that seat anyway.
 *
 * Statement 2, the vendor's OWN licenses: every LIVE license (`ended_at IS NULL`)
 * on every billing account of the vendor, assigned or not, plus the most recently
 * ENDED license per (account, assigned product). The live set decides the
 * vendor-level tier. The latest ended rows give the pilot-ended banner its date
 * and each product its "ended on" readout, and they include the vendor's single
 * latest ended license, which is all `licensePlanSnapshot` needs once nothing is
 * live. Older ended licenses are history and stay unread, so the read stays
 * bounded by products plus live licenses as ended rows accumulate.
 *
 * The live rows also decide which products are Managed for this vendor. Only the
 * payer gets Managed rights (`docs/VENDOR_SIGNUP_PROCESS.md` §2, ruled
 * 2026-10-14): a CO-OWNED product whose one live license sits on the OTHER
 * owner's account stays Free for this vendor. So nothing here reads another
 * vendor's licenses, not even a product id.
 */
async function findVendorProfile(db: Db, userId: string): Promise<VendorProfileAuthz | undefined> {
  const sessionVendor = sql`(SELECT ${profiles.vendorId} FROM ${profiles} WHERE ${profiles.id} = ${userId})`;
  const [profileRows, licenseRows] = await db.batch([
    db
      .select({
        role: profiles.role,
        vendorId: profiles.vendorId,
        bannedAt: profiles.bannedAt,
        banReason: profiles.banReason,
      })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1),
    db
      .select({
        product_id: licenses.assignedProductId,
        source: licenses.source,
        ends_at: licenses.endsAt,
        ended_at: licenses.endedAt,
        end_reason: licenses.endReason,
      })
      .from(licenses)
      .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
      .where(
        and(
          eq(billingAccounts.vendorId, sessionVendor),
          or(isNull(licenses.endedAt), isLatestEndedInGroup),
        ),
      ),
  ]);
  const profile = profileRows[0];
  return profile ? { ...profile, licenseRows } : undefined;
}

/** The latest of a set of ended licenses by parsed `ended_at`. An unparseable stamp
 *  sorts first, so a readable one always wins (`licensePlanSnapshot`'s rule). */
function latestEnded(ended: readonly SessionLicense[]): SessionLicense | undefined {
  let latest: SessionLicense | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const license of ended) {
    const ms = Date.parse(license.ended_at ?? '');
    const key = Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
    if (latest === undefined || key > latestMs) {
      latest = license;
      latestMs = key;
    }
  }
  return latest;
}

/** The status an ENDED license reads as: `revoked` when it was pulled for cause,
 *  else `expired` (a lapse or a release). The same split as `licensePlanSnapshot`. */
function endedStatus(license: SessionLicense): EntitlementStatus {
  return license.end_reason === 'revoked' ? 'revoked' : 'expired';
}

/** The term a set of live licenses runs to: the latest `ends_at`, or `null` when any
 *  is monthly (no scheduled end). */
function liveTermEnd(live: readonly SessionLicense[]): string | null {
  let end: string | null = null;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const license of live) {
    if (license.ends_at === null) return null;
    const ms = Date.parse(license.ends_at);
    if (end === null || ms > endMs) {
      end = license.ends_at;
      endMs = ms;
    }
  }
  return end;
}

/** The raw tier a license-backed plan reports (`licensePlanSnapshot` uses the same
 *  word): licenses carry no tier, and every live license grants the one paid rung. */
const LICENSE_TIER: EntitlementTier = 'verified';

/**
 * Resolve the licenses the guard read to the session's plan fields (AECI-1355).
 *
 * `rows` are the vendor's OWN licenses. They decide the vendor-level tier and
 * term, and their live assignments are `licensedProductIds`: only the payer gets
 * Managed rights on a product (ruled 2026-10-14).
 *
 * Stored state only: a license is live while `ended_at` is NULL, whatever its
 * `ends_at` says. E6's daily job turns a passed `ends_at` into `ended_at`; until it
 * runs, the plan stays on. That is the same rule `vendor_entitlements` had (nothing
 * auto-lapsed a row), and the audit snapshot's clock check stays a RECORD rule.
 *
 * Exported for `authz.spec.ts`: the derivation is pure, so its cases are pinned
 * without a database.
 */
export function sessionPlanFromLicenses(
  rows: readonly SessionLicense[],
): Pick<
  AuthenticatedSession,
  'entitlementTier' | 'entitlement' | 'licensedProductIds' | 'licenses'
> {
  const live = rows.filter((license) => license.ended_at === null);
  const licensedProductIds = [
    ...new Set(live.flatMap((license) => (license.product_id ? [license.product_id] : []))),
  ];
  if (live.length > 0) {
    return {
      entitlementTier: LICENSE_TIER,
      entitlement: {
        status: 'active',
        tier: LICENSE_TIER,
        periodEnd: liveTermEnd(live),
        endedAt: null,
      },
      licensedProductIds,
      licenses: rows,
    };
  }
  const latest = latestEnded(rows);
  return {
    entitlementTier: 'unclaimed',
    entitlement: latest
      ? {
          status: endedStatus(latest),
          tier: LICENSE_TIER,
          periodEnd: latest.ends_at,
          endedAt: latest.ended_at,
        }
      : null,
    licensedProductIds,
    licenses: rows,
  };
}

/**
 * ONE product's plan, from the session's licenses (AECI-1355,
 * `STAGE_2_PAID_TIERS_SPEC.md` §13.7). The source of each `VendorProduct.plan`:
 *
 *  - a live license on the product → `verified`, `active`, its `ends_at`;
 *  - else the product's most recently ended license → `unclaimed`, `expired` or
 *    `revoked`, its `ends_at` and `ended_at`;
 *  - else → `unclaimed` with no term: the product was never on Managed.
 *
 * The tier is {@link productTier}'s, so the plan a product screen renders and the
 * 403 its write would get read the same session field.
 */
export function productPlan(
  session: Pick<AuthenticatedSession, 'licensedProductIds' | 'licenses'>,
  productId: string,
): Pick<AuthenticatedSession, 'entitlementTier' | 'entitlement'> {
  const own = (session.licenses ?? []).filter((license) => license.product_id === productId);
  const live = own.filter((license) => license.ended_at === null);
  // Keyed on `productTier`, not on `live` alone, so the block and the gate cannot
  // disagree even for a session whose `licenses` list is narrower than its ids.
  if (productTier(session, productId) === LICENSE_TIER) {
    return {
      entitlementTier: LICENSE_TIER,
      entitlement: {
        status: 'active',
        tier: LICENSE_TIER,
        periodEnd: liveTermEnd(live),
        endedAt: null,
      },
    };
  }
  const latest = latestEnded(own.filter((license) => license.ended_at !== null));
  return {
    entitlementTier: 'unclaimed',
    entitlement: latest
      ? {
          status: endedStatus(latest),
          tier: LICENSE_TIER,
          periodEnd: latest.ends_at,
          endedAt: latest.ended_at,
        }
      : null,
  };
}

/**
 * The tier ONE product holds: `verified` exactly when the session lists it in
 * `licensedProductIds`, else `unclaimed`. Absent `licensedProductIds` reads as
 * empty, so a session that never loaded licenses grants nothing per product.
 */
export function productTier(
  session: Pick<AuthenticatedSession, 'licensedProductIds'>,
  productId: string,
): EntitlementTier {
  return (session.licensedProductIds ?? []).includes(productId) ? LICENSE_TIER : 'unclaimed';
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

    // The person is now cryptographically established, so every log this
    // request emits can carry `posthogDistinctId` (AECI-644 / §AW3). Registered
    // HERE — before the profile read — deliberately: a ban 403 or a
    // missing-profile 401 is exactly the log an operator wants pivoted to the
    // person, and the `sub` is no less verified for having failed authorization.
    // Authorization outcome and identity are different questions.
    rememberPosthogDistinctId(c.req.raw, user.userId);

    // Re-fetch role + ban state on every request (§4.5 — never trust client
    // claims). The D1 binding is privileged (no RLS), so this read is the
    // authorization source of truth. Only reached AFTER the JWT verifies.
    //
    // The vendor branch takes the profile + licenses batch instead (AECI-611 §4.1,
    // AECI-1355); the other two keep the EXACT `findFirst` they have always run.
    // That asymmetry is deliberate, not an optimization left half-done: an admin
    // session has `vendor_id = null`, so an unconditional license read would match
    // nothing on every `/api/admin/*` request, and `requireAuth()` fronts the
    // review-submit hot path (`POST /api/reviews`, `DELETE /api/account`) where
    // there is no plan question to ask. Branching keeps both byte-identical:
    // zero added latency, zero regression surface. Do not "simplify" this to
    // always read licenses.
    const { db } = (options.dbFor ?? getDb)(c.env);
    const readProfile = (): Promise<ProfileAuthz | undefined> =>
      requiredRole === 'vendor_admin'
        ? findVendorProfile(db, user.userId)
        : db.query.profiles.findFirst({
            columns: { role: true, vendorId: true, bannedAt: true, banReason: true },
            where: eq(profiles.id, user.userId),
          });
    let profile = await readProfile();
    // A verified token with no profiles row is an identity we can't authorize (a
    // failed first-sign-in ensure, or an erased account) — 401, not anonymous
    // treatment. Only a guard that opted into the AECI-770 self-heal gets one
    // provisioning attempt first; every other guard stays strict.
    if (!profile && options.onMissingProfile) {
      await options.onMissingProfile(c, db, user.userId);
      profile = await readProfile();
    }
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
      ...(user.fullName ? { fullName: user.fullName } : {}),
      role: profile.role,
      vendorId: profile.vendorId,
      // Only the vendor branch read licenses, so only it can resolve to anything
      // but the fail-closed floor.
      ...(requiredRole === 'vendor_admin'
        ? sessionPlanFromLicenses((profile as VendorProfileAuthz).licenseRows)
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
 * The VENDOR-level entitlement gate (AECI-611 / `STAGE_2_PAID_TIERS_SPEC.md` §3.3a,
 * §4.2).
 *
 * A **DB-free** assertion over `c.get('auth').entitlementTier`, which
 * `createAuthzMiddleware` already loaded on the vendor branch — no seam, no
 * mock, no round-trip. Call it in a WRITE handler immediately after
 * `sessionVendorId(c)`, i.e. after the caller's vendor is known and (for an
 * integration-grain write) after ownership has settled, so a non-owner still gets
 * the flat 404 that does not confirm the row exists.
 *
 * For a write on ONE product use {@link requireProductCapability} instead
 * (AECI-1355): that product's own license decides, not the vendor's.
 *
 * **Reads are never gated** (§4.3 / R13). `GET /api/vendor/me` and
 * `GET /api/vendor/seats` must not call this: `/vendor` is gated by
 * `vendorMeResolver`, which maps 403/404 onto a 404 render (a 401 goes to
 * `/auth/login` instead — AECI-954), so gating `me`
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

/**
 * The PRODUCT-level entitlement gate (AECI-1355, `docs/VENDOR_SIGNUP_PROCESS.md` §3
 * step 6). The product is Managed exactly when it holds a live license, so a vendor
 * with two products and one license may write Managed fields on one and gets
 * `403 ENTITLEMENT_REQUIRED` on the other.
 *
 * DB-free, like {@link requireCapability}: it reads `licensedProductIds`, which the
 * vendor guard loaded, and `TIER_CAPABILITIES`. Call it AFTER `requireOwnedProduct`
 * (404-never-403, §3.3a): this gate answers for any product id, owned or not, so it
 * must never be the first thing a foreign id meets. The 403 has the same status,
 * copy and `details` shape as the vendor-level gate; `details.tier` is the
 * PRODUCT's tier.
 */
export function requireProductCapability(
  c: AuthzContext,
  productId: string,
  capability: Capability,
): void {
  const tier = productTier(c.get('auth'), productId);
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
