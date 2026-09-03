import { Component, inject } from '@angular/core';

import { VendorSeatInviteDialog } from '../components/vendor-seat-invite-dialog';
import { VendorSeatRoster } from '../components/vendor-seat-roster';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/seats` — the roster of the seats sharing this `vendor_id`
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6; multi-seat is flat at launch, with
 * self-serve invites since §11a).
 *
 * The heading carries the section's one primary action: `Invite`, right-aligned
 * opposite "Seats (N)", opening the invite form in a modal. It is owner-only and
 * renders nothing at all for a member seat, so the row collapses to the heading.
 *
 * The roster fetches `GET /api/vendor/seats` itself through the store, so as a
 * routed section it still only fires when a vendor opens it. That same read is
 * what carries `can_manage_seats` — hence the Invite trigger appearing with the
 * roster rather than with the first paint.
 */
@Component({
  selector: 'aec-vendor-seats-page',
  imports: [VendorSeatInviteDialog, VendorSeatRoster],
  template: `
    @if (me(); as m) {
      <div>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="font-display text-xl font-semibold text-(--text-primary)">
            <span i18n="@@vendor.section.seats">Seats</span>
            <span class="text-(--text-secondary)">({{ m.seat_count }})</span>
          </h2>
          <!-- Owner-only; renders nothing for a member seat. -->
          <aec-vendor-seat-invite-dialog />
        </div>
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
