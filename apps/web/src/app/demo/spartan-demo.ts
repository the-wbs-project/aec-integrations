import { Component } from '@angular/core';
import { BrnButton } from '@spartan-ng/brain/button';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
  BrnDialogTrigger,
} from '@spartan-ng/brain/dialog';

@Component({
  selector: 'aec-spartan-demo',
  imports: [
    BrnButton,
    BrnDialog,
    BrnDialogClose,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    BrnDialogTrigger,
  ],
  template: `
    <section class="mx-auto max-w-2xl px-6 py-12 space-y-6">
      <header class="space-y-2">
        <h1
          class="text-2xl font-semibold tracking-tight text-(--text-primary)"
          i18n="@@demo.spartan.heading"
        >
          Spartan brain primitives
        </h1>
        <p class="text-sm text-(--text-secondary)" i18n="@@demo.spartan.subheading">
          Internal probe page proving @spartan-ng/brain and Angular CDK are wired correctly. Toggle
          between light and dark themes and verify keyboard focus.
        </p>
      </header>

      <button
        brnButton
        brnDialogTrigger
        [brnDialogTriggerFor]="demoDialog"
        type="button"
        class="cursor-pointer rounded-md border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-medium text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      >
        <ng-container i18n="@@demo.spartan.trigger">Open demo dialog</ng-container>
      </button>

      <brn-dialog #demoDialog="brnDialog" aria-labelledby="demo-dialog-title">
        <ng-template brnDialogContent>
          <div
            class="w-[min(90vw,28rem)] rounded-lg border border-(--border-default) bg-(--surface-raised) p-6 text-(--text-primary) shadow-2xl"
          >
            <h2
              brnDialogTitle
              id="demo-dialog-title"
              class="text-lg font-semibold tracking-tight"
              i18n="@@demo.spartan.dialog.title"
            >
              Brain primitives are working
            </h2>
            <p
              brnDialogDescription
              class="mt-2 text-sm text-(--text-secondary)"
              i18n="@@demo.spartan.dialog.description"
            >
              This dialog uses BrnDialog + Angular CDK overlay and focus trap. Tab moves focus
              inside, Escape closes the dialog, and focus returns to the trigger button.
            </p>
            <div class="mt-6 flex justify-end">
              <button
                brnDialogClose
                type="button"
                class="cursor-pointer rounded-md border border-(--border-strong) bg-(--surface-base) px-3 py-1.5 text-sm text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@demo.spartan.dialog.close"
              >
                Close
              </button>
            </div>
          </div>
        </ng-template>
      </brn-dialog>
    </section>
  `,
})
export class SpartanDemo {}
