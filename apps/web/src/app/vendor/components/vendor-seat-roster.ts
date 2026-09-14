import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, input, signal } from '@angular/core';

import type { ManageableSeatInvite, VendorSeat } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * The seat roster for the vendor dashboard (AECI-522). Multi-seat is flat at
 * launch (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6 / `STAGE_2_SPEC.md` §8.1(2)): data
 * capabilities are identical across seats, and the only owner/member split is
 * seat management itself (§11a.4).
 *
 * ── WHAT LIVES HERE, AND WHAT DOESN'T ───────────────────────────────────────
 * This renders the roster, the pending-invite list, and the three actions an
 * owner has over them: remove a seat, revoke an invite, and re-send one
 * (AECI-927). **Creating** an invite does not live here — it is
 * {@link VendorSeatInviteDialog}, triggered from the section heading, so the list
 * people come here to read isn't sitting under a permanent form. Both surfaces
 * gate on the same `canManageSeats` flag.
 *
 * Re-send belongs here and not in the dialog for the same reason: it acts on a
 * row that is already on screen, and the thing the owner needs in order to decide
 * — when it last went out — is the line right beside the button.
 *
 * The roster is a **separate** browser read (`GET /api/vendor/seats`) from the
 * dashboard payload because it needs the Supabase email lookup and the first
 * paint shouldn't wait on it. `email` degrades to `null` in local/preview
 * environments (no service-role key), rendered as "email unavailable" — never an
 * error. A banned seat still appears (per-seat ban never touches the vendor's
 * verified state, §7) so co-admins can see why a colleague is locked out.
 *
 * ── STATE (AECI-628) ────────────────────────────────────────────────────────
 * The list, its load state and its retry all live in {@link VendorPortalStore}
 * now; this component only renders them. It used to hold them itself, which
 * meant the seats vanished and re-fetched every time the tab was switched away
 * and back (the `@switch` destroys the component), and meant a revalidation loop
 * had no way to reach them. `ensure()` is load-once, so re-entering the tab is
 * free and the poll (AECI-629) refreshes what is already on screen.
 *
 * Browser-only: `ensure()` is called from `afterNextRender`, so SSR paints the
 * loading state and no visitor data is ever baked into cached HTML.
 */
