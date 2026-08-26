import { Component, inject } from '@angular/core';

import { VendorIntegrationsSection } from '../components/vendor-integrations-section';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/integrations` — the attestation surface (AECI-606 /
 * `docs/STAGE_2_ATTESTATIONS_SPEC.md` §6).
 *
 * A routed section now, which preserves the property the `@switch` gave it: the
 * heavier `GET /api/vendor/integrations` read only happens once a vendor asks for
 * this section, because the component is not instantiated until the route is.
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
        <h2
          class="font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.section.integrations"
        >
          Integrations
        </h2>
        <div class="mt-4">
          <aec-vendor-integrations-section
            [verified]="m.vendor.verified"
            [vendorName]="m.vendor.company_name"
          />
        </div>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorIntegrationsPage {
  protected readonly me = inject(VendorPortalStore).me;
}
