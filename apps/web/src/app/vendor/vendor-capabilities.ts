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

/** The product fields the catalogue rules read. All optional, so a partial value
 *  reads as "not a catalogue product", the closed answer. */
export interface CatalogueProductFields {
  readonly product_role?: string | null;
  readonly connector_kind?: string | null;
  readonly has_connector_catalog?: boolean | null;
  /** `VendorProduct.connector_catalog_managed_by` (AECI-2206). */
  readonly connector_catalog_managed_by?: string | null;
}

/**
 * Has AEC Integrations handed this product's catalogue to the vendor
 * (`connector_catalogs.managed_by = 'vendor'`, AECI-2206)? Only a `connector` product
 * holds one. Until the handover the catalogue is read-only and gives the vendor
 * nothing to do, so nothing in the portal points at it (ruling, Chris, 2026-11-26).
 */
export function catalogueHandedToVendor(product: CatalogueProductFields): boolean {
  return product.product_role === 'connector' && product.connector_catalog_managed_by === 'vendor';
}

/**
 * Is this product the connector catalogue-maintenance seat's product
 * (`STAGE_2_SPEC.md` §8.9, AECI-724)? Narrowed by AECI-2044 and AECI-2206: a
 * `connector` that is NOT a Sync Service (an Integration platform, or no kind) whose
 * catalogue AEC Integrations has handed to the vendor ({@link catalogueHandedToVendor}).
 * A Sync Service sells finished pairs and may buy Managed (ruling 6 on AECI-2035). An
 * AECi-managed catalogue gives the seat nothing to maintain yet, so its product gets
 * the ordinary panel for its kind (`unavailable` on Free for an Integration platform).
 */
export function isCatalogueProduct(product: CatalogueProductFields): boolean {
  return product.connector_kind !== 'sync_service' && catalogueHandedToVendor(product);
}

/**
 * Does the product row show the Catalog tab (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.16)?
 * Since AECI-2206, only when the product's catalogue has been handed to the vendor
 * ({@link catalogueHandedToVendor}), on every connector kind. It is hidden while AEC
 * Integrations maintains the catalogue, and when there is none. AECI-2045 had shown it
 * whenever a catalogue existed, and on an Integration platform even with none.
 */
export function showsCatalogTab(product: CatalogueProductFields): boolean {
  return catalogueHandedToVendor(product);
}

/**
 * Is this the connector catalogue-maintenance seat (`STAGE_2_SPEC.md` §8.9, AECI-724)?
 *
 * The signal is data `GET /api/vendor/me` already carries: NO license (`status:
 * null`, which is not the same as lapsed) on a vendor holding a catalogue product
 * ({@link isCatalogueProduct}). No tier and no capability, because the seat has
 * neither.
 *
 * AECI-2044 replaced the old rule, "`status: null` and any `connector`-role product".
 * Since AECI-1367 every Free vendor has `status: null`, so the old rule read every Free
 * vendor with a connector product, a mixed vendor such as Rivets included, as this
 * seat, and hid Managed's price and purchase path from products that may buy it.
 *
 * The plan panel's `catalogue` state, the overview's catalogue links and the read-only
 * notices (AECI-1082) all read this rule, so they cannot describe one vendor two ways.
 */
export function isCatalogueSeat(
  status: string | null | undefined,
  products: readonly CatalogueProductFields[],
): boolean {
  return status === null && products.some(isCatalogueProduct);
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
