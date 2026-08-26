import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, input, signal } from '@angular/core';

import type { VendorSeat, VendorSeatInvite } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorSeatInviteForm } from './vendor-seat-invite-form';

/**
 * Read-only seat roster for the vendor dashboard (AECI-522). Multi-seat is flat
 * at launch (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6 / `STAGE_2_SPEC.md` §8.1(2)):
 * every seat is equal, each was granted by AECi, and self-serve invite/revoke is
 * deferred — so this list is read-only.
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
  imports: [DatePipe, VendorSeatInviteForm],
  template: `
    @if (canManage()) {
      <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.seats.intro.owner">
        Everyone with access to this vendor. You can invite colleagues on your company's email
        domain, and remove access when someone leaves.
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
                  <ng-container i18n="@@vendor.seats.pending.expires">Expires</ng-container>
                  {{ invite.expires_at | date: 'mediumDate' }}
                  @if (invite.invited_by; as by) {
                    <ng-container i18n="@@vendor.seats.pending.by">· invited by</ng-container>
                    {{ by }}
                  }
                </p>
              </div>
              @if (canManage()) {
                <button
                  type="button"
                  [disabled]="busyInvite() === invite.id"
                  (click)="revoke(invite)"
                  [class]="dangerClass"
                >
                  <span i18n="@@vendor.seats.pending.revoke">Revoke</span>
                  <span class="sr-only">{{ invite.email }}</span>
                </button>
              }
            </li>
          }
        </ul>
      </section>
    }

    @if (canManage()) {
      <aec-vendor-seat-invite-form />
    }

    @if (actionError(); as message) {
      <p class="mt-3 text-sm text-(--text-primary)" role="alert">{{ message }}</p>
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
  protected readonly busyInvite = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
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
  protected async revoke(invite: VendorSeatInvite): Promise<void> {
    if (this.busyInvite()) return;
    this.busyInvite.set(invite.id);
    this.actionError.set(null);
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
}