@Component({
  selector: 'aec-vendor-seat-roster',
  imports: [DatePipe],
  template: `
    @if (canManage()) {
      <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.seats.intro.owner">
        Everyone with access to this vendor. You can invite anyone who helps maintain this listing,
        and remove access when someone leaves.
      </p>
    } @else {
      <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.seats.intro.member">
        Everyone with access to this vendor. Ask an account owner (listed below) to add or remove a
        colleague.
      </p>
    }

    @if (loading()) {
      <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@vendor.seats.loading">
        Loading seats…
      </p>
    } @else if (failed()) {
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <p class="text-sm text-(--text-primary)" i18n="@@vendor.seats.error">
          Could not load the seat list.
        </p>
        <button type="button" [class]="retryClass" (click)="reload()" i18n="@@vendor.seats.retry">
          Try again
        </button>
      </div>
    } @else if (seats().length === 0) {
      <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@vendor.seats.empty">
        No seats to show.
      </p>
    } @else {
      <div class="mt-4 overflow-x-auto">
        <table class="w-full min-w-[32rem] border-collapse text-start text-sm">
          <caption class="sr-only" i18n="@@vendor.seats.caption">
            Vendor seats
          </caption>
          <thead>
            <tr class="border-b border-(--border-default) text-(--text-secondary)">
              <th
                scope="col"
                class="py-2 pe-4 font-label font-semibold"
                i18n="@@vendor.seats.col.name"
              >
                Name
              </th>
              <th
                scope="col"
                class="py-2 pe-4 font-label font-semibold"
                i18n="@@vendor.seats.col.email"
              >
                Email
              </th>
              <th
                scope="col"
                class="py-2 pe-4 font-label font-semibold"
                i18n="@@vendor.seats.col.status"
              >
                Status
              </th>
              <th
                scope="col"
                class="py-2 pe-4 font-label font-semibold"
                i18n="@@vendor.seats.col.added"
              >
                Added
              </th>
              @if (canManage()) {
                <th scope="col" class="py-2 font-label font-semibold">
                  <span class="sr-only" i18n="@@vendor.seats.col.actions">Actions</span>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (seat of seats(); track seat.user_id) {
              <tr class="border-b border-(--border-default) last:border-0">
                <td class="py-3 pe-4 text-(--text-primary)">
                  {{ seat.display_name || fallbackName }}
                  @if (seat.is_self) {
                    <span class="text-(--text-secondary)" i18n="@@vendor.seats.you">(you)</span>
                  }
                  @if (seat.owner) {
                    <span
                      class="ms-1 text-xs text-(--text-secondary)"
                      i18n="@@vendor.seats.ownerLabel"
                      >Owner</span
                    >
                  }
                </td>
                <td class="py-3 pe-4 text-(--text-secondary)">
                  {{ seat.email || emailUnavailable }}
                </td>
                <td class="py-3 pe-4">
                  <span
                    class="inline-flex items-center rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]"
                    [class]="
                      seat.banned
                        ? 'border-(--border-strong) bg-(--surface-raised) text-(--text-primary)'
                        : 'border-(--accent-primary) bg-(--surface-raised) text-(--accent-primary)'
                    "
                  >
                    @if (seat.banned) {
                      <span i18n="@@vendor.seats.status.banned">Banned</span>
                    } @else {
                      <span i18n="@@vendor.seats.status.active">Active</span>
                    }
                  </span>
                </td>
                <td class="py-3 pe-4 text-(--text-secondary)">
                  {{ seat.created_at | date: 'mediumDate' }}
                </td>
                @if (canManage()) {
                  <td class="py-3 text-end">
                    @if (!seat.is_self) {
                      <button
                        type="button"
                        [disabled]="busySeat() === seat.user_id"
                        (click)="remove(seat)"
                        [class]="dangerClass"
                      >
                        <span i18n="@@vendor.seats.remove">Remove</span>
                        <span class="sr-only">{{
                          seat.display_name || seat.email || fallbackName
                        }}</span>
                      </button>
                    }
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    }

    @if (invites().length > 0) {
      <section class="mt-6">
        <h3
          class="font-label text-sm font-semibold text-(--text-primary)"
          i18n="@@vendor.seats.pending.heading"
        >
          Pending invites
        </h3>
        <ul class="mt-2 divide-y divide-(--border-default) border-y border-(--border-default)">
          @for (invite of invites(); track invite.id) {
            <li class="flex flex-wrap items-center justify-between gap-3 py-3">
              <div class="min-w-0">
                <p class="text-sm text-(--text-primary)">{{ invite.email }}</p>
                <p class="text-xs text-(--text-secondary)">
                  <ng-container i18n="@@vendor.seats.pending.sent">Sent</ng-container>
                  {{ invite.last_sent_at || invite.created_at | date: 'mediumDate' }}
                  <ng-container i18n="@@vendor.seats.pending.expires">· expires</ng-container>
                  {{ invite.expires_at | date: 'mediumDate' }}
                  @if (invite.invited_by; as by) {
                    <ng-container i18n="@@vendor.seats.pending.by">· invited by</ng-container>
                    {{ by }}
                  }
                </p>
              </div>
              @if (canManage()) {
                <div class="flex shrink-0 items-center gap-2">
                  <!-- Disabled states carry their reason in the accessible name,
                       not just in the visual state: a cooldown clears itself in
                       minutes, a spent invite never does, and the two need
                       opposite next steps. -->
                  <button
                    type="button"
                    [disabled]="busyInvite() !== null || invite.resend_state !== 'ok'"
                    (click)="resend(invite)"
                    [class]="dangerClass"
                    [attr.title]="resendHint(invite)"
                  >
                    @if (isBusy(invite, 'resend')) {
                      <span i18n="@@vendor.seats.pending.resending">Sending…</span>
                    } @else {
                      <span i18n="@@vendor.seats.pending.resend">Resend</span>
                    }
                    <span class="sr-only">{{ invite.email }}{{ resendHintSuffix(invite) }}</span>
                  </button>
                  <button
                    type="button"
                    [disabled]="busyInvite()?.id === invite.id"
                    (click)="revoke(invite)"
                    [class]="dangerClass"
                  >
                    <span i18n="@@vendor.seats.pending.revoke">Revoke</span>
                    <span class="sr-only">{{ invite.email }}</span>
                  </button>
                </div>
              }
            </li>
          }
        </ul>
      </section>
    }

    @if (actionError(); as message) {
      <p class="mt-3 text-sm text-(--text-primary)" role="alert">{{ message }}</p>
    }
    @if (actionStatus(); as message) {
      <p class="mt-3 text-sm text-(--text-secondary)" role="status">{{ message }}</p>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorSeatRoster {
  private readonly store = inject(VendorPortalStore);

  /** The seat count from the dashboard payload — shown by the parent as a
   *  header; the detailed roster loads separately. Optional so the component is
   *  usable standalone. */
  readonly seatCount = input<number | null>(null);

  private readonly api = inject(VendorApi);

  protected readonly seats = this.store.seats;
  protected readonly invites = this.store.seatInvites;
  /** The SERVER's verdict on `profiles.seat_owner` for this caller — never
   *  re-derived from the roster. Hiding a control the API would 403 and showing
   *  one it would accept have to come from the same source. */
  protected readonly canManage = this.store.canManageSeats;
  protected readonly busySeat = signal<string | null>(null);
  /** The invite action in flight, if any — the id AND which action, not the id
   *  alone. Both actions are mutually exclusive over the whole list, so the id by
   *  itself cannot say what is happening to that row: a revoke would put the
   *  neighbouring Resend button into its "Sending…" state, including on a row
   *  whose `resend_state` makes a send impossible. */
  protected readonly busyInvite = signal<{ id: string; action: 'resend' | 'revoke' } | null>(null);
  protected readonly actionError = signal<string | null>(null);
  /** The success half of {@link actionError} — a `role="status"` line, so a
   *  re-send that produces no visible list change is still announced. Kept
   *  separate rather than reusing the error signal so the two can never end up
   *  in the same live region with the wrong politeness. */
  protected readonly actionStatus = signal<string | null>(null);
  protected readonly loading = this.store.seatsLoading;
  protected readonly failed = this.store.seatsFailed;

  /** True once the fetch settled with at least one seat — lets the parent hide a
   *  redundant count while the table is visible. */
  readonly loaded = computed(() => !this.loading() && !this.failed());

  protected readonly fallbackName = $localize`:@@vendor.seats.name.fallback:Unnamed admin`;
  protected readonly emailUnavailable = $localize`:@@vendor.seats.email.unavailable:Email unavailable`;

  protected readonly dangerClass =
    'rounded-(--radius-sm) border border-(--border-default) px-2.5 py-1 text-xs font-label text-(--text-primary) transition-colors hover:border-(--border-strong) disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    // Browser-only: the seat read (with its Supabase email lookup) runs after
    // hydration, so cached SSR HTML never carries visitor data.
    afterNextRender(() => void this.store.ensure('seats'));
  }

  /** The retry beside the failure state. `reload` rather than `ensure` because
   *  the store has already recorded an attempt. */
  protected reload(): void {
    void this.store.reload('seats');
  }

  /**
   * Remove a colleague's access. Pessimistic and re-read from the server rather
   * than spliced locally: this is a destructive, security-relevant action, and a
   * row that vanished optimistically and then came back would leave an owner
   * unsure whether the person still has access. `STAGE_2_REALTIME_SPEC.md` keeps
   * optimism for toggles only.
   *
   * No `confirm()` — a browser modal blocks the whole page and the action is
   * reversible by re-inviting. The button names the person in its accessible
   * label so it can't be hit blind.
   */
  protected async remove(seat: VendorSeat): Promise<void> {
    if (this.busySeat()) return;
    this.busySeat.set(seat.user_id);
    this.actionError.set(null);
    this.actionStatus.set(null);
    try {
      await this.api.removeSeat(seat.user_id);
      await this.store.reload('seats');
    } catch {
      this.actionError.set(
        $localize`:@@vendor.seats.remove.error:Could not remove that seat. Try again.`,
      );
    } finally {
      this.busySeat.set(null);
    }
  }

  /** Revoke a pending invite before it is redeemed. */
  protected async revoke(invite: ManageableSeatInvite): Promise<void> {
    if (this.busyInvite()) return;
    this.busyInvite.set({ id: invite.id, action: 'revoke' });
    this.actionError.set(null);
    this.actionStatus.set(null);
    try {
      await this.api.revokeInvite(invite.id);
      await this.store.reload('seats');
    } catch {
      this.actionError.set(
        $localize`:@@vendor.seats.revoke.error:Could not revoke that invite. Try again.`,
      );
    } finally {
      this.busyInvite.set(null);
    }
  }

  /**
   * Mail a pending invite again (AECI-927). Same link, refreshed expiry.
   *
   * Pessimistic and re-read, like every other write on this surface: the visible
   * change is a "Sent" date and a now-disabled button, and guessing either
   * locally would mean re-implementing the cooldown the server just applied.
   *
   * The confirmation is a `role="status"` line rather than the list itself,
   * because a successful re-send moves no row — without it the only feedback
   * would be a button going quiet, which reads like a failure.
   */
  protected async resend(invite: ManageableSeatInvite): Promise<void> {
    if (this.busyInvite() || invite.resend_state !== 'ok') return;
    this.busyInvite.set({ id: invite.id, action: 'resend' });
    this.actionError.set(null);
    this.actionStatus.set(null);
    try {
      await this.api.resendInvite(invite.id);
      this.actionStatus.set(
        $localize`:@@vendor.seats.resend.sent:Invite sent again to ${invite.email}:email:.`,
      );
      // The server's row, not a local splice: it holds the new expiry and the
      // cooldown verdict that disables the button.
      await this.store.reload('seats');
    } catch (err) {
      this.actionError.set(resendErrorFor(err));
    } finally {
      this.busyInvite.set(null);
    }
  }

  /** Is THIS action in flight on THIS invite? The action matters: a revoke and a
   *  re-send both hold the row, and only one of them is a send. */
  protected isBusy(invite: ManageableSeatInvite, action: 'resend' | 'revoke'): boolean {
    const busy = this.busyInvite();
    return busy?.id === invite.id && busy.action === action;
  }

  /** Why the Resend control is disabled, or `null` when it is not. Rendered as
   *  `title` and appended to the accessible name — a disabled button whose reason
   *  is invisible is a dead end, and the two reasons need opposite next steps. */
  protected resendHint(invite: ManageableSeatInvite): string | null {
    switch (invite.resend_state) {
      case 'cooling_down':
        return $localize`:@@vendor.seats.resend.hint.cooling:This invite was sent recently. You can send it again in a few minutes.`;
      case 'send_limit':
        return $localize`:@@vendor.seats.resend.hint.limit:This invite has been sent the maximum number of times. Revoke it and invite them again.`;
      default:
        return null;
    }
  }

  /** The hint as a screen-reader suffix, so the disabled button's accessible name
   *  carries the reason. Empty when the control is available. */
  protected resendHintSuffix(invite: ManageableSeatInvite): string {
    const hint = this.resendHint(invite);
    return hint ? `. ${hint}` : '';
  }
}

/** Map the re-send refusals onto copy that says what to do next — the same
 *  discipline as `vendor-seat-invite-form.ts`. The two 4xx here are genuinely
 *  different advice: a cooldown resolves by waiting, a spent invite never does. */
function resendErrorFor(err: unknown): string {
  const code =
    err instanceof HttpErrorResponse
      ? ((err.error as { error?: { code?: string } } | null)?.error?.code ?? null)
      : null;
  switch (code) {
    case 'RATE_LIMITED':
      return $localize`:@@vendor.seats.resend.error.rate:That invite was just sent. Give it a few minutes.`;
    case 'INVALID_STATE_TRANSITION':
      return $localize`:@@vendor.seats.resend.error.limit:That invite has been sent the maximum number of times. Revoke it and invite them again.`;
    case 'FORBIDDEN':
      return $localize`:@@vendor.seats.resend.error.forbidden:Only an account owner can manage seats.`;
    case 'NOT_FOUND':
      return $localize`:@@vendor.seats.resend.error.gone:That invite is no longer pending. Refresh the list.`;
    default:
      return $localize`:@@vendor.seats.resend.error.generic:Could not send that invite again. Try again.`;
  }
}
