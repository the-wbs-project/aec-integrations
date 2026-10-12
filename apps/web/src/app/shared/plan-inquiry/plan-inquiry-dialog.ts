import { Component, DestroyRef, afterNextRender, inject, viewChild } from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import { PlanInquiryForm } from './plan-inquiry-form';
import { PlanInquiryService } from './plan-inquiry.service';

/**
 * The plan inquiry modal (AECI-1279): a thin BrnDialog shell around
 * `PlanInquiryForm`, styled like the home feedback dialog. One per page, mounted by
 * `PlanInquiryHost` inside a `@defer`, so BrnDialog, the overlay, the form and its
 * Zod schema load only on the first "Talk to us" click.
 *
 * **Never opened from an `effect()`.** `BrnDialog.open()` inside an effect throws
 * NG0602. The dialog registers its `open()` with `PlanInquiryService`, which calls it
 * from the click handler. The first click arrives before this component exists, so it
 * opens itself once, after its first render, from `afterNextRender` (not a reactive
 * context). Both paths run in the browser only, so SSR never renders the overlay.
 *
 * Focus moves into the dialog and returns on close (BrnDialog / CDK). Its name is the
 * `brnDialogTitle`, its description the `brnDialogDescription`. Each open renders the
 * content template afresh, so a reopened dialog starts on an empty form.
 */
@Component({
  selector: 'aec-plan-inquiry-dialog',
  host: { class: 'contents' },
  imports: [
    BrnDialog,
    BrnDialogContent,
    BrnDialogClose,
    BrnDialogTitle,
    BrnDialogDescription,
    PlanInquiryForm,
  ],
  template: `
    <brn-dialog (closed)="inquiry.close()">
      <ng-template brnDialogContent>
        <div
          class="w-[min(92vw,32rem)] max-h-[85vh] overflow-y-auto rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-6 text-(--text-primary) md:p-8"
          data-testid="plan-inquiry-dialog"
        >
          <div class="flex items-start justify-between gap-4">
            <h2
              brnDialogTitle
              class="font-display text-2xl font-normal leading-[1.15] tracking-[-0.01em] text-(--text-primary)"
              i18n="@@planInquiry.dialog.title"
            >
              Talk to us about Managed
            </h2>
            <button
              brnDialogClose
              type="button"
              class="-me-1 -mt-1 shrink-0 rounded-(--radius-sm) p-1 text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n-aria-label="@@planInquiry.dialog.close"
              aria-label="Close"
            >
              <svg
                class="size-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <p
            brnDialogDescription
            class="mt-2 text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@planInquiry.dialog.description"
          >
            Tell us who you are and which products you want on Managed. We agree the price and the
            term with you, then switch Managed on for your company.
          </p>

          <div class="mt-6">
            <aec-plan-inquiry-form
              idPrefix="plan-inquiry-dialog"
              [placement]="inquiry.placement() ?? 'top'"
            />
          </div>
        </div>
      </ng-template>
    </brn-dialog>
  `,
})
export class PlanInquiryDialog {
  protected readonly inquiry = inject(PlanInquiryService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialog = viewChild(BrnDialog);

  constructor() {
    const unregister = this.inquiry.registerOpener(() => this.dialog()?.open());
    this.destroyRef.onDestroy(unregister);
    // The click that loaded this component already set `isOpen()`.
    afterNextRender(() => {
      if (this.inquiry.isOpen()) this.dialog()?.open();
    });
  }
}
