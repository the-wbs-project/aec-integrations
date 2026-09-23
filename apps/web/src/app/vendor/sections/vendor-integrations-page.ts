import { Component, computed, inject } from '@angular/core';

import { VendorIntegrationsSection } from '../components/vendor-integrations-section';
import { VendorProductConnectors } from '../components/vendor-product-connectors';
import { vendorCan } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import { vendorProductContext } from './vendor-product-context';

/**
 * `…/products/:productSlug/integrations` — the attestation surface (AECI-606 /
 * `docs/STAGE_2_ATTESTATIONS_SPEC.md` §6), scoped to ONE product since AECI-666.
 *
 * A routed section, which preserves the property the `@switch` gave it: the
 * heavier `GET /api/vendor/integrations` read only happens once a vendor asks for
 * this section, because the component is not instantiated until the route is.
 *
 * ── WHY IT MOVED UNDER THE PRODUCT ──────────────────────────────────────────
 * It was a vendor-wide list. An integration is a thing that happens *to a
 * product*, and a vendor with a dozen products was reading one flat list to
 * answer a per-product question. The read stays vendor-wide (one call, one cursor
 * scope — see `contextProductId` on the section); only the view narrows.
 *
 * The write gate is the `attestation.author` capability off `me`, the same
 * capability the server's `requireCapability` asserts on the attestation and
 * version writes (AECI-623; `STAGE_2_REALTIME_SPEC.md` §6.1). It used to be the
 * `vendors.verified` mirror; the client and server halves moved in one change so
 * enabled controls can never collect a 403.
 *
 * AECI-1013 adds the read-only Connectors section below the list: the connectors
 * that deliver or reach this product. It is its own per-product read, outside the
 * live cursor, and it renders nothing when no connector reaches the product.
 */
@Component({
  selector: 'aec-vendor-integrations-page',
  imports: [VendorIntegrationsSection, VendorProductConnectors],
  template: `
    @if (me(); as m) {
      <div>
        <div class="mt-4">
          <aec-vendor-integrations-section
            [canAuthor]="canAuthor()"
            [vendorName]="m.vendor.company_name"
            [contextProductId]="contextProductId()"
            [urlState]="true"
          />
        </div>
        <div class="mt-10">
          <aec-vendor-product-connectors [productId]="contextProductId()" />
        </div>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorIntegrationsPage {
  private readonly ctx = vendorProductContext();

  private readonly store = inject(VendorPortalStore);
  protected readonly me = this.store.me;
  protected readonly canAuthor = vendorCan(this.store, 'attestation.author');

  /**
   * In practice never `null`: the product shell only renders its outlet once
   * `ctx.product()` has resolved, so this page does not exist before the catalog
   * lands. The fallback is here because the signal's type says it can be, not
   * because there is a state that reaches it — and it deliberately does NOT fall
   * back to "unscoped", which is what `null` means to the section: a momentary
   * unscoped render would flash every product's integrations onto one product's
   * tab.
   */
  protected readonly contextProductId = computed(() => this.ctx.product()?.id ?? '');
}
