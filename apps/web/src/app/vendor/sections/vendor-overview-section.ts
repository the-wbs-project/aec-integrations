import { Component, computed, inject } from '@angular/core';

import { VendorPlanPanel } from '../components/vendor-plan-panel';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/overview` — the portal's landing section: verification state, the three
 * headline counts, and the state of any claim/correction against this vendor.
 *
 * Lifted out of `vendor-dashboard-tabbed.ts`'s `@switch` when the portal moved
 * onto real child routes, so "which section am I on" is a URL rather than a
 * signal (back/forward, deep links, and a shareable address all follow from
 * that). The markup is unchanged; only its owner moved.
 *
 * Data comes from {@link VendorPortalStore}, not from an input or a resolver:
 * the portal's one authenticated read lives on the parent route, and reading the
 * store is what makes the AECI-631 entitlement flip land here without a reload.
 */
@Component({
  selector: 'aec-vendor-overview-section',
  imports: [VendorPlanPanel],
  template: `
    @if (me(); as m) {
      <div class="space-y-8">
        <div>
          <h2
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.section.verification"
          >
            Verification
          </h2>
          <div class="mt-4">
            <aec-vendor-plan-panel [entitlement]="m.entitlement" />
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
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorOverviewSection {
  protected readonly me = inject(VendorPortalStore).me;

  protected readonly openRequests = computed(
    () =>
      this.me()?.requests.filter((r) => r.status === 'open' || r.status === 'in_review').length ??
      0,
  );
}
