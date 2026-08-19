/**
 * "Was this request made by the operator?" — the ingest-time half of the
 * internal-traffic exclusion (`ADMIN_PANEL_SPEC.md` §13 **D13**).
 *
 * ─── Why this exists next to two filters that already sound like it ──────────
 *
 * Three mechanisms now carry the word "internal", and they are not
 * interchangeable:
 *
 *   1. **`UNTRACKED_ROUTE_PREFIXES`** (§9.6 / D12) — `/admin/*` and `/account`
 *      are internal *by construction*. Zero false positives, but it only sees
 *      the operator while they are standing on an operator-only page.
 *   2. **`ANALYTICS_INTERNAL_ASNS`** (§13 D10, `lib/internal-asns.ts`) — a
 *      read-time `WHERE` on the network. Coarse by design, and shipped unset.
 *   3. **This module** — the operator browsing the PUBLIC site while signed in
 *      as an admin, which is what "checking my own work" actually looks like and
 *      which neither of the other two catches.
 *
 * The gap is not theoretical. Measured against production on 2026-08-19: 368 of
 * 2,493 human public-page views (**15%**) came from the operator's own browser,
 * spread over AS23089/US (Jun 23 → Jul 30), AS23314/US, and AS23700/ID (Aug 3 →
 * Aug 18) as their network changed. An ASN list pinned to the current network
 * would have missed 183 of those and excluded 112 rows that were NOT the
 * operator — wrong in both directions at once. Session identity is the only
 * signal that survives the operator changing ISP, country, or device.
 *
 * ─── Three properties this must keep ────────────────────────────────────────
 *
 * **Server-derived, never claimed.** The verdict comes from the same two checks
 * `lib/authz.ts` runs — JWKS signature verification, then a fresh `profiles.role`
 * read from D1. A caller cannot assert it, so nobody can hide their traffic from
 * the operator's own analytics by setting a header.
 *
 * **Free for anonymous traffic.** No token on the request → `false` before any
 * crypto or D1 work. The overwhelming majority of `page_views` writes are
 * anonymous, and this is the hottest write path in the app; it must not grow a
 * per-view auth round trip for visitors who have no session at all.
 *
 * **Never throws, never blocks.** Every failure — malformed token, expired,
 * JWKS fetch down, missing profile — resolves to `false`. This runs inside the
 * fire-and-forget `waitUntil` capture; an auth hiccup must cost a correct
 * `is_operator` flag, never the page-view row and never the visitor's 204.
 * Failing to `false` also fails in the safe direction: a view stays counted
 * rather than silently vanishing from the numbers.
 */

import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { JWTVerifyGetKey } from 'jose';

import type { Db } from '../db/client';
import { profiles } from '../db/schema';
import type { Env } from '../env';
import { extractSessionCookieToken } from './authz';
import { extractBearer, verifySupabaseJwt } from './user-auth';

export type OperatorSessionOptions = {
  /** Test seam: local key resolver (jose `createLocalJWKSet`) so specs verify
   *  offline, mirroring `AuthzOptions.getKey`. Production callers omit it. */
  getKey?: JWTVerifyGetKey;
};

/**
 * Whether `request` carries a verified `profiles.role = 'admin'` session.
 *
 * Token sources mirror `lib/authz.ts` exactly — `Authorization: Bearer` first
 * (the service-binding form), then the `sb-<ref>-auth-token` session cookie the
 * `/api/*` passthrough forwards untouched — so "signed in" means the same thing
 * on this path as it does on every guarded endpoint. Bearer wins, with no
 * fallback to the cookie when it is present but invalid.
 *
 * @param c the Hono context (for the raw request's cookies + `env`)
 * @param db a client on the SAME request-scoped D1 connection the caller is
 *   already using, so the role read joins that session rather than opening a
 *   second one
 */
export async function isOperatorRequest(
  c: Context<{ Bindings: Env }>,
  db: Db,
  options: OperatorSessionOptions = {},
): Promise<boolean> {
  const supabaseUrl = c.env.SUPABASE_URL;
  if (!supabaseUrl) return false;

  // The fast path: no credentials at all. Returns before touching WebCrypto or
  // D1, which is what keeps this affordable on anonymous traffic.
  const token =
    extractBearer(c.req.header('Authorization')) ?? extractSessionCookieToken(getCookie(c));
  if (!token) return false;

  try {
    const { userId } = await verifySupabaseJwt(token, supabaseUrl, options.getKey);
    const profile = await db.query.profiles.findFirst({
      columns: { role: true },
      where: eq(profiles.id, userId),
    });
    return profile?.role === 'admin';
  } catch {
    // Signature / expiry / issuer / JWKS-fetch failures and D1 errors alike.
    // An unverifiable session is not an operator session.
    return false;
  }
}
