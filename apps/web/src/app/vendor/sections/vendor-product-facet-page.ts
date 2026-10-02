import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import type { ProductFacetKind } from '../components/vendor-product-facet-editor';
import { VendorProductsSection } from '../components/vendor-products-section';
import { VendorPortalStore } from '../vendor-portal-store';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug/{categories|trades|audiences|phases}` (AECI-994) —
 * one taxonomy facet of one product, edited inline. Audiences and Phases also
 * carry the "How teams use it" points for each ticked term.
 *
 * One component serves all four routes; the facet comes from route `data`, so
 * the four tabs cannot drift apart in gating or layout.
 *
 * The entitlement axis stays FIELD-granular, not route-granular: the page does
 * not gate itself. The facet editor reads THIS product's plan with `productCan`
 * (AECI-1214, §13.7): categories need `product.categories.edit` (Free), trades,
 * audiences and phases `product.taxonomy.edit`, and the points
 * `product.usefulness.edit` (both Managed). A product without them shows its own
 * data read-only, per the ownership-reads / capability-writes split the rest of
 * `/api/vendor/*` uses.
 */
@Component({
  selector: 'aec-vendor-product-facet-page',
  imports: [VendorProductsSection],
  template: `
    @if (me(); as m) {
      <aec-vendor-products-section
        [products]="m.products"
        [selectedSlug]="selectedSlug()"
        [section]="facet"
      />
    }
  `,
  host: { class: 'block' },
})
export class VendorProductFacetPage {
  private readonly store = inject(VendorPortalStore);
  private readonly ctx = vendorProductContext();

  protected readonly facet = inject(ActivatedRoute).snapshot.data['facet'] as ProductFacetKind;
  protected readonly me = this.store.me;
  protected readonly selectedSlug = computed(() => this.ctx.product()?.slug ?? null);
}
