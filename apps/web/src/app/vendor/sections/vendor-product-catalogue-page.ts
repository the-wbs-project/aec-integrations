import { Component, computed } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { VendorProduct } from '@aeci/shared';

import { VendorConnectorCatalogue } from '../components/vendor-connector-catalogue';
import { showsCatalogTab } from '../vendor-capabilities';
import { PORTAL_NOTICE_CLASS } from '../shared/portal-notice';
import { IN_TEXT_LINK } from '../integration-detail/integration-detail-styles';

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
 * AECI-2206: a connector product has a Catalog tab only once its catalogue is handed to
 * the vendor ({@link showsCatalogTab}). A typed URL on one without the tab lands here
 * too. It never renders the read-only catalogue and never asks the API. It says why
 * there is no tab (AECi-managed, a Sync Service with none, or no catalogue at all) and
 * links to the Integrations tab. AECI-2045 built that notice for a Sync Service.
 *
 * Not entitlement-gated: the §8.9 seat has no entitlement, and the server gates on
 * ownership plus the product's role alone (`STAGE_2_SPEC.md` §8.9(2)).
 */
@Component({
  selector: 'aec-vendor-product-catalogue-page',
  imports: [VendorConnectorCatalogue, RouterLink],
  template: `
    @if (product(); as p) {
      <div class="mt-4">
        @if (showsCatalogTab(p)) {
          <aec-vendor-connector-catalogue [productId]="p.id" [productName]="p.name" />
        } @else if (p.product_role === 'connector') {
          <p
            [class]="noticeClass + ' max-w-[52ch] text-sm leading-relaxed'"
            [attr.data-catalogue-hidden]="hiddenReason(p)"
            [attr.data-catalogue-sync-service]="hiddenReason(p) === 'sync-service' ? '' : null"
          >
            @switch (hiddenReason(p)) {
              @case ('aeci-managed') {
                <span i18n="@@vendor.catalogue.hidden.aeciManaged"
                  >We maintain the catalog for {{ p.name }} for now, so there is nothing to do here
                  yet. Its integrations are on its Integrations tab.</span
                >
              }
              @case ('sync-service') {
                <span i18n="@@vendor.catalogue.syncService"
                  >{{ p.name }} is a Sync Service, so it has no catalog. The pairs it delivers are
                  on its Integrations tab.</span
                >
              }
              @default {
                <span i18n="@@vendor.catalogue.hidden.none"
                  >We do not hold a catalog for {{ p.name }}. Its integrations are on its
                  Integrations tab.</span
                >
              }
            }
            {{ ' ' }}
            <a
              routerLink="../integrations"
              [class]="linkClass"
              i18n="@@vendor.catalogue.syncService.link"
              >Open the Integrations tab</a
            >
          </p>
        } @else {
          <p
            [class]="noticeClass + ' max-w-[52ch] text-sm leading-relaxed'"
            data-catalogue-not-connector
            i18n="@@vendor.catalogue.notConnector"
          >
            Only connector products have a catalog. This product is not a connector.
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
  protected readonly showsCatalogTab = showsCatalogTab;

  /** Why a connector product has no Catalog tab (AECI-2206), for the notice's wording. */
  protected hiddenReason(p: VendorProduct): 'aeci-managed' | 'sync-service' | 'none' {
    if (p.has_connector_catalog) return 'aeci-managed';
    return p.connector_kind === 'sync_service' ? 'sync-service' : 'none';
  }
  /** AECI-1811: a state, not a card, so it is the portal notice. */
  protected readonly noticeClass = PORTAL_NOTICE_CLASS;
  /** The in-text link role (DESIGN.md, "The Link Treatment Rule"). */
  protected readonly linkClass = IN_TEXT_LINK;
}
