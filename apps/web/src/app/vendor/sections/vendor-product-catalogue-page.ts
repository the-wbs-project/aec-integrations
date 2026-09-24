import { Component, computed } from '@angular/core';

import { VendorConnectorCatalogue } from '../components/vendor-connector-catalogue';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug/catalogue` — the connector catalogue seat's screen
 * (AECI-1083 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.16).
 *
 * The product row shows this tab only on a `connector`-role product
 * (`VENDOR_PRODUCT_NAV_ITEMS`' `roles`). A URL typed onto any other product lands
 * here anyway, so it says the product has no catalogue rather than asking the API,
 * which would answer 404 for the same reason.
 *
 * Not entitlement-gated: the §8.9 seat has no entitlement, and the server gates on
 * ownership plus the product's role alone (`STAGE_2_SPEC.md` §8.9(2)).
 */
@Component({
  selector: 'aec-vendor-product-catalogue-page',
  imports: [VendorConnectorCatalogue],
  template: `
    @if (product(); as p) {
      <div class="mt-4">
        @if (p.product_role === 'connector') {
          <aec-vendor-connector-catalogue [productId]="p.id" [productName]="p.name" />
        } @else {
          <p
            class="max-w-[52ch] rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4 text-sm leading-relaxed text-(--text-primary)"
            data-catalogue-not-connector
            i18n="@@vendor.catalogue.notConnector"
          >
            Only connector products have a catalogue. This product is not a connector.
          </p>
        }
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductCataloguePage {
  private readonly ctx = vendorProductContext();
  protected readonly product = computed(() => this.ctx.product());
}
