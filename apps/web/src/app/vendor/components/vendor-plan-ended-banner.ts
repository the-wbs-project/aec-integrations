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

import { parseDate, planHasEnded } from '../vendor-plan';

/**
 * The plan-ended banner (AECI-1218, `STAGE_2_PAID_TIERS_SPEC.md` §13.11,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18). The spec calls it the pilot-ended
 * banner, because every Managed plan today is a pilot.
 *
 * It renders when the vendor's entitlement `status` is `expired` or `revoked`,
 * and never when it is `null`: `null` is a vendor that never had a plan, and
 * telling them a plan ended would be false. The copy says "your Managed plan",
 * not "your pilot", so the later expiry path §13.11 anticipates needs no copy
 * change.
 *
 * Not dismissible: it states the current state, and the state does not go away
 * by being hidden. Calm, not an alert: no status colour, no `role="alert"`, no
 * warning glyph. It lists what still works first, then what went read-only, and
 * says nothing entered was removed (decision 8).
 *
 * The shell renders it above the section tabs, so it heads every portal page.
 * It reads the vendor's block, which a vendor-wide surface may do; the product
 * screens read `product.plan` (§13.7).
 */
@Component({
  selector: 'aec-vendor-plan-ended-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    @if (show()) {
      <section
        aria-labelledby="vendor-plan-ended-h"
        class="mb-6 rounded-(--radius-md) border border-(--border-strong) bg-(--accent-warm) p-5 md:p-6"
        data-testid="plan-ended-banner"
      >
        <h2
          id="vendor-plan-ended-h"
          class="font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.planEnded.heading"
        >
          Your Managed plan has ended
        </h2>
        <p class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-primary)">{{ lede() }}</p>

        <div class="mt-4 grid gap-x-8 gap-y-4 md:grid-cols-2">
          <div>
            <h3
              class="aec-overline text-(--text-secondary)"
              i18n="@@vendor.planEnded.works.heading"
            >
              Still works
            </h3>
            <ul [class]="listClass">
              <li i18n="@@vendor.planEnded.works.listings">
                Your listings stay published, exactly as they are
              </li>
              <li i18n="@@vendor.planEnded.works.company">Editing your company details</li>
              <li i18n="@@vendor.planEnded.works.basics">
                Editing product descriptions, websites, logos and categories
              </li>
              <li i18n="@@vendor.planEnded.works.seats">
                Seats and sign-in for you and your colleagues
              </li>
              <li i18n="@@vendor.planEnded.works.looksRight">
                Marking details and integration lists as checked
              </li>
              <li i18n="@@vendor.planEnded.works.claims">
                Claiming integrations, adding links and requesting corrections
              </li>
              <li i18n="@@vendor.planEnded.works.create">Adding a new integration</li>
            </ul>
          </div>
          <div>
            <h3
              class="aec-overline text-(--text-secondary)"
              i18n="@@vendor.planEnded.readOnly.heading"
            >
              Now read-only
            </h3>
            <ul [class]="listClass">
              <li i18n="@@vendor.planEnded.readOnly.narrative">
                "How teams use it", the integrations page URL and the API documentation URL
              </li>
              <li i18n="@@vendor.planEnded.readOnly.taxonomy">Trades, audiences and phases</li>
              <li i18n="@@vendor.planEnded.readOnly.flows">
                Your data flow answers. They stay as you left them, and readers still see them.
              </li>
              <li i18n="@@vendor.planEnded.readOnly.connector">
                Integrations delivered through a connector
              </li>
              <li i18n="@@vendor.planEnded.readOnly.label">
                The "Active on AECi" label on your vendor page
              </li>
            </ul>
          </div>
        </div>

        <p class="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-(--text-secondary)">
          <a
            routerLink="/contact"
            class="inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-bold text-(--surface-base) no-underline transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@vendor.planEnded.cta"
            >Talk to us about Managed</a
          >
          <span i18n="@@vendor.planEnded.cta.note"
            >Turning it back on needs nothing re-entered.</span
          >
        </p>
      </section>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorPlanEndedBanner {
  private readonly locale = inject(LOCALE_ID);

  /** The vendor's `entitlement` block from `GET /api/vendor/me`. */
  readonly entitlement = input.required<VendorEntitlementBlock>();

  protected readonly show = computed(() => planHasEnded(this.entitlement()));

  protected readonly lede = computed(() => {
    const ended = parseDate(this.entitlement().ended_at);
    if (ended === null) {
      return $localize`:@@vendor.planEnded.lede.noDate:Your products are now on the Free plan. Nothing you entered was removed.`;
    }
    // UTC, so the SSR and hydration renders agree on the date.
    const date = formatDate(ended, 'MMMM d, y', this.locale, 'UTC');
    return $localize`:@@vendor.planEnded.lede:It ended on ${date}:DATE:. Your products are now on the Free plan. Nothing you entered was removed.`;
  });

  protected readonly listClass =
    'mt-2 list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-(--text-primary)';
}
