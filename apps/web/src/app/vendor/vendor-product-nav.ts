import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { SegmentedRouteNav } from '../shared/segmented-route-nav/segmented-route-nav';
import { VENDOR_PRODUCT_NAV_ITEMS } from './vendor-nav';

/**
 * The PRODUCT-level section nav (AECI-666), under the product heading, switches
 * between one product's Profile, Taxonomy and Integrations routes.
 *
 * ── WHY IT IS A SEGMENTED ROUTE CONTROL ─────────────────────────────────────
 * AECI-959 separates the two route levels visually: the vendor row remains the
 * primary underlined navigation, while this compact, sunken track reads as the
 * selected product's local navigation. It does not add card containment around
 * product routes, which already render their own cards.
 *
 * ── WHY IT CARRIES THE PRODUCT NAME IN ITS LABEL ────────────────────────────
 * There are now two `<nav>` landmarks on this page, and a landmark list reading
 * "Portal sections / Portal sections" is useless. Naming this one for its product
 * ("Revit sections") is also what lets the items stay short: the row sits under a
 * heading that is the product's name, inside a nav labelled with that name, so
 * "Profile" is unambiguous where the vendor row needs "Vendor Overview".
 *
 * The name is an input rather than read from a store, for the same reason
 * `vendor-portal-nav.ts` takes its products as one: this component does no DI at
 * all, so it is testable without a store and works unchanged under the preview's
 * DI shadow.
 *
 * Paths are RELATIVE to the product route, so one template serves
 * `/vendor/:vendorSlug/products/:productSlug` and the preview's mount of the
 * same section routes.
 *
 * The shared control owns the AECI-958 overflow pairing: sideways scrolling is
 * retained while vertical overflow stays hidden.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-product-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SegmentedRouteNav],
  template: ` <aec-segmented-route-nav [ariaLabel]="navLabel()" [items]="navItems" /> `,
  host: { class: 'mt-4 mb-8 block' },
})
export class VendorProductNav {
  /** The product this row belongs to — used only to name the landmark. */
  readonly productName = input.required<string>();

  /**
   * Built with `$localize` at the call site rather than as an `i18n-aria-label`
   * attribute: an interpolated `i18n-*` attribute emits NO attribute at all in
   * this toolchain, so the landmark would silently lose its name.
   */
  protected readonly navLabel = () =>
    $localize`:@@vendor.productNav.aria:${this.productName()}:product: sections`;

  protected readonly navItems = VENDOR_PRODUCT_NAV_ITEMS;
}
