import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  effect,
  inject,
  input,
  output,
  viewChild,
} from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import { HomeFeedbackForm } from './home-feedback-form';

/**
 * The "suggest a tool / share feedback" modal shell (AECI-275). A thin BrnDialog
 * wrapper around `HomeFeedbackForm`, mirroring `requests/request-drawer.ts`: a
 * browser-only `effect()` drives `open()` / `close()` from the `[open]` input, so
 * SSR never renders the overlay and the cached `/` HTML stays capture-neutral
 * (§4.1). It is opened in response to a click in the parent closing CTA, never
 * from an effect on the server — the NG0602 trap the AC calls out — and the whole
 * dialog (this shell + BrnDialog + CDK overlay + the form + its Zod schema) is
 * `@defer`-loaded by the closing CTA on that first click.
 *
 * `(closed)` (Escape / backdrop / close button / post-submit auto-close) bubbles
 * up via the `closed` output so the parent resets its open signal. On a successful
 * submit the form emits `(done)`; we leave the "thanks" confirmation up briefly,
 * then close.
 */
@Component({
  selector: 'aec-home-feedback-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  imports: [
    BrnDialog,
    BrnDialogContent,
    BrnDialogClose,
    BrnDialogTitle,
    BrnDialogDescription,
    HomeFeedbackForm,
  ],
  template: `
    <brn-dialog (closed)="onClosed()">
      <ng-template brnDialogContent>
        <div
          class="w-[min(92vw,32rem)] max-h-[85vh] overflow-y-auto rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-6 text-(--text-primary) md:p-8"
        >
          <div class="flex items-start justify-between gap-4">
            <h2
              brnDialogTitle
              class="font-display text-2xl font-normal leading-[1.15] tracking-[-0.01em] text-(--text-primary)"
              i18n="@@home.feedback.title"
            >
              Suggest a tool or share feedback
            </h2>
            <button
              brnDialogClose
              type="button"
              class="-me-1 -mt-1 shrink-0 rounded-(--radius-sm) p-1 text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n-aria-label="@@home.feedback.close"
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
            i18n="@@home.feedback.description"
          >
            Tell us what to cover or what to build. Fill in whatever is useful; share at least one
            feature or tool.
          </p>

          <div class="mt-6">
            <aec-home-feedback-form (done)="onDone()" />
          </div>
        </div>
      </ng-template>
    </brn-dialog>
  `,
})
export class HomeFeedbackDialog {
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly dialog = viewChild(BrnDialog);

  /** Drives the overlay. The parent (`home-closing-cta`) flips this; a browser-only
   *  effect mirrors it onto `BrnDialog.open()/close()`. */
  readonly open = input(false);
  /** Bubbles every close (Escape / backdrop / close button / auto-close) so the
   *  parent can reset its open signal. */
  readonly closed = output<void>();

  constructor() {
    // Browser-only overlay sync (SSR never opens it → cache-neutral). `viewChild`
    // resolves after view init, so the dialog is present by the time `open()`
    // first flips true (the parent only sets it true on a click, post-hydration).
    if (this.isBrowser) {
      effect(() => {
        const dlg = this.dialog();
        if (!dlg) return;
        if (this.open()) dlg.open();
        else dlg.close();
      });
    }
  }

  /** Forwarded from BrnDialog's `(closed)` (Escape / backdrop / close button /
   *  auto-close) — notify the parent so it resets its open signal. */
  protected onClosed(): void {
    this.closed.emit();
  }

  /** The form submitted successfully — leave the confirmation up a moment, then
   *  close. Browser-only (the form only submits in the browser). */
  protected onDone(): void {
    if (this.isBrowser) setTimeout(() => this.dialog()?.close(), 1800);
  }
}
