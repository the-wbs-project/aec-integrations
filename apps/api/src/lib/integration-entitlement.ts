/**
 * The entitlement gate on owner writes to connector-powered integrations
 * (AECI-1089 / AECI-1040 ruling 2 / `STAGE_2_SPEC.md` §8.10(8) /
 * `STAGE_2_PAID_TIERS_SPEC.md` §3.1 / ADR 0035 decision 15).
 *
 * **The first entitlement check on an integration ownership route, and a named exception to
 * decision 15.** Every other integration route keeps the seat as its whole gate. This
 * one applies only where the carve-out applies: an owner's claim, edit, retire and
 * restore of a connector-powered row (either table), and an owner's decision on a
 * contest over one. It closes the §8.10(6) free-seat hole at write time: a §8.9
 * catalogue-maintenance seat holds no live license, so it fails here.
 *
 * Three rules a caller must keep:
 *
 *  1. **Not a capability.** There is no `integration.edit` capability, and no tier is
 *     compared. The test is "the session resolved to a paid tier", which the vendor
 *     guard returns exactly when the vendor holds at least one LIVE license on any
 *     billing account (AECI-1355; fail-closed: no license, or only ended ones,
 *     resolve to `'unclaimed'`). It is VENDOR-level on purpose: an integration is
 *     not one product's, so no single product's license decides. DB-free: it reads
 *     the `entitlementTier` the vendor guard already loaded (§4.1), so it costs no
 *     round trip.
 *  2. **Only after ownership settles, and only on a connector-powered row.** Call it
 *     after the handler has answered `404` / `INTEGRATION_NOT_OWNER` /
 *     `INTEGRATION_OWNER_UNKNOWN`, so a non-owner never learns anything from a 403,
 *     and only once the row is known to be connector-powered, so an ordinary row keeps
 *     the seat as its whole gate.
 *  3. **Its own code.** `403 INTEGRATION_ENTITLEMENT_REQUIRED`, not
 *     `ENTITLEMENT_REQUIRED`: that code promises `details.capability`, and this gate
 *     has none. `details.status` tells the portal "never bought" (`null`) from
 *     "lapsed" (`expired`, `revoked`, `pending`). 403, not 402 (`API_CONTRACTS.md`
 *     §4.1 has no 402 row). The copy points at activation, never at ranking.
 *     Since AECI-1355 `details.status` is derived from licenses: `null` for a vendor
 *     that never held one, `expired` / `revoked` once every license has ended.
 */

import { ApiErrorCode } from '@aeci/shared';
import type { EntitlementStatus, EntitlementTier } from '@aeci/shared/entitlements';

import { ApiError } from '../errors';
import type { AuthenticatedSession, AuthzContext } from './authz';

/** The session fields the gate reads. Structural, so a test or a non-Hono caller can
 *  pass a plain object. */
export type EntitlementSession = Pick<AuthenticatedSession, 'entitlementTier' | 'entitlement'>;

/**
 * Does this session hold an active entitlement? The one definition the carve-out
 * routes share. `true` exactly when the vendor guard resolved a paid tier, which it
 * does only when the vendor holds a live license (AECI-1355).
 */
export function hasActiveEntitlement(session: EntitlementSession): boolean {
  return session.entitlementTier !== 'unclaimed';
}

/** The one `INTEGRATION_ENTITLEMENT_REQUIRED` constructor, so the status, the copy
 *  and the `details` shape cannot drift between the routes that raise it. */
export function integrationEntitlementRequired(session: EntitlementSession): ApiError {
  const details: { tier: EntitlementTier; status: EntitlementStatus | null } = {
    tier: session.entitlementTier,
    status: session.entitlement?.status ?? null,
  };
  return new ApiError(
    403,
    ApiErrorCode.INTEGRATION_ENTITLEMENT_REQUIRED,
    'Managing an integration delivered through a connector product needs an active plan. Contact AEC Integrations to activate or renew it.',
    { details },
  );
}

/**
 * Throw `403 INTEGRATION_ENTITLEMENT_REQUIRED` unless the caller's vendor holds an
 * active entitlement. Call it in the handler after ownership settles and after the
 * row is known to be connector-powered (rule 2 above).
 */
export function requireActiveEntitlement(c: AuthzContext): void {
  const session = c.get('auth');
  if (hasActiveEntitlement(session)) return;
  throw integrationEntitlementRequired(session);
}
