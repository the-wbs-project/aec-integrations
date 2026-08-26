import { Component, inject } from '@angular/core';

import { VendorSeatRoster } from '../components/vendor-seat-roster';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/seats` — the read-only roster of the seats sharing this `vendor_id`
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6; multi-seat is flat at launch, and
 * self-serve invite/revoke is deferred).
 *
 * The roster fetches `GET /api/vendor/seats` itself through the store, so as a
 * routed section it still only fires when a vendor opens it.
 */
@Component({
  selector: 'aec-vendor-seats-page',
  imports: [VendorSeatRoster],
  template: `
    @if (me(); as m) {
      <div>
        <h2 class="font-display text-xl font-semibold text-(--text-primary)">
          <span i18n="@@vendor.section.seats">Seats</span>
          <span class="text-(--text-secondary)">({{ m.seat_count }})</span>
        </h2>
        <div class="mt-4">
          <aec-vendor-seat-roster [seatCount]="m.seat_count" />
        </div>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorSeatsPage {
  protected readonly me = inject(VendorPortalStore).me;
}
