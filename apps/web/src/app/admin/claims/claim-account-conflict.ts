import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecIcon } from '../../shared/icon/icon';

import type { AdminClaim, AdminClaimantSeat } from '@aeci/shared';

/** The two `claimant_seat` kinds that block a grant (AECI-1420). */
export type ClaimantSeatConflict = Exclude<AdminClaimantSeat, { kind: 'none' }>;

/**
 * The claimant's seat when it blocks a grant, else `null`. One account belongs
 * to one vendor (`STAGE_2_SPEC.md` 8.3), so a site admin or a seat on another
 * vendor makes the server refuse Grant with `409 GRANT_CONFLICT`. `none` and
 * `null` (unknown) never block.
 */
export function claimantSeatConflict(claim: AdminClaim): ClaimantSeatConflict | null {
  const seat = claim.claimant_seat;
  return seat && seat.kind !== 'none' ? seat : null;
}

/**
 * The red account-conflict box (AECI-1420, `STAGE_2_VENDOR_PORTAL_SPEC.md` 5).
 * Shared by `/admin/claims` and `/admin/claims/:id` so the two screens word the
 * same claim the same way.
 *
 * It renders only for a conflict. The final sentence follows the status: an open
 * or in-review claim says "Reject it.", a rejected claim says it was rejected
 * automatically at submit, and a resolved claim gets no instruction. The box
 * carries `boxId` so the queue's disabled Grant can point at it with
 * `aria-describedby`.
 *
 * Red is the error token on an unlayered class (`.aec-notice-error` in
 * `styles.css`), written while a border-colour utility never reached the element
 * (fixed in AECI-2088). The one red box in the console, so it is not the Bone
 * notice: the grant WILL be refused. Light only.
 */
@Component({
  selector: 'aec-claim-account-conflict',
  imports: [AecIcon, RouterLink],
  template: `
    @if (conflict(); as c) {
      <div
        [id]="boxId()"
        class="aec-notice-error flex items-start gap-3 rounded-control border bg-(--surface-raised) p-4"
        data-testid="claim-account-conflict"
      >
        <span class="inline-flex shrink-0 text-(--status-error)"
          ><aec-icon name="alert-circle" decorative [size]="4"
        /></span>
        <div class="max-w-[75ch] text-t-14 leading-relaxed text-(--text-primary)">
          @if (c.kind === 'other_vendor') {
            <p i18n="@@admin.claims.accountConflict.otherVendor">
              This address already holds a seat on
              <a
                [routerLink]="['/admin/vendors', c.vendor.id]"
                class="rounded-mark font-semibold text-(--text-primary) underline underline-offset-3 hover:text-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3"
                data-testid="claim-account-conflict-vendor"
                >{{ c.vendor.name }}</a
              >. One account belongs to one vendor, so the grant will be refused.
            </p>
          } @else {
            <p i18n="@@admin.claims.accountConflict.admin">
              This address is a site admin account. It cannot hold a vendor seat.
            </p>
          }
          @if (status() === 'rejected') {
            <p class="mt-1" i18n="@@admin.claims.accountConflict.rejected">
              This claim is rejected.
            </p>
          } @else if (status() === 'open' || status() === 'in_review') {
            <p class="mt-1 font-semibold" i18n="@@admin.claims.accountConflict.rejectIt">
              Reject it.
            </p>
          }
        </div>
      </div>
    }
  `,
})
export class ClaimAccountConflict {
  readonly claim = input.required<AdminClaim>();
  /** The box's DOM id, referenced by the queue's disabled Grant. */
  readonly boxId = input.required<string>();

  protected readonly conflict = computed(() => claimantSeatConflict(this.claim()));
  protected readonly status = computed(() => this.claim().status);
}
