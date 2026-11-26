import { Component, LOCALE_ID, computed, inject, input } from '@angular/core';
import { formatDate } from '@angular/common';

import type { VendorListingHidden } from '@aeci/shared';

import { AecPortalNotice, PORTAL_NOTICE_BODY_CLASS } from '../shared/portal-notice';

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
  imports: [AecPortalNotice],
  host: { class: 'block' },
  template: `
    <section
      aecPortalNotice
      [attr.aria-labelledby]="headingId()"
      data-testid="listing-hidden-banner"
    >
      <h2 [id]="headingId()" i18n="@@vendor.listingHidden.heading">
        Hidden from the public site by AEC Integrations on {{ date() }}
      </h2>
      <p
        [class]="bodyClass + ' mt-1 whitespace-pre-line'"
        data-testid="listing-hidden-reason"
        i18n="@@vendor.listingHidden.reason"
      >
        Reason: {{ hidden().reason }}
      </p>
      <p [class]="bodyClass + ' mt-2'" i18n="@@vendor.listingHidden.body">
        Your portal still works and your edits still save. To dispute this, email
        <a
          [href]="'mailto:' + supportEmail"
          class="rounded-mark text-(--text-primary) underline decoration-(--border-strong) underline-offset-4 transition-colors [overflow-wrap:anywhere] hover:decoration-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
          >{{ supportEmail }}</a
        >
        and quote this message.
      </p>
    </section>
  `,
})
export class VendorListingHiddenBanner {
  private readonly locale = inject(LOCALE_ID);

  /** The hide on the company or the product. The host renders this only when set. */
  readonly hidden = input.required<VendorListingHidden>();
  /** Unique per page: the overview and a product shell can both mount one. */
  readonly headingId = input<string>('vendor-listing-hidden-h');

  protected readonly supportEmail = 'support@aecintegrations.com';
  protected readonly bodyClass = PORTAL_NOTICE_BODY_CLASS;

  /** UTC, so the SSR and hydration renders agree on the date. */
  protected readonly date = computed(() => {
    const at = Date.parse(this.hidden().at);
    return Number.isNaN(at) ? this.hidden().at : formatDate(at, 'MMMM d, y', this.locale, 'UTC');
  });
}
