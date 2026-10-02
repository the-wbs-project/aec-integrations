import { Component, computed, inject } from '@angular/core';

import { VendorProductsSection } from '../components/vendor-products-section';
import { VendorPortalStore } from '../vendor-portal-store';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug/profile` (AECI-666) — one product's listing copy:
 * description, website, the two doc URLs, and the logo.
 *
 * Its body is `vendor-product-form.ts`. The taxonomy facets and "How teams use
 * it" are on their own tabs since AECI-994 (`vendor-product-facet-page.ts`).
 *
 * No page-level gate (AECI-1214): the form gates each field on THIS product's
 * plan with `productCan` (§13.7), because the fields split across Free and
 * Managed. It never reads `me().entitlement`.
 */
@Component({
  selector: 'aec-vendor-product-profile-page',
  imports: [VendorProductsSection],
  template: `
    @if (me(); as m) {
      <aec-vendor-products-section
        [products]="m.products"
        [selectedSlug]="selectedSlug()"
        section="profile"
      />
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductProfilePage {
  private readonly store = inject(VendorPortalStore);
  private readonly ctx = vendorProductContext();

  protected readonly me = this.store.me;
  protected readonly selectedSlug = computed(() => this.ctx.product()?.slug ?? null);
}
