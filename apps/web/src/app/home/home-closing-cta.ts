import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';

import { HomeFeedbackDialog } from './home-feedback-dialog';

/**
 * §4.1 section 9 — the home's closing CTA + lead-capture island (AECI-275). A thin
 * wrapper around the shared mailing-list signup band
 * (`shared/mailing-list-signup`, extracted in AECI-327 so the same signup rides the
 * directory + detail pages): it projects the home-only "suggest a tool / share
 * feedback" entry (`HomeFeedbackDialog` → `POST /api/feedback`) into the band's
 * trailing content slot. The email signup itself (`POST /api/subscribe`, the Signal
 * Form, the cache-neutral contract, and the AECI-326 conversion event) now lives in
 * the shared band; the home instance tags its signups `source: 'home_closing_cta'`.
 *
 * The feedback dialog is `@defer`-loaded on the first "Suggest a tool" click, so
 * BrnDialog + the CDK overlay + the feedback form stay out of the home's initial
 * JS budget until asked for.
 */
@Component({
  selector: 'aec-home-closing-cta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [MailingListSignup, HomeFeedbackDialog],
  template: `
    <aec-mailing-list-signup source="home_closing_cta">
      <p class="mt-4 text-sm text-(--text-secondary)">
        <span i18n="@@home.cta.feedback.lead">Think we're missing a tool?</span>
        <button
          type="button"
          (click)="openFeedback()"
          class="ms-1 rounded-sm font-label text-(--accent-primary) underline decoration-1 underline-offset-4 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          i18n="@@home.cta.feedback.action"
        >
          Suggest a tool
        </button>
      </p>
    </aec-mailing-list-signup>

    <!-- Lazy: BrnDialog + overlay + the feedback form load only on first click. -->
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
