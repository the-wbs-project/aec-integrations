import { Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';

import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * The invite form on the Seats section (AECI-664 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a) — owner-only, one address at a time.
 *
 * ── WHY THE ERRORS GET INDIVIDUAL COPY ──────────────────────────────────────
 * Every refusal this endpoint can return is ACTIONABLE, and a generic "something
 * went wrong" would waste that. A domain mismatch has a specific next step (the
 * public claim form) that the person typing cannot guess; a duplicate means the
 * invite is already sitting in their colleague's inbox, which changes what they
 * do next from "retry" to "go ask them"; a rate limit is temporary and needs to
 * say so. Mapping the codes is the difference between a form that explains
 * itself and one that makes people email support.
 *
 * Pessimistic, not optimistic: `STAGE_2_REALTIME_SPEC.md` keeps forms
 * pessimistic on purpose (only toggles are optimistic), and an invite that
 * appeared in the list and then vanished would leave the owner unsure whether
 * their colleague was mailed.
 */
@Component({
  selector: 'aec-vendor-seat-invite-form',
  template: `
    <form
      class="mt-6 rounded-(--radius-md) border border-(--border-default) p-4"
      (submit)="submit($event)"
    >
      <h3
        class="font-label text-sm font-semibold text-(--text-primary)"
        i18n="@@vendor.seats.invite.heading"
      >
        Invite a colleague
      </h3>
      <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@vendor.seats.invite.hint">
        Use their work email on your company's domain. They'll get a link, and the seat is added
        when they sign in.
      </p>

      <div class="mt-3 flex flex-wrap items-start gap-2">
        <div class="min-w-[16rem] flex-1">
          <label class="sr-only" for="seat-invite-email" i18n="@@vendor.seats.invite.label">
            Work email
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
            class="w-full rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          />
        </div>
        <button
          type="submit"
          [disabled]="busy() || email().trim().length === 0"
          class="rounded-(--radius-sm) border border-(--accent-primary) bg-(--accent-primary) px-3 py-2 text-sm font-label font-semibold text-(--surface-base) transition-opacity disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        >
          @if (busy()) {
            <span i18n="@@vendor.seats.invite.sending">Sending…</span>
          } @else {
            <span i18n="@@vendor.seats.invite.submit">Send invite</span>
          }
        </button>
      </div>

      @if (error(); as message) {
        <p id="seat-invite-error" class="mt-2 text-sm text-(--text-primary)" role="alert">
          {{ message }}
        </p>
      }
      @if (sentTo(); as address) {
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
    case 'INVITE_DOMAIN_MISMATCH':
      return $localize`:@@vendor.seats.invite.error.domain:That address isn't on your company's domain. Ask them to open your listing and choose "Request access to this listing", and we'll review it.`;
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
