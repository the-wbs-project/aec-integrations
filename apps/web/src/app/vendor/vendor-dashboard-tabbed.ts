import { Component, computed, input, signal } from '@angular/core';

import type { VendorMeResponse } from '@aeci/shared';

import { VendorIntegrationsSection } from './components/vendor-integrations-section';
import { VendorProfileForm } from './components/vendor-profile-form';
import { VendorProductsSection } from './components/vendor-products-section';
import { VendorRequestStatus } from './components/vendor-request-status';
import { VendorSeatRoster } from './components/vendor-seat-roster';
import { VendorVerifiedStatus } from './components/vendor-verified-status';

type Tab = 'overview' | 'profile' | 'products' | 'integrations' | 'seats';

/**
 * Concept A — the tabbed vendor dashboard (AECI-522): a side-nav (Overview /
 * Profile / Products / Seats) over a single content panel, modelled on the admin
 * shell but switched in-page (no child routes) so the same component renders both
 * in the dev-only preview and on the real gated `/vendor` page. Presentational
 * only — it takes the `GET /api/vendor/me` payload as an input.
 *
 * The nav is a set of buttons that swap the visible section (each with its own
 * heading); the active button carries `aria-current="page"`. Light theme only
 * (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-dashboard-tabbed',
  imports: [
    VendorVerifiedStatus,
    VendorRequestStatus,
    VendorProfileForm,
    VendorProductsSection,
    VendorIntegrationsSection,
    VendorSeatRoster,
  ],
  template: `
    @let m = me();
    <section class="mx-auto w-full max-w-7xl px-6 py-10 md:px-8">
      <header class="mb-8 border-b border-(--border-default) pb-6">
        <p class="aec-overline text-(--text-secondary)" i18n="@@vendor.eyebrow">Vendor</p>
        <h1
          class="mt-2 font-display text-3xl font-semibold tracking-tight text-(--text-primary) md:text-4xl"
        >
          {{ m.vendor.company_name }}
        </h1>
      </header>

      <div class="grid gap-8 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)]">
        <nav i18n-aria-label="@@vendor.nav.aria" aria-label="Dashboard sections">
          <ul class="space-y-1">
            @for (t of tabs; track t.key) {
              <li>
                <button
                  type="button"
                  (click)="activeTab.set(t.key)"
                  [attr.aria-current]="activeTab() === t.key ? 'page' : null"
                  [class]="navClass(activeTab() === t.key)"
                >
                  {{ t.label }}
                </button>
              </li>
            }
          </ul>
        </nav>

        <div class="min-w-0">
          @switch (activeTab()) {
            @case ('overview') {
              <div class="space-y-8">
                <div>
                  <h2
                    class="font-display text-xl font-semibold text-(--text-primary)"
                    i18n="@@vendor.section.verification"
                  >
                    Verification
                  </h2>
                  <div class="mt-4">
                    <aec-vendor-verified-status [verified]="m.vendor.verified" />
                  </div>
                </div>

                <dl class="grid grid-cols-2 gap-4 sm:grid-cols-3">
                  <div
                    class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4"
                  >
                    <dt
                      class="text-xs uppercase tracking-[0.08em] text-(--text-secondary)"
                      i18n="@@vendor.stat.products"
                    >
                      Products
                    </dt>
                    <dd class="mt-1 font-display text-2xl tabular-nums text-(--text-primary)">
                      {{ m.products.length }}
                    </dd>
                  </div>
                  <div
                    class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4"
                  >
                    <dt
                      class="text-xs uppercase tracking-[0.08em] text-(--text-secondary)"
                      i18n="@@vendor.stat.seats"
                    >
                      Seats
                    </dt>
                    <dd class="mt-1 font-display text-2xl tabular-nums text-(--text-primary)">
                      {{ m.seat_count }}
                    </dd>
                  </div>
                  <div
                    class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4"
                  >
                    <dt
                      class="text-xs uppercase tracking-[0.08em] text-(--text-secondary)"
                      i18n="@@vendor.stat.openRequests"
                    >
                      Open requests
                    </dt>
                    <dd class="mt-1 font-display text-2xl tabular-nums text-(--text-primary)">
                      {{ openRequests() }}
                    </dd>
                  </div>
                </dl>

                <div>
                  <h2
                    class="font-display text-xl font-semibold text-(--text-primary)"
                    i18n="@@vendor.section.requests"
                  >
                    Claim &amp; correction status
                  </h2>
                  <div class="mt-4">
                    <aec-vendor-request-status [requests]="m.requests" />
                  </div>
                </div>
              </div>
            }
            @case ('profile') {
              <div>
                <h2
                  class="font-display text-xl font-semibold text-(--text-primary)"
                  i18n="@@vendor.section.profile"
                >
                  Vendor profile
                </h2>
                <div class="mt-4">
                  <aec-vendor-profile-form [vendor]="m.vendor" />
                </div>
              </div>
            }
            @case ('products') {
              <div>
                <h2
                  class="font-display text-xl font-semibold text-(--text-primary)"
                  i18n="@@vendor.section.products"
                >
                  Your products
                </h2>
                <div class="mt-4">
                  <aec-vendor-products-section [products]="m.products" />
                </div>
              </div>
            }
            @case ('integrations') {
              <div>
                <h2
                  class="font-display text-xl font-semibold text-(--text-primary)"
                  i18n="@@vendor.section.integrations"
                >
                  Integrations
                </h2>
                <div class="mt-4">
                  <aec-vendor-integrations-section
                    [verified]="m.vendor.verified"
                    [vendorName]="m.vendor.company_name"
                  />
                </div>
              </div>
            }
            @case ('seats') {
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
          }
        </div>
      </div>
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorDashboardTabbed {
  readonly me = input.required<VendorMeResponse>();

  protected readonly activeTab = signal<Tab>('overview');

  protected readonly openRequests = computed(
    () => this.me().requests.filter((r) => r.status === 'open' || r.status === 'in_review').length,
  );

  protected readonly tabs: ReadonlyArray<{ key: Tab; label: string }> = [
    { key: 'overview', label: $localize`:@@vendor.tab.overview:Overview` },
    { key: 'profile', label: $localize`:@@vendor.tab.profile:Profile` },
    { key: 'products', label: $localize`:@@vendor.tab.products:Products` },
    { key: 'integrations', label: $localize`:@@vendor.tab.integrations:Integrations` },
    { key: 'seats', label: $localize`:@@vendor.tab.seats:Seats` },
  ];

  protected navClass(active: boolean): string {
    const base =
      'flex w-full items-center rounded-(--radius-md) px-3 py-2 text-start text-sm font-bold no-underline transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return active
      ? `${base} bg-(--surface-raised) text-(--text-primary)`
      : `${base} text-(--text-secondary) hover:text-(--text-primary)`;
  }
}
