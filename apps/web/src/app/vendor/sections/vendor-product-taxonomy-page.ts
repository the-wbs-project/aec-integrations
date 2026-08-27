import { Component, computed, inject } from '@angular/core';

import { VendorProductsSection } from '../components/vendor-products-section';
import { vendorCan } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug/taxonomy` (AECI-666) — one product's four facets:
 * categories, audiences, phases, and trades.
 *
 * A tab of its own because taxonomy is the part of a listing a vendor revisits
 * on a different cadence from its copy — a facet set is reviewed when the
 * vocabulary moves or the product's positioning does, not when a docs URL
 * changes — and because the four chip fieldsets are the tallest thing on the old
 * combined form, pushing the text fields off screen.
 *
 * Body is `vendor-product-form.ts` in its `taxonomy` projection; see
 * `vendor-product-profile-page.ts` for why the form is projected rather than
 * split.
 *
 * The entitlement axis stays FIELD-granular here, not route-granular: this page
 * does not gate itself on `product.taxonomy.edit`. A vendor without that
 * capability sees its own facets read-only and the copy explaining what
 * verification unlocks — the same ownership-reads / capability-writes split the
 * rest of `/api/vendor/*` uses. Routing it away would hide data the vendor owns.
 */
@Component({
  selector: 'aec-vendor-product-taxonomy-page',
  imports: [VendorProductsSection],
  template: `
    @if (me(); as m) {
      <aec-vendor-products-section
        [products]="m.products"
        [selectedSlug]="selectedSlug()"
        [canEdit]="canEdit()"
        [canEditTaxonomy]="canEditTaxonomy()"
        section="taxonomy"
      />
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductTaxonomyPage {
  private readonly store = inject(VendorPortalStore);
  private readonly ctx = vendorProductContext();

  protected readonly me = this.store.me;
  protected readonly canEdit = vendorCan(this.store, 'product.edit');
  protected readonly canEditTaxonomy = vendorCan(this.store, 'product.taxonomy.edit');
  protected readonly selectedSlug = computed(() => this.ctx.product()?.slug ?? null);
}
