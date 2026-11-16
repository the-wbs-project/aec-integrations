import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecButton } from '../shared/button/button';
import { AecCard } from '../shared/card/card';
import { HomeFeedbackDialog } from './home-feedback-dialog';

/**
 * The home's closing call to action (AECI-1564, rebuilt on mock-up 9 in
 * AECI-1792). One white `aecCard` in two panes, 2:1 from `md`. `home.ts` owns the
 * white band, the page wrap and the hairline above it. The band is white, so the
 * hero keeps the page's one Bone band:
 *
 *   1. For vendors: an eyebrow, a heading and two sentences on how listings work,
 *      then a Forest link to `/vendor-program`. Vendor copy states what is true
 *      and offers the next step. It never uses an imperative upsell and never
 *      mentions price.
 *   2. Suggest a tool: a quieter column whose button opens the
 *      `HomeFeedbackDialog` (`POST /api/feedback`, AECI-275).
 *
 * The mailing-list signup left the home in AECI-1564. `/updates` keeps its own
 * form, and the directory and detail pages keep the shared band.
 *
 * The feedback dialog is `@defer`-loaded on the first "Suggest a tool" click, so
 * BrnDialog, the CDK overlay and the feedback form stay out of the home's
 * initial JS until asked for. The band is static HTML, so the cached `/` stays
 * visitor-state-neutral.
 */
@Component({
  selector: 'aec-home-closing-cta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [AecButton, AecCard, RouterLink, HomeFeedbackDialog],
  template: `
    <section
      aecCard
      aria-labelledby="home-cta-heading"
      class="grid md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
    >
      <div class="p-8 lg:p-12">
        <p class="aec-overline text-(--text-secondary)" i18n="@@home.cta.vendor.eyebrow">
          For vendors
        </p>
        <h2 id="home-cta-heading" class="mt-3 text-(--text-primary)">
          <span
            class="block max-w-[20em] text-t-36 leading-[1.1] tracking-[-0.02em]"
            i18n="@@home.cta.vendor.heading"
            >If you build AEC software, your product may already be listed here.</span
          >
        </h2>
        <p
          class="mt-4 max-w-[36em] text-t-16 leading-relaxed text-(--text-secondary)"
          i18n="@@home.cta.vendor.body"
        >
          AEC Integrations lists products and their integrations independently. Vendors claim a
          listing to correct the facts and keep them current, and position in the directory is never
          for sale.
        </p>
        <a aecButton routerLink="/vendor-program" class="mt-8" i18n="@@home.cta.vendor.action">
          Claim or list your product
        </a>
      </div>

      <div class="flex flex-col justify-center border-t p-8 md:border-s md:border-t-0 lg:p-12">
        <h3 class="text-(--text-primary)">
          <span class="block leading-tight" i18n="@@home.cta.feedback.lead"
            >Think we're missing a tool?</span
          >
        </h3>
        <p
          class="mt-2 text-t-14 leading-relaxed text-(--text-secondary)"
          i18n="@@home.cta.feedback.body"
        >
          Tell us what to add or what to cover next.
        </p>
        <button
          aecButton
          variant="secondary"
          type="button"
          (click)="openFeedback()"
          class="mt-6 self-start"
          i18n="@@home.cta.feedback.action"
        >
          Suggest a tool
        </button>
      </div>
    </section>

    <!-- Lazy: BrnDialog, the overlay and the feedback form load only on first click. -->
    @defer (when feedbackOpen()) {
      <aec-home-feedback-dialog [open]="feedbackOpen()" (closed)="feedbackOpen.set(false)" />
    }
  `,
})
export class HomeClosingCta {
  /** Drives the `@defer`-loaded feedback dialog. */
  protected readonly feedbackOpen = signal(false);

  protected openFeedback(): void {
    this.feedbackOpen.set(true);
  }
}
