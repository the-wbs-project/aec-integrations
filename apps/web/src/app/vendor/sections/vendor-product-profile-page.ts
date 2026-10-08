import { Component, PLATFORM_ID, computed, effect, inject, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import { VendorProductsSection } from '../components/vendor-products-section';
import {
  VendorReviewStrip,
  reviewStepState,
  reviewStripShown,
} from '../components/vendor-review-strip';
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
  imports: [VendorProductsSection, VendorReviewStrip],
  template: `
    @if (me(); as m) {
      <!-- AECI-1218: "Looks right" on this product's details (section 13.8).
           AECI-1241: only while the step is not done at load. -->
      @if (ctx.product(); as p) {
        @if (showStrip()) {
          <aec-vendor-review-strip
            class="mb-6"
            target="product"
            [productId]="p.id"
            [productName]="p.name"
            [done]="step() === 'done'"
          />
        }
      }
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
  protected readonly ctx = vendorProductContext();
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly me = this.store.me;
  protected readonly selectedSlug = computed(() => this.ctx.product()?.slug ?? null);

  /** The "Check product details" step on this product's checklist. `unknown` until it loads. */
  protected readonly step = computed(() => {
    const id = this.ctx.product()?.id;
    return reviewStepState(id ? this.store.productChecklists().get(id) : null, 'product_details');
  });
  /** AECI-1241: the strip shows only for a step not done when the page loaded. */
  protected readonly showStrip = reviewStripShown(() => ({
    record: this.ctx.product()?.id ?? null,
    state: this.step(),
  }));

  constructor() {
    effect(() => {
      const id = this.ctx.product()?.id;
      if (!id || !this.browser) return;
      untracked(() => void this.store.ensureProductChecklist(id));
    });
  }
}
