import { Component, computed, inject } from '@angular/core';

import { VendorProductsSection } from '../components/vendor-products-section';
import { vendorCan } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug/profile` (AECI-666) — one product's listing copy:
 * description, website, the two doc URLs, and the logo.
 *
 * Its body is `vendor-product-form.ts` in its `profile` projection, NOT a second
 * form component. That form owns one baseline, one dirty diff and one
 * reconciliation against `PATCH /api/vendor/products/:id`; splitting it in two
 * would mean two of each racing on one endpoint that both requires ≥1 changed
 * field and re-asserts `product.taxonomy.edit` when facet arrays ride along.
 * See its `section` input.
 */
@Component({
  selector: 'aec-vendor-product-profile-page',
  imports: [VendorProductsSection],
  template: `
    @if (me(); as m) {
      <aec-vendor-products-section
        [products]="m.products"
        [selectedSlug]="selectedSlug()"
        [canEdit]="canEdit()"
        [canEditTaxonomy]="canEditTaxonomy()"
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
  protected readonly canEdit = vendorCan(this.store, 'product.edit');
  protected readonly canEditTaxonomy = vendorCan(this.store, 'product.taxonomy.edit');
  protected readonly selectedSlug = computed(() => this.ctx.product()?.slug ?? null);
}
