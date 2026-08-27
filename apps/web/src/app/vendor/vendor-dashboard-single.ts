import { Component, computed, inject, input } from '@angular/core';

import type { VendorMeResponse } from '@aeci/shared';
import type { Capability } from '@aeci/shared/entitlements';

import { VendorPortalAnnouncer } from './vendor-announcer';
import { VendorIntegrationsSection } from './components/vendor-integrations-section';
import { VendorPlanPanel } from './components/vendor-plan-panel';
import { VendorProfileForm } from './components/vendor-profile-form';
import { VendorProductsSection } from './components/vendor-products-section';
import { VendorNotificationsList } from './components/vendor-notifications-list';
import { VendorRequestStatus } from './components/vendor-request-status';
import { VendorSeatInviteDialog } from './components/vendor-seat-invite-dialog';
import { VendorSeatRoster } from './components/vendor-seat-roster';

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
    VendorPlanPanel,
    VendorNotificationsList,
    VendorRequestStatus,
    VendorProfileForm,
    VendorProductsSection,
    VendorIntegrationsSection,
    VendorSeatInviteDialog,
    VendorSeatRoster,
  ],
  template: `
    @let m = me();
    <div class="mx-auto w-full max-w-4xl px-6 py-10 md:px-8">
      <header class="border-b border-(--border-default) pb-6">
        <p class="aec-overline text-(--text-secondary)" i18n="@@vendor.eyebrow">Vendor</p>
        <h1
          class="mt-2 font-display text-3xl font-semibold tracking-tight text-(--text-primary) md:text-4xl"
        >
          {{ m.vendor.company_name }}
        </h1>
      </header>

      <div class="mt-10 space-y-14">
        <section aria-labelledby="vendor-verification-heading">
          <h2
            id="vendor-verification-heading"
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.section.verification"
          >
            Verification
          </h2>
          <div class="mt-4">
            <aec-vendor-plan-panel [entitlement]="m.entitlement" />
          </div>
        </section>

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
            <aec-vendor-profile-form [vendor]="m.vendor" [canEdit]="canEditProfile()" />
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
            <aec-vendor-products-section
              [products]="m.products"
              [canEdit]="canEditProducts()"
              [canEditTaxonomy]="canEditTaxonomy()"
            />
          </div>
        </section>

        <section aria-labelledby="vendor-integrations-heading">
          <h2
            id="vendor-integrations-heading"
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.section.integrations"
          >
            Integrations
          </h2>
          <div class="mt-4 space-y-6">
            <!--
              Rendered explicitly here (AECI-666). It used to live INSIDE
              vendor-integrations-section.ts; on the tabbed concept it moved to
              the Messages section, which this single-page concept has no
              equivalent of. Without this line the concept would silently lose a
              surface the tabbed one has, which is the thing AECI-606 added it to
              both concepts to prevent. Leaving contextProductId unset likewise
              keeps the vendor-wide list this concept is built around.
            -->
            <aec-vendor-notifications-list />
            <aec-vendor-integrations-section
              [verified]="m.vendor.verified"
              [vendorName]="m.vendor.company_name"
            />
          </div>
        </section>

        <section aria-labelledby="vendor-seats-heading">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="vendor-seats-heading"
              class="font-display text-xl font-semibold text-(--text-primary)"
            >
              <span i18n="@@vendor.section.seats">Seats</span>
              <span class="text-(--text-secondary)">({{ m.seat_count }})</span>
            </h2>
            <!-- Owner-only; renders nothing for a member seat. -->
            <aec-vendor-seat-invite-dialog />
          </div>
          <div class="mt-4">
            <aec-vendor-seat-roster [seatCount]="m.seat_count" />
          </div>
        </section>
      </div>

      <!--
        THE portal's live region for this concept, mirroring the tabbed shell's
        (AECI-631 / §6.3). Concept B has no @switch destroying sections, but it
        still composes VendorIntegrationsSection, which announces through
        VendorPortalAnnouncer and declares no region of its own. Without this the
        announcements would have nowhere to land and every attestation write on
        Concept B would be silent to a screen reader.

        Exactly one, polite, sr-only, always in the DOM so a message is a
        mutation rather than an insertion. Only ever one of the two concepts is
        rendered at a time, so this cannot race the tabbed shell's.
      -->
      <p class="sr-only" role="status">{{ liveMessage() }}</p>
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorDashboardSingle {
  readonly me = input.required<VendorMeResponse>();

  /** The single live region's text (§6.3), same channel the tabbed shell reads.
   *  Read-only here: the concept renders the channel, it does not decide what
   *  goes into it. */
  protected readonly liveMessage = inject(VendorPortalAnnouncer).message;

  /** Same §8 capability gate as the tabbed shell, so the two concepts cannot
   *  disagree about what a lapsed vendor may edit. */
  private readonly capabilities = computed<readonly Capability[]>(
    () => this.me().entitlement.capabilities,
  );
  protected readonly canEditProfile = computed(() => this.capabilities().includes('profile.edit'));
  protected readonly canEditProducts = computed(() => this.capabilities().includes('product.edit'));
  protected readonly canEditTaxonomy = computed(() =>
    this.capabilities().includes('product.taxonomy.edit'),
  );
}
