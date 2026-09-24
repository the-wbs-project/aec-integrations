import { computed, type Signal } from '@angular/core';

import type { Capability } from '@aeci/shared/entitlements';

import type { VendorPortalStore } from './vendor-portal-store';

/**
 * The §8 entitlement gate for a routed portal section
 * (`docs/STAGE_2_PAID_TIERS_SPEC.md` §8 / AECI-614).
 *
 * Reads the RESOLVED capability list off `GET /api/vendor/me` — never
 * `vendors.verified` (a mirror of the entitlement row, §2.1) and never a
 * browser-side re-derivation of the tier ladder. The API ships `capabilities`
 * precisely so a form's enabled state and the 403 its write would get cannot
 * disagree, and so an unrecognised tier fails **closed** here exactly as it does
 * server-side; a client that re-implemented the ladder would fail OPEN on the one
 * tier it did not know about.
 *
 * Returns a `computed`, not a boolean, because the entitlement flip has to land
 * without a reload (AECI-631 / `STAGE_2_REALTIME_SPEC.md` §6.1): the poll
 * refetches `me`, the store's signal moves, and every gate derived through this
 * helper re-derives in place. Anything that latched the value at construction
 * would silently revert that.
 *
 * `me` is `null` only before the surface owner has seeded the store, which the
 * sections render through anyway — `false` is the right answer in that window.
 */
export function vendorCan(store: VendorPortalStore, capability: Capability): Signal<boolean> {
  return computed(() => store.me()?.entitlement.capabilities.includes(capability) ?? false);
}

/**
 * Does the vendor hold an active entitlement? The client half of the AECI-1089 gate
 * on owner writes to connector-powered integrations (AECI-1040 ruling 2,
 * `apps/api/src/lib/integration-entitlement.ts`).
 *
 * Not a capability: there is no `integration.edit`, and the server compares no tier.
 * It reads the RESOLVED tier off `GET /api/vendor/me`, which the server builds from the
 * same session field the gate reads, so the affordance and the 403 cannot disagree.
 * `'unclaimed'` is what the server resolves for no row, a non-active row, or a tier
 * it does not know, so this fails closed exactly where the server does. A `computed`
 * for the reason {@link vendorCan} is one: the entitlement flip lands without a reload.
 */
export function vendorHasActiveEntitlement(store: VendorPortalStore): Signal<boolean> {
  return computed(() => {
    const tier = store.me()?.entitlement.tier;
    return tier !== undefined && tier !== 'unclaimed';
  });
}
