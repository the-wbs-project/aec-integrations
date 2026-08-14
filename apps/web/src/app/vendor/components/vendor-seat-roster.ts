import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, input, signal } from '@angular/core';

import type { VendorSeat } from '@aeci/shared';

import { VendorApi } from '../vendor-api';

/**
 * Read-only seat roster for the vendor dashboard (AECI-522). Multi-seat is flat
 * at launch (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6 / `STAGE_2_SPEC.md` §8.1(2)):
 * every seat is equal, each was granted by AECi, and self-serve invite/revoke is
 * deferred — so this list is read-only.
 *
 * The roster is a **separate** browser fetch (`GET /api/vendor/seats`) from the
 * dashboard payload because it needs the Supabase email lookup and the first
 * paint shouldn't wait on it. `email` degrades to `null` in local/preview
 * environments (no service-role key), rendered as "email unavailable" — never an
 * error. A banned seat still appears (per-seat ban never touches the vendor's
 * verified state, §7) so co-admins can see why a colleague is locked out.
 *
 * Browser-only: the fetch runs in `afterNextRender`, so SSR paints the loading
 * state and no visitor data is ever baked into cached HTML.
 */
@Component({
  selector: 'aec-vendor-seat-roster',
  imports: [DatePipe],
  template: `
    <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.seats.intro">
      Everyone with access to this vendor. Seats are added by AEC Integrations; self-serve invites
      are coming later.
    </p>

    @if (loading()) {
      <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@vendor.seats.loading">
        Loading seats…
      </p>
    } @else if (failed()) {
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <p class="text-sm text-(--text-primary)" i18n="@@vendor.seats.error">
          Could not load the seat list.
        </p>
        <button type="button" [class]="retryClass" (click)="load()" i18n="@@vendor.seats.retry">
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
              <th scope="col" class="py-2 font-label font-semibold" i18n="@@vendor.seats.col.added">
                Added
              </th>
            </tr>
          </thead>
          <tbody>
            @for (seat of seats(); track seat.user_id) {
              <tr class="border-b border-(--border-default) last:border-0">
                <td class="py-3 pe-4 text-(--text-primary)">
                  {{ seat.display_name || fallbackName }}
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
                <td class="py-3 text-(--text-secondary)">
                  {{ seat.created_at | date: 'mediumDate' }}
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorSeatRoster {
  private readonly api = inject(VendorApi);

  /** The seat count from the dashboard payload — shown by the parent as a
   *  header; the detailed roster loads separately. Optional so the component is
   *  usable standalone. */
  readonly seatCount = input<number | null>(null);

  protected readonly seats = signal<readonly VendorSeat[]>([]);
  protected readonly loading = signal(true);
  protected readonly failed = signal(false);

  /** True once the fetch settled with at least one seat — lets the parent hide a
   *  redundant count while the table is visible. */
  readonly loaded = computed(() => !this.loading() && !this.failed());

  protected readonly fallbackName = $localize`:@@vendor.seats.name.fallback:Unnamed admin`;
  protected readonly emailUnavailable = $localize`:@@vendor.seats.email.unavailable:Email unavailable`;

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    // Browser-only: the seat fetch (with its Supabase email lookup) runs after
    // hydration, so cached SSR HTML never carries visitor data.
    afterNextRender(() => void this.load());
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.failed.set(false);
    try {
      const res = await this.api.getSeats();
      this.seats.set(res.seats);
    } catch {
      this.failed.set(true);
    } finally {
      this.loading.set(false);
    }
  }
}
