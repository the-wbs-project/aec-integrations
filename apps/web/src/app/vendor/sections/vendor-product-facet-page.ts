import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import type { ProductFacetKind } from '../components/vendor-product-facet-editor';
import { VendorProductsSection } from '../components/vendor-products-section';
import { vendorCan } from '../vendor-capabilities';
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
 * not gate itself on `product.taxonomy.edit` or `product.usefulness.edit`. A
 * vendor without them sees its own data read-only, per the ownership-reads /
 * capability-writes split the rest of `/api/vendor/*` uses.
 */
@Component({
  selector: 'aec-vendor-product-facet-page',
  imports: [VendorProductsSection],
  template: `
    @if (me(); as m) {
      <aec-vendor-products-section
        [products]="m.products"
        [selectedSlug]="selectedSlug()"
        [canEdit]="canEdit()"
        [canEditTaxonomy]="canEditTaxonomy()"
        [canEditUsefulness]="canEditUsefulness()"
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
  protected readonly canEdit = vendorCan(this.store, 'product.edit');
  protected readonly canEditTaxonomy = vendorCan(this.store, 'product.taxonomy.edit');
  protected readonly canEditUsefulness = vendorCan(this.store, 'product.usefulness.edit');
  protected readonly selectedSlug = computed(() => this.ctx.product()?.slug ?? null);
}
