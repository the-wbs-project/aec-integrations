import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { HomeFeedbackDialog } from './home-feedback-dialog';

/**
 * The home's closing band (AECI-1564, epic AECI-1554). A Bone ground holding one
 * bordered white panel in two columns:
 *
 *   1. For vendors: an eyebrow, a heading and two sentences on how listings work,
 *      then a Forest link to `/vendor-program`. Vendor copy states what is true
 *      and offers the next step. It never uses an imperative upsell and never
 *      mentions price.
 *   2. Suggest a tool: a quieter column whose button opens the
 *      `HomeFeedbackDialog` (`POST /api/feedback`, AECI-275).
 *
 * The mailing-list signup left the home in AECI-1564. `/updates` and the
 * directory and detail pages keep the shared band.
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
  imports: [RouterLink, HomeFeedbackDialog],
  template: `
    <section class="border-t border-(--border-default) bg-(--accent-warm)">
      <div class="mx-auto w-full max-w-7xl px-6 py-16 md:px-8 md:py-20">
        <div
          class="grid rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base)
            md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]"
        >
          <div class="p-8 md:p-10">
            <p class="aec-overline text-(--text-secondary)" i18n="@@home.cta.vendor.eyebrow">
              For vendors
            </p>
            <h2
              class="mt-3 max-w-2xl font-display text-3xl font-normal leading-[1.1] tracking-[-0.01em] text-(--text-primary) md:text-4xl"
              i18n="@@home.cta.vendor.heading"
            >
              If you build AEC software, your product may already be listed here.
            </h2>
            <p
              class="mt-4 max-w-xl text-base leading-relaxed text-(--text-secondary)"
              i18n="@@home.cta.vendor.body"
            >
              AEC Integrations lists products and their integrations independently. Vendors claim a
              listing to correct the facts and keep them current, and position in the directory is
              never for sale.
            </p>
            <a
              routerLink="/vendor-program"
              class="mt-8 inline-flex items-center rounded-(--radius-sm) bg-(--accent-primary) px-5 py-3 font-label text-(--surface-base) no-underline transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@home.cta.vendor.action"
            >
              Claim or list your product
            </a>
          </div>

          <div
            class="flex flex-col justify-center border-t border-(--border-default) p-8 md:border-s md:border-t-0 md:p-10"
          >
            <h3
              class="font-display text-xl font-semibold text-(--text-primary)"
              i18n="@@home.cta.feedback.lead"
            >
              Think we're missing a tool?
            </h3>
            <p
              class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
              i18n="@@home.cta.feedback.body"
            >
              Tell us what to add or what to cover next.
            </p>
            <button
              type="button"
              (click)="openFeedback()"
              class="mt-5 self-start rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-4 py-2 font-label text-(--text-primary) transition-colors hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@home.cta.feedback.action"
            >
              Suggest a tool
            </button>
          </div>
        </div>
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
