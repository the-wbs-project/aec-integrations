import { Component, computed, inject } from '@angular/core';

import { VendorIntegrationsSection } from '../components/vendor-integrations-section';
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
 * `verified` is still passed down verbatim rather than resolved into a
 * capability here — `attestation.author` is declared but has no server-side
 * consumer yet (`STAGE_2_REALTIME_SPEC.md` §6.1, "what would have to change for
 * it to become a capability"), so flipping the client half first would show
 * enabled controls that collect a 403. Both halves move in one change or
 * neither does.
 */
@Component({
  selector: 'aec-vendor-integrations-page',
  imports: [VendorIntegrationsSection],
  template: `
    @if (me(); as m) {
      <div>
        <div class="mt-4">
          <aec-vendor-integrations-section
            [verified]="m.vendor.verified"
            [vendorName]="m.vendor.company_name"
            [contextProductId]="contextProductId()"
          />
        </div>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorIntegrationsPage {
  private readonly ctx = vendorProductContext();

  protected readonly me = inject(VendorPortalStore).me;

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
