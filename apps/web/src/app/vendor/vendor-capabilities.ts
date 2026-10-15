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
 * Does THIS product's plan hold a capability? (AECI-1214, `STAGE_2_PAID_TIERS_SPEC.md`
 * §13.7, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18.)
 *
 * Product screens gate through this and never through `me().entitlement`. Plans
 * live at the product level (decision 2). Since AECI-1355 each product's `plan`
 * comes from its own license on the caller's billing accounts, so a product the
 * vendor did not license reads as Free here even when {@link vendorCan} is true.
 *
 * A plain boolean rather than a `Signal`: the product is already a signal value
 * at every call site, so the caller wraps this in its own `computed` and the
 * live entitlement flip still re-derives in place. `null` / `undefined` (no
 * product resolved yet) is `false`, the closed answer.
 */
export function productCan(
  product: { readonly plan: { readonly capabilities: readonly Capability[] } } | null | undefined,
  capability: Capability,
): boolean {
  return product?.plan.capabilities.includes(capability) ?? false;
}

/**
 * May the caller author attestations on this integration? (Ruled 2026-10-14:
 * attestations are per product.) The client half of `requireAttestationCapability`
 * in `apps/api/src/routes/vendor-attestations.ts`: the caller's OWN endpoint
 * product decides, through its `plan`, never the vendor's block.
 *
 * `context_product` is always the caller's own endpoint. `slots.length === 2` is
 * the owns-both case, where `other_product` is the caller's too, and the server
 * passes when EITHER endpoint product holds the capability. So the answer is the
 * same on both of the portal's listings of that integration. A product missing
 * from `products` (the catalog not yet loaded) counts as not holding it, the
 * closed answer.
 */
export function integrationCanAuthor(
  integration: {
    readonly context_product: { readonly id: string };
    readonly other_product: { readonly id: string };
    readonly slots: readonly unknown[];
  } | null,
  products: readonly {
    readonly id: string;
    readonly plan: { readonly capabilities: readonly Capability[] };
  }[],
): boolean {
  if (!integration) return false;
  const owned = [integration.context_product.id];
  if (integration.slots.length === 2) owned.push(integration.other_product.id);
  return owned.some((id) =>
    productCan(
      products.find((product) => product.id === id),
      'attestation.author',
    ),
  );
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

/**
 * Is this the connector catalogue-maintenance seat (`STAGE_2_SPEC.md` §8.9, AECI-724)?
 *
 * The signal is data `GET /api/vendor/me` already carries: NO entitlement row at all
 * (`status: null`, which is not the same as lapsed) on a vendor holding a
 * `connector`-role product. No tier and no capability, because the seat has
 * neither. `status: null` on a seat is reachable only through the AECI-740
 * provision, so this is the §8.9 seat by construction. A connector vendor that
 * later pays gets a row, leaves `null`, and stops matching.
 *
 * The plan panel's `catalogue` state and the read-only notices (AECI-1082) both
 * read this one rule, so the panel and the forms cannot describe the same vendor
 * two different ways.
 */
export function isCatalogueSeat(
  status: string | null | undefined,
  products: readonly { readonly product_role?: string | null }[],
): boolean {
  return status === null && products.some((p) => p.product_role === 'connector');
}

/**
 * {@link isCatalogueSeat} over the portal store, as a `computed` for the reason
 * {@link vendorCan} is one. `false` before the store is seeded, so a form rendered
 * in that window shows the ordinary notice rather than a guess.
 */
export function vendorIsCatalogueSeat(store: VendorPortalStore): Signal<boolean> {
  return computed(() => {
    const me = store.me();
    return me ? isCatalogueSeat(me.entitlement.status, me.products) : false;
  });
}
