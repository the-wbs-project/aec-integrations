import { Component, computed } from '@angular/core';

import { VendorReviewsList } from '../components/vendor-reviews-list';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug/reviews` — the portal Reviews tab (AECI-1179,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.16).
 *
 * Per product, because plans live at product level (`STAGE_2_PAID_TIERS_SPEC.md`
 * §13.1 decision 2) and the reply gate is read as `productCan(product,
 * 'review.reply')`. The read is `GET /api/vendor/reviews?product_id=…`, owned by
 * the list component and revalidated on the `reviews` cursor scope.
 */
@Component({
  selector: 'aec-vendor-product-reviews-page',
  imports: [VendorReviewsList],
  template: `
    @if (product(); as p) {
      <div class="mt-4">
        <aec-vendor-reviews-list [product]="p" />
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductReviewsPage {
  private readonly ctx = vendorProductContext();
  protected readonly product = computed(() => this.ctx.product());
}
