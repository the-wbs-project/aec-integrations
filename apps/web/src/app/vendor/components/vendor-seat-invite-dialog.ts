import { Component, inject, viewChild } from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import { AecButton } from '../../shared/button/button';
import { AecIcon } from '../../shared/icon/icon';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorSeatInviteForm } from './vendor-seat-invite-form';

/**
 * The "Invite" affordance on the Seats section (AECI-664 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a) — an owner-only trigger sitting opposite
 * the "Seats (N)" heading, opening {@link VendorSeatInviteForm} in a modal.
 *
 * ── WHY A DIALOG ────────────────────────────────────────────────────────────
 * The form used to sit permanently below the roster, which put a persistent
 * data-entry surface under a list whose ordinary use is *reading* — who has
 * access, and who has a pending invite. Inviting is an occasional, deliberate
 * act; the roster is the thing people come here to look at. Moving the form
 * behind a trigger next to the heading gives the section one obvious primary
 * action and lets the roster be the roster.
 *
 * ── IT STAYS OPEN AFTER A SEND ──────────────────────────────────────────────
 * Unlike `home-feedback-dialog.ts` (a one-shot), this does NOT auto-close on
 * success. Seats are onboarded in batches — an owner bringing on an agency plus
 * two colleagues would otherwise reopen the dialog three times. The form clears
 * its field and keeps the "Invite sent to …" confirmation, so "send another" is
 * the obvious next step; the durable confirmation is the roster's "Pending
 * invites" list, which the form has already re-read from the server by then.
 * Escape / backdrop / the close button dismiss.
 *
 * ── OPEN IS IMPERATIVE, NOT REACTIVE ────────────────────────────────────────
 * `BrnDialog.open()` is called straight from the click handler, never from an
 * `effect()` — the latter throws NG0602 (CDK attaches a provider that itself
 * creates an effect, and Angular forbids nesting one inside another's reactive
 * context; hit on AECI-218). Nothing but a user click opens this, so there is no
 * reason to route it through a signal. As a bonus the component stays renderable
 * under TestBed, which the `effect()` form is not.
 *
 * `canManage()` is the SERVER's verdict on `profiles.seat_owner` (§11a.4), read
 * from the store rather than re-derived from the roster — hiding a control the
 * API would 403 and showing one it would accept have to come from one source. It
 * arrives with `GET /api/vendor/seats`, so the trigger appears when the roster
 * does; a member never sees it. SSR renders nothing (the flag defaults false),
 * so no visitor state reaches cached HTML.
 */
@Component({
  selector: 'aec-vendor-seat-invite-dialog',
  imports: [
    BrnDialog,
    BrnDialogContent,
    BrnDialogClose,
    BrnDialogTitle,
    BrnDialogDescription,
    AecButton,
    AecIcon,
    VendorSeatInviteForm,
  ],
  template: `
    @if (canManage()) {
      <button aecButton type="button" (click)="open()">
        <span i18n="@@vendor.seats.invite.open">Invite</span>
      </button>

      <brn-dialog [role]="'alertdialog'" [autoFocus]="'first-heading'">
        <ng-template brnDialogContent>
          <div class="aec-dialog max-h-[85vh] w-[min(92vw,32rem)] overflow-y-auto p-6 md:p-8">
            <div class="flex items-start justify-between gap-4">
              <h2
                brnDialogTitle
                tabindex="-1"
                class="rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
                i18n="@@vendor.seats.invite.heading"
              >
                Invite a colleague
              </h2>
              <button
                aecButton
                variant="ghost"
                iconOnly
                brnDialogClose
                type="button"
                [class]="'-me-1 -mt-1 shrink-0'"
                i18n-aria-label="@@vendor.seats.invite.close"
                aria-label="Close"
              >
                <aec-icon name="x" decorative />
              </button>
            </div>

            <p
              brnDialogDescription
              class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
              i18n="@@vendor.seats.invite.hint"
            >
              Any email address works: a colleague, an agency, or whoever keeps this listing
              current. They'll get a link, and the seat is added when they sign in with that
              address.
            </p>

            <div class="mt-6">
              <aec-vendor-seat-invite-form />
            </div>
          </div>
        </ng-template>
      </brn-dialog>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorSeatInviteDialog {
  private readonly dialog = viewChild(BrnDialog);

  protected readonly canManage = inject(VendorPortalStore).canManageSeats;

  /** Open the modal. Called from the trigger's click handler only — see the
   *  NG0602 note in the class docblock. */
  protected open(): void {
    this.dialog()?.open();
  }
}
