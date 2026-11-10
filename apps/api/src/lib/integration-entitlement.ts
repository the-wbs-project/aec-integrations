/**
 * The active-entitlement test behind the Managed-only re-crawl (AECI-1186): whether a
 * vendor-sourced write may buffer search-engine re-crawl URLs
 * (`vendorRecrawlEnabled` and `bufferVendorRecrawl` in `routes/vendor-shared.ts`).
 *
 * Until AECI-1663 this module was also the entitlement gate on owner writes to
 * connector-powered integrations (AECI-1089 / AECI-1040 ruling 2), and raised
 * `403 INTEGRATION_ENTITLEMENT_REQUIRED`. Ruling 14 (2026-11-09) retired that gate:
 * a seat is the whole gate on every integration row (ADR 0035 decision 15), so the
 * code and its constructor are gone. Only the test is left.
 *
 * Not a capability, and no tier is compared. The test is "the session resolved to a
 * paid tier", which the vendor guard returns exactly when the vendor holds at least
 * one LIVE license on any billing account (AECI-1355; fail-closed: no license, or
 * only ended ones, resolve to `'unclaimed'`). DB-free: it reads the `entitlementTier`
 * the vendor guard already loaded (§4.1), so it costs no round trip.
 */

import type { AuthenticatedSession } from './authz';

/** The session fields the test reads. Structural, so a test or a non-Hono caller can
 *  pass a plain object. */
export type EntitlementSession = Pick<AuthenticatedSession, 'entitlementTier' | 'entitlement'>;

/**
 * Does this session hold an active entitlement? `true` exactly when the vendor guard
 * resolved a paid tier, which it does only when the vendor holds a live license
 * (AECI-1355).
 */
export function hasActiveEntitlement(session: EntitlementSession): boolean {
  return session.entitlementTier !== 'unclaimed';
}
