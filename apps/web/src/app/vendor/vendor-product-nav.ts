import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import {
  VENDOR_NAV_ITEM_ACTIVE_CLASS,
  VENDOR_NAV_ITEM_CLASS,
  VENDOR_PRODUCT_NAV_ITEMS,
} from './vendor-nav';

/**
 * The PRODUCT-level section nav (AECI-666) — a second tab row, under the product
 * heading, switching between one product's Profile, Taxonomy and Integrations.
 *
 * ── WHY IT LOOKS IDENTICAL TO THE PORTAL ROW ────────────────────────────────
 * It reuses `VENDOR_NAV_ITEM_CLASS` / `VENDOR_NAV_ITEM_ACTIVE_CLASS` verbatim.
 * Two tab rows on one page that differ in weight, padding or underline read as a
 * nav and an imitation of one; identical treatment plus position is what makes
 * the relationship legible — the second row is *inside* what the first row
 * selected. Nesting is expressed by placement, not by restyling.
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
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-product-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav [attr.aria-label]="navLabel()" class="mt-4 mb-8 border-b border-(--border-default)">
      <ul class="m-0 flex list-none gap-x-6 overflow-x-auto p-0 whitespace-nowrap">
        @for (item of navItems; track item.path) {
          <li class="shrink-0">
            <a
              [routerLink]="item.path"
              [routerLinkActive]="activeClass"
              ariaCurrentWhenActive="page"
              [class]="itemClass"
            >
              {{ item.label }}
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
  styles: [':host { display: block; }'],
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
  protected readonly itemClass = VENDOR_NAV_ITEM_CLASS;
  protected readonly activeClass = VENDOR_NAV_ITEM_ACTIVE_CLASS;
}
