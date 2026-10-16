import { Component, computed, input } from '@angular/core';

import type { VendorBillingLicense } from '@aeci/shared';

/**
 * The Billing tab's summary card (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21): the
 * licenses at a glance, beside the billing email. Counts come from the same
 * `GET /api/vendor/billing` payload the table renders, so the card never
 * disagrees with the rows below it.
 *
 * Only live licenses count (`live`, the stored state). "Unassigned" is a live
 * pool license. "Products on Free" is `assignable_products`: the vendor's products
 * holding no live license from any vendor. It shows only when above zero, as does
 * "Coming off at renewal". When the read is truncated the counts
 * are lower bounds, and the card says so.
 */
@Component({
  selector: 'aec-vendor-billing-summary',
  template: `
    <section
      class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5"
      aria-labelledby="vendor-billing-summary-heading"
      data-testid="billing-summary"
    >
      <h3
        id="vendor-billing-summary-heading"
        class="font-label text-sm font-semibold text-(--text-primary)"
        i18n="@@vendor.billing.summary.heading"
      >
        At a glance
      </h3>
      <dl class="mt-2 divide-y divide-(--border-default) text-sm">
        <div class="flex items-baseline justify-between gap-4 py-2">
          <dt class="text-(--text-secondary)" i18n="@@vendor.billing.summary.total">
            Live licenses
          </dt>
          <dd class="font-semibold text-(--text-primary) tabular-nums" data-testid="summary-total">
            {{ counts().total }}
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-4 py-2">
          <dt class="text-(--text-secondary)" i18n="@@vendor.billing.summary.assigned">
            On a product
          </dt>
          <dd
            class="font-semibold text-(--text-primary) tabular-nums"
            data-testid="summary-assigned"
          >
            {{ counts().assigned }}
          </dd>
        </div>
        <div class="flex items-baseline justify-between gap-4 py-2">
          <dt class="text-(--text-secondary)" i18n="@@vendor.billing.summary.unassigned">
            Unassigned
          </dt>
          <dd
            class="font-semibold text-(--text-primary) tabular-nums"
            data-testid="summary-unassigned"
          >
            {{ counts().unassigned }}
          </dd>
        </div>
        @if (counts().releasing > 0) {
          <div class="flex items-baseline justify-between gap-4 py-2">
            <dt class="text-(--text-secondary)" i18n="@@vendor.billing.summary.releasing">
              Coming off at renewal
            </dt>
            <dd
              class="font-semibold text-(--text-primary) tabular-nums"
              data-testid="summary-releasing"
            >
              {{ counts().releasing }}
            </dd>
          </div>
        }
        @if (productsOnFree() > 0) {
          <div class="flex items-baseline justify-between gap-4 py-2">
            <dt class="text-(--text-secondary)" i18n="@@vendor.billing.summary.onFree">
              Products on Free
            </dt>
            <dd
              class="font-semibold text-(--text-primary) tabular-nums"
              data-testid="summary-on-free"
            >
              {{ productsOnFree() }}
            </dd>
          </div>
        }
      </dl>
      @if (truncated()) {
        <p class="mt-2 text-xs text-(--text-secondary)" i18n="@@vendor.billing.summary.truncated">
          Counts cover the licenses shown below, not every license.
        </p>
      }
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorBillingSummary {
  readonly licenses = input.required<readonly VendorBillingLicense[]>();
  readonly productsOnFree = input.required<number>();
  readonly truncated = input(false);

  protected readonly counts = computed(() => {
    let total = 0;
    let assigned = 0;
    let releasing = 0;
    for (const license of this.licenses()) {
      if (!license.live) continue;
      total++;
      if (license.assigned_product) {
        assigned++;
        if (license.release_at_renewal) releasing++;
      }
    }
    return { total, assigned, unassigned: total - assigned, releasing };
  });
}
