import { Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

import { AecButton } from '../../shared/button/button';
import { FIELD_ERROR_CLASS, FIELD_INPUT_CLASS } from '../../shared/form-field/form-field-classes';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';
import { isReplayedEvent } from '../../core/event-replay';

/**
 * The invite form on the Seats section (AECI-664 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a) — owner-only, one address at a time.
 *
 * It is the **body** of {@link VendorSeatInviteDialog}, which owns the trigger,
 * the heading ("Invite a colleague") and the explanatory hint — so this file is
 * the field, the submit and the outcome, nothing else. It is not rendered
 * anywhere else; the owner-only gate lives on the dialog's trigger.
 *
 * ── ANY ADDRESS ─────────────────────────────────────────────────────────────
 * The original build restricted invites to the vendor's own email domain and
 * that restriction is gone (§11a.3). An owner already knows who maintains their
 * listing, and in practice that includes people who will never have a corporate
 * address — an agency, a subsidiary, a parent company, a contractor. So the copy
 * asks for "their email", not "their work email", and the form no longer has a
 * refusal to explain that the person typing could not have predicted.
 *
 * ── WHY THE ERRORS GET INDIVIDUAL COPY ──────────────────────────────────────
 * Every refusal this endpoint can still return is ACTIONABLE, and a generic
 * "something went wrong" would waste that. A duplicate means the invite is
 * already sitting in their colleague's inbox, which changes what they do next
 * from "retry" to "go ask them"; a rate limit is temporary and needs to say so.
 * Mapping the codes is the difference between a form that explains itself and one
 * that makes people email support.
 *
 * Pessimistic, not optimistic: `STAGE_2_REALTIME_SPEC.md` keeps forms
 * pessimistic on purpose (only toggles are optimistic), and an invite that
 * appeared in the list and then vanished would leave the owner unsure whether
 * their colleague was mailed.
 */
@Component({
  selector: 'aec-vendor-seat-invite-form',
  imports: [AecButton],
  template: `
    <form method="dialog" (submit)="submit($event)">
      <div class="flex flex-wrap items-start gap-2">
        <div class="min-w-0 flex-[1_1_16rem]">
          <label class="sr-only" for="seat-invite-email" i18n="@@vendor.seats.invite.label">
            Email address
          </label>
          <input
            id="seat-invite-email"
            type="email"
            name="email"
            autocomplete="off"
            required
            [value]="email()"
            (input)="onInput($event)"
            [attr.aria-invalid]="error() ? 'true' : null"
            [attr.aria-describedby]="error() ? 'seat-invite-error' : null"
            [class]="inputClass"
          />
        </div>
        <button
          aecButton
          type="submit"
          [disabled]="busy() || email().trim().length === 0"
          [class]="'max-sm:w-full'"
        >
          @if (busy()) {
            <span i18n="@@vendor.seats.invite.sending">Sending…</span>
          } @else {
            <span i18n="@@vendor.seats.invite.submit">Send invite</span>
          }
        </button>
      </div>

      @if (error(); as message) {
        <p id="seat-invite-error" [class]="errorClass + ' mt-2'" role="alert">
          {{ message }}
        </p>
      }
      @if (sentTo(); as address) {
        <!-- A local status line, on purpose: the dialog is modal, and the CDK hides
             everything outside it from assistive tech while it is open, the portal's
             shared live region included. So the announcer would say nothing here.
             This is feedback beside the control just used, which STAGE_2_REALTIME_SPEC
             §6.3 allows (AECI-1812). -->
        <p class="mt-2 text-sm text-(--text-secondary)" role="status">
          <ng-container i18n="@@vendor.seats.invite.sent">Invite sent to</ng-container>
          {{ address }}
        </p>
      }
    </form>
  `,
  styles: [':host { display: block; }'],
})
export class VendorSeatInviteForm {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);

  protected readonly inputClass = FIELD_INPUT_CLASS;
  /** The refusal is the field's error (the input points at it), so it takes the
   *  shared recipe, whose alert icon means colour is never the only sign. */
  protected readonly errorClass = FIELD_ERROR_CLASS;

  protected readonly email = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly sentTo = signal<string | null>(null);

  protected onInput(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
    // Clear the previous outcome the moment they start fixing it — a stale error
    // sitting under a field they have already changed reads as a live failure.
    this.error.set(null);
    this.sentTo.set(null);
  }

  protected async submit(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    const address = this.email().trim();
    if (!address || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    this.sentTo.set(null);
    try {
      await this.api.inviteSeat(address);
      this.sentTo.set(address);
      this.email.set('');
      // Take the server's list rather than appending locally: it is the only
      // thing that knows the real `expires_at` and the normalized address.
      await this.store.reload('seats');
    } catch (err) {
      this.error.set(messageFor(err));
    } finally {
      this.busy.set(false);
    }
  }
}

/** Map the API's error codes onto copy that says what to do next. */
function messageFor(err: unknown): string {
  const code =
    err instanceof HttpErrorResponse
      ? ((err.error as { error?: { code?: string } } | null)?.error?.code ?? null)
      : null;
  switch (code) {
    case 'GRANT_CONFLICT':
      return $localize`:@@vendor.seats.invite.error.duplicate:That address already has a pending invite. It's sitting in their inbox.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.seats.invite.error.rate:You've sent a lot of invites today. Try again tomorrow.`;
    case 'FORBIDDEN':
      return $localize`:@@vendor.seats.invite.error.forbidden:Only an account owner can invite colleagues.`;
    default:
      return $localize`:@@vendor.seats.invite.error.generic:Could not send that invite. Try again.`;
  }
}
