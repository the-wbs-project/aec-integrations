import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
} from '@angular/core';
import { formatDate } from '@angular/common';
import { RouterLink } from '@angular/router';

import type { VendorEntitlementBlock } from '@aeci/shared';

import { parseDate, productEndedRecently } from '../vendor-plan';

/**
 * The product-ended banner (AECI-1408, `docs/VENDOR_SIGNUP_PROCESS.md` §3 step
 * 10, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18). It says one product's Managed plan
 * ended, while the vendor may still hold Managed on its other products.
 *
 * It renders when the product's `plan` is `ended` and `ended_at` is within the
 * last `PRODUCT_ENDED_BANNER_DAYS` (90) days, the `productEndedRecently` rule.
 * The window keeps it from nagging forever.
 *
 * The shell renders it under the product header, so it heads every product
 * tab. When the vendor-wide plan-ended banner shows, because the vendor's last
 * license ended, the host does not render this one. A vendor never sees two.
 *
 * "Get licenses" goes to the Billing tab, for an owner seat only (ruling 4 on
 * AECI-1336). A member cannot open Billing, so a member sees no button. The
 * host passes `billingLink` as `null` for a member.
 *
 * Calm and not dismissible, like the vendor-wide banner: it states the current
 * state. No status colour, no `role="alert"`, no warning glyph. Light only.
 */
@Component({
  selector: 'aec-vendor-product-ended-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (show()) {
      <section
        aria-labelledby="vendor-product-ended-h"
        class="mb-6 flex flex-wrap items-center justify-between gap-x-8 gap-y-4 rounded-(--radius-md) border border-(--border-strong) bg-(--accent-warm) px-5 py-4"
        data-testid="product-ended-banner"
      >
        <div class="min-w-0 max-w-prose">
          <h2
            id="vendor-product-ended-h"
            class="font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.productEnded.heading"
          >
            Managed ended for this product
          </h2>
          <p class="mt-1 text-sm leading-relaxed text-(--text-primary)">{{ lede() }}</p>
        </div>
        @if (billingLink(); as link) {
          <a
            [routerLink]="link"
            class="inline-flex shrink-0 items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-bold text-(--surface-base) no-underline transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            data-testid="product-ended-get-licenses"
            i18n="@@vendor.productEnded.cta"
            >Get licenses</a
          >
        }
      </section>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductEndedBanner {
  private readonly locale = inject(LOCALE_ID);

  /** THIS product's plan (`VendorProduct.plan`, `STAGE_2_PAID_TIERS_SPEC.md` §13.7). */
  readonly plan = input.required<VendorEntitlementBlock>();
  /** Router commands to the Billing tab for an owner seat. `null` for a member. */
  readonly billingLink = input<string | readonly unknown[] | null>(null);
  /** Clock injection point, read at day granularity, for the 90-day window. */
  readonly now = input<number>(Date.now());

  protected readonly show = computed(() => productEndedRecently(this.plan(), this.now()));

  protected readonly lede = computed(() => {
    const ended = parseDate(this.plan().ended_at);
    // UTC, so the SSR and hydration renders agree on the date. `show` already
    // requires a readable `ended_at`, so the empty fallback never renders.
    const date = ended === null ? '' : formatDate(ended, 'MMMM d, y', this.locale, 'UTC');
    return $localize`:@@vendor.productEnded.lede:It ended on ${date}:DATE:. Its content stays live and nothing you entered was removed. Its Managed fields stay just as you left them. If you want to change them in the future, you will need to purchase a license to do so.`;
  });
}
