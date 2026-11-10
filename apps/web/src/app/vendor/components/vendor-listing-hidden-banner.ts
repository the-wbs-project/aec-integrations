import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
} from '@angular/core';
import { formatDate } from '@angular/common';

import type { VendorListingHidden } from '@aeci/shared';

/**
 * The listing-hidden banner (AECI-1238, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.6). AECi
 * took the company, or one product, off the public site. The overview shows it for
 * the company (`me.vendor.hidden`), and the product shell shows it on every tab of a
 * hidden product (`VendorProduct.hidden`).
 *
 * It says when, AECi's vendor-visible reason, that the portal still works, and the
 * §11d.4 dispute route. The internal note never reaches the portal, so there is
 * nothing else to show.
 *
 * Calm and not dismissible, like the plan-ended banners: it states the current state.
 * No `role="alert"`, because it is present from first paint. Light only.
 */
@Component({
  selector: 'aec-vendor-listing-hidden-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      [attr.aria-labelledby]="headingId()"
      class="mb-6 rounded-(--radius-md) border border-(--border-strong) bg-(--accent-warm) px-5 py-4"
      data-testid="listing-hidden-banner"
    >
      <div class="max-w-prose">
        <h2
          [id]="headingId()"
          class="font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.listingHidden.heading"
        >
          Hidden from the public site by AEC Integrations on {{ date() }}
        </h2>
        <p
          class="mt-1 whitespace-pre-line text-sm leading-relaxed text-(--text-primary)"
          data-testid="listing-hidden-reason"
          i18n="@@vendor.listingHidden.reason"
        >
          Reason: {{ hidden().reason }}
        </p>
        <p
          class="mt-2 text-sm leading-relaxed text-(--text-primary)"
          i18n="@@vendor.listingHidden.body"
        >
          Your portal still works and your edits still save. To dispute this, email
          <a
            [href]="'mailto:' + supportEmail"
            class="font-medium text-(--text-primary) underline decoration-(--border-strong) underline-offset-4 transition-colors hover:decoration-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >{{ supportEmail }}</a
          >
          and quote this message.
        </p>
      </div>
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorListingHiddenBanner {
  private readonly locale = inject(LOCALE_ID);

  /** The hide on the company or the product. The host renders this only when set. */
  readonly hidden = input.required<VendorListingHidden>();
  /** Unique per page: the overview and a product shell can both mount one. */
  readonly headingId = input<string>('vendor-listing-hidden-h');

  protected readonly supportEmail = 'support@aecintegrations.com';

  /** UTC, so the SSR and hydration renders agree on the date. */
  protected readonly date = computed(() => {
    const at = Date.parse(this.hidden().at);
    return Number.isNaN(at) ? this.hidden().at : formatDate(at, 'MMMM d, y', this.locale, 'UTC');
  });
}
