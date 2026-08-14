import { Component, computed, effect, inject, signal } from '@angular/core';

import type { VendorSeat } from '@aeci/shared';

import { VendorDashboardSingle } from '../../vendor/vendor-dashboard-single';
import { VendorDashboardTabbed } from '../../vendor/vendor-dashboard-tabbed';
import { VendorApi } from '../../vendor/vendor-api';
import {
  VENDOR_ME_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
  VENDOR_SEATS_FIXTURE,
} from '../../vendor/vendor-fixtures';
import { PreviewVendorApi } from './preview-vendor-api';

type Concept = 'a' | 'b';
type FixtureKey = 'verified' | 'unverified';

/** A single-seat roster for the unverified/new-vendor fixture. */
const SINGLE_SEAT_FIXTURE: readonly VendorSeat[] = [
  {
    user_id: '00000000-0000-4000-8000-0000000052c1',
    display_name: 'Sam Okafor',
    email: 'sam@northwind.example.com',
    banned: false,
    created_at: '2026-07-10T12:00:00.000Z',
  },
];

/**
 * Dev-only preview for the AECI-522 vendor dashboard. It renders the TWO
 * information-architecture concepts as live-toggleable options so the PO can
 * choose one in the running app before it's wired into the real gated `/vendor`
 * route (the `unified-home-preview` precedent, AECI-270 / `docs/design/LESSONS.md`
 * "build all and then I chose"):
 *
 *   - **a · Tabbed** — a side-nav over one panel (Overview / Profile / Products /
 *     Seats). Focused surfaces; scales to more sections later.
 *   - **b · Single page** — the whole surface on one scroll. Fewer clicks; longer
 *     page.
 *
 * A second toggle swaps a verified multi-seat vendor for an unverified new one so
 * both verification and empty states can be reviewed. The real dashboard
 * components are used verbatim — only the {@link VendorApi} is shadowed with a
 * fixture-backed fake ({@link PreviewVendorApi}) so edits are exercisable without
 * a session. Route: `/preview/vendor-dashboard`, production-blocked by
 * `isPreviewPath`. Don't link to it from product navigation.
 */
@Component({
  selector: 'app-vendor-dashboard-preview',
  imports: [VendorDashboardTabbed, VendorDashboardSingle],
  providers: [PreviewVendorApi, { provide: VendorApi, useExisting: PreviewVendorApi }],
  template: `
    <!-- Dev-only concept switcher. Not part of the surface under review. -->
    <div
      class="sticky top-0 z-40 border-b border-(--border-default) bg-(--surface-sunken)"
      role="region"
      aria-label="Concept switcher (dev only)"
    >
      <div class="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-3 md:px-8">
        <div class="flex flex-wrap items-center gap-2">
          <span class="aec-overline text-(--text-secondary)">AECI-522 concept</span>
          <button
            type="button"
            [class]="tabClass(concept() === 'a')"
            [attr.aria-pressed]="concept() === 'a'"
            (click)="concept.set('a')"
          >
            a · Tabbed
          </button>
          <button
            type="button"
            [class]="tabClass(concept() === 'b')"
            [attr.aria-pressed]="concept() === 'b'"
            (click)="concept.set('b')"
          >
            b · Single page
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="aec-overline text-(--text-secondary)">Fixture</span>
          <button
            type="button"
            [class]="tabClass(fixture() === 'verified')"
            [attr.aria-pressed]="fixture() === 'verified'"
            (click)="fixture.set('verified')"
          >
            Verified · multi-seat
          </button>
          <button
            type="button"
            [class]="tabClass(fixture() === 'unverified')"
            [attr.aria-pressed]="fixture() === 'unverified'"
            (click)="fixture.set('unverified')"
          >
            Unverified · new
          </button>
        </div>
      </div>
    </div>

    <div class="bg-(--surface-base)">
      @switch (concept()) {
        @case ('a') {
          <aec-vendor-dashboard-tabbed [me]="activeMe()" />
        }
        @case ('b') {
          <aec-vendor-dashboard-single [me]="activeMe()" />
        }
      }
    </div>
  `,
})
export class VendorDashboardPreview {
  private readonly previewApi = inject(PreviewVendorApi);

  protected readonly concept = signal<Concept>('a');
  protected readonly fixture = signal<FixtureKey>('verified');

  protected readonly activeMe = computed(() =>
    this.fixture() === 'verified' ? VENDOR_ME_FIXTURE : VENDOR_ME_UNVERIFIED_FIXTURE,
  );

  private readonly activeSeats = computed(() =>
    this.fixture() === 'verified' ? VENDOR_SEATS_FIXTURE : SINGLE_SEAT_FIXTURE,
  );

  constructor() {
    // Keep the fixture-backed fake pointed at whichever fixture is on screen, so
    // the seat roster + product saves operate on matching data.
    effect(() => this.previewApi.setFixture(this.activeMe(), this.activeSeats()));
  }

  protected tabClass(active: boolean): string {
    const base =
      'rounded-(--radius-sm) border px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return active
      ? `${base} border-(--accent-primary) text-(--accent-primary)`
      : `${base} border-(--border-default) text-(--text-secondary) hover:text-(--text-primary)`;
  }
}
