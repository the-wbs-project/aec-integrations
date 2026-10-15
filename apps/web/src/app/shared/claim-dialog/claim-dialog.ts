import { Component, DestroyRef, afterNextRender, inject, viewChild } from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import { ClaimDialogFlow } from './claim-dialog-flow';
import { ClaimDialogService } from './claim-dialog.service';

/**
 * The claim dialog (AECI-1293, `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.2): a BrnDialog
 * shell around `ClaimDialogFlow`, built on the plan inquiry dialog's shell. One per
 * page, mounted by `ClaimDialogHost` inside a `@defer`.
 *
 * **Never opened from an `effect()`** (NG0602). The dialog registers its `open()` with
 * `ClaimDialogService`, which calls it from the click handler. The first click arrives
 * before this component exists, so it opens itself once, after its first render.
 *
 * **Layout.** Below `sm` the panel is a full-screen sheet (`100dvh`, no radius), so a
 * phone keyboard never hides the step's own buttons. From `sm` it is a centred panel,
 * `min(92vw, 36rem)` wide, scrolling inside at `85vh`. Header, scrolling body and a
 * footer with Back and the primary action, after the Mobbin anchor (Mercor's
 * "Complete your profile" modal, screen `a39d82f4-c61a-44cb-be88-f81eec9320a8`: title
 * and "Step N of 3" with a bar in the header, Back and the primary action at the foot).
 *
 * Focus moves into the dialog and returns to the trigger on close (BrnDialog / CDK).
 * Escape and the close button close it at any step. Each open renders the content
 * afresh, so a reopened dialog starts empty.
 */
@Component({
  selector: 'aec-claim-dialog',
  host: { class: 'contents' },
  imports: [
    BrnDialog,
    BrnDialogContent,
    BrnDialogClose,
    BrnDialogTitle,
    BrnDialogDescription,
    ClaimDialogFlow,
  ],
  template: `
    <brn-dialog (closed)="dialog.close()">
      <ng-template brnDialogContent let-ctx>
        <div
          class="flex h-dvh w-screen flex-col bg-(--surface-base) text-(--text-primary) sm:h-auto sm:max-h-[85vh] sm:w-[min(92vw,36rem)] sm:rounded-(--radius-lg) sm:border sm:border-(--border-default)"
          data-testid="claim-dialog"
        >
          <div class="flex items-start justify-between gap-4 px-6 pt-6 pb-3">
            <div>
              <!-- AECI-1364: a claim is on the company, named once it is known. -->
              <h2
                brnDialogTitle
                class="font-display text-2xl font-normal leading-[1.15] tracking-[-0.01em] text-(--text-primary)"
                data-testid="claim-dialog-title"
              >
                @if (dialog.company(); as company) {
                  <ng-container i18n="@@claimDialog.title.company"
                    >Claim {{ company }}</ng-container
                  >
                } @else {
                  <ng-container i18n="@@claimDialog.title">Claim your company</ng-container>
                }
              </h2>
              <p
                brnDialogDescription
                class="mt-1 text-sm text-(--text-secondary)"
                i18n="@@claimDialog.description"
              >
                Claiming is free. We set up your account when we approve your claim.
              </p>
            </div>
            <button
              brnDialogClose
              type="button"
              class="-me-1 -mt-1 inline-flex size-11 shrink-0 items-center justify-center rounded-(--radius-sm) text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n-aria-label="@@claimDialog.close"
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

          @if (dialog.opening(); as opening) {
            <aec-claim-dialog-flow [opening]="opening" (done)="ctx.close()" />
          }
        </div>
      </ng-template>
    </brn-dialog>
  `,
})
export class ClaimDialog {
  protected readonly dialog = inject(ClaimDialogService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly brn = viewChild(BrnDialog);

  constructor() {
    const unregister = this.dialog.registerOpener(() => this.brn()?.open());
    this.destroyRef.onDestroy(unregister);
    afterNextRender(() => {
      if (this.dialog.isOpen()) this.brn()?.open();
    });
  }
}
