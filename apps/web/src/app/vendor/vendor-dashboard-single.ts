import { Component, input } from '@angular/core';

import type { VendorMeResponse } from '@aeci/shared';

import { VendorProfileForm } from './components/vendor-profile-form';
import { VendorProductsSection } from './components/vendor-products-section';
import { VendorRequestStatus } from './components/vendor-request-status';
import { VendorSeatRoster } from './components/vendor-seat-roster';
import { VendorVerifiedStatus } from './components/vendor-verified-status';

/**
 * Concept B — the single-page vendor dashboard (AECI-522): the whole surface on
 * one scroll (status → profile → products → seats). Presentational only: it
 * takes the `GET /api/vendor/me` payload as an input and composes the shared
 * vendor components. Both the dev-only preview and the real gated `/vendor` page
 * can render it, so the concept the PO reviews is the concept that ships.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-dashboard-single',
  imports: [
    VendorVerifiedStatus,
    VendorRequestStatus,
    VendorProfileForm,
    VendorProductsSection,
    VendorSeatRoster,
  ],
  template: `
    @let m = me();
    <div class="mx-auto w-full max-w-4xl px-6 py-10 md:px-8">
      <header class="border-b border-(--border-default) pb-6">
        <p class="aec-overline text-(--text-secondary)" i18n="@@vendor.eyebrow">Vendor</p>
        <div class="mt-2 flex flex-wrap items-start justify-between gap-4">
          <h1
            class="font-display text-3xl font-semibold tracking-tight text-(--text-primary) md:text-4xl"
          >
            {{ m.vendor.company_name }}
          </h1>
          <aec-vendor-verified-status [verified]="m.vendor.verified" />
        </div>
      </header>

      <div class="mt-10 space-y-14">
        <section aria-labelledby="vendor-requests-heading">
          <h2
            id="vendor-requests-heading"
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.section.requests"
          >
            Claim &amp; correction status
          </h2>
          <div class="mt-4">
            <aec-vendor-request-status [requests]="m.requests" />
          </div>
        </section>

        <section aria-labelledby="vendor-profile-heading">
          <h2
            id="vendor-profile-heading"
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.section.profile"
          >
            Vendor profile
          </h2>
          <div class="mt-4">
            <aec-vendor-profile-form [vendor]="m.vendor" />
          </div>
        </section>

        <section aria-labelledby="vendor-products-heading">
          <h2
            id="vendor-products-heading"
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.section.products"
          >
            Your products
          </h2>
          <div class="mt-4">
            <aec-vendor-products-section [products]="m.products" />
          </div>
        </section>

        <section aria-labelledby="vendor-seats-heading">
          <h2
            id="vendor-seats-heading"
            class="font-display text-xl font-semibold text-(--text-primary)"
          >
            <span i18n="@@vendor.section.seats">Seats</span>
            <span class="text-(--text-secondary)">({{ m.seat_count }})</span>
          </h2>
          <div class="mt-4">
            <aec-vendor-seat-roster [seatCount]="m.seat_count" />
          </div>
        </section>
      </div>
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorDashboardSingle {
  readonly me = input.required<VendorMeResponse>();
}
