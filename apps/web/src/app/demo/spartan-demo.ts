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

import { AecButton } from '../shared/button/button';
import { AecFigure } from '../shared/figure/figure';
import { AecIcon } from '../shared/icon/icon';
import { AecMeter } from '../shared/meter/meter';

@Component({
  selector: 'aec-spartan-demo',
  imports: [
    AecButton,
    AecFigure,
    AecIcon,
    AecMeter,
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

      <button brnButton aecButton brnDialogTrigger [brnDialogTriggerFor]="demoDialog" type="button">
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
                aecButton
                variant="secondary"
                type="button"
                i18n="@@demo.spartan.dialog.close"
              >
                Close
              </button>
            </div>
          </div>
        </ng-template>
      </brn-dialog>

      <!-- AECI-1758: every aecButton variant and state, for render checks and axe. -->
      <section
        aria-labelledby="demo-buttons-heading"
        class="space-y-4"
        data-testid="button-specimen"
      >
        <h2 id="demo-buttons-heading" i18n="@@demo.buttons.heading">Buttons</h2>
        <div class="flex flex-wrap items-center gap-3">
          <button aecButton type="button" data-testid="btn-primary" i18n="@@demo.buttons.primary">
            Save
          </button>
          <button
            aecButton
            variant="secondary"
            type="button"
            data-testid="btn-secondary"
            i18n="@@demo.buttons.secondary"
          >
            Back
          </button>
          <button
            aecButton
            variant="ghost"
            type="button"
            data-testid="btn-ghost"
            i18n="@@demo.buttons.ghost"
          >
            Not now
          </button>
          <button
            aecButton
            variant="danger"
            type="button"
            data-testid="btn-danger"
            i18n="@@demo.buttons.danger"
          >
            Delete
          </button>
          <a
            aecButton
            variant="secondary"
            href="/docs"
            data-testid="btn-link"
            i18n="@@demo.buttons.link"
          >
            Read the docs
          </a>
          <button
            aecButton
            variant="secondary"
            compact
            type="button"
            data-testid="btn-compact"
            i18n="@@demo.buttons.compact"
          >
            Edit
          </button>
          <button
            aecButton
            variant="ghost"
            iconOnly
            type="button"
            data-testid="btn-icon"
            i18n-aria-label="@@demo.buttons.iconLabel"
            aria-label="Search"
          >
            <aec-icon name="search" decorative />
          </button>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button
            aecButton
            type="button"
            disabled
            data-testid="btn-primary-disabled"
            i18n="@@demo.buttons.primaryDisabled"
          >
            Save (disabled)
          </button>
          <button
            aecButton
            variant="secondary"
            type="button"
            disabled
            i18n="@@demo.buttons.secondaryDisabled"
          >
            Back (disabled)
          </button>
          <button
            aecButton
            variant="danger"
            type="button"
            disabled
            i18n="@@demo.buttons.dangerDisabled"
          >
            Delete (disabled)
          </button>
          <a
            aecButton
            variant="secondary"
            href="/docs"
            disabled
            data-testid="btn-link-disabled"
            i18n="@@demo.buttons.linkDisabled"
          >
            Read the docs (disabled)
          </a>
        </div>
        <div class="flex flex-wrap items-center gap-3 rounded-card bg-(--accent-primary) p-6">
          <button
            aecButton
            variant="on-brand"
            type="button"
            data-testid="btn-on-brand"
            i18n="@@demo.buttons.onBrand"
          >
            Write a review
          </button>
          <button
            aecButton
            variant="on-brand"
            type="button"
            disabled
            i18n="@@demo.buttons.onBrandDisabled"
          >
            Write a review (disabled)
          </button>
        </div>
      </section>

      <!-- AECI-1767: aec-meter and aec-figure, every state, for render checks and axe. -->
      <section aria-labelledby="demo-meter-heading" class="space-y-4" data-testid="meter-specimen">
        <h2 id="demo-meter-heading" i18n="@@demo.meter.heading">Meters</h2>
        <aec-meter data-testid="meter-zero" [value]="0" [max]="5" text="0.0" label="At zero" />
        <aec-meter data-testid="meter-mid" [value]="4.3" [max]="5" text="4.3" label="Mid value" />
        <aec-meter
          data-testid="meter-max"
          [value]="5"
          [max]="5"
          text="5.0"
          label="At the maximum"
        />
        <aec-meter
          data-testid="meter-over"
          [value]="9"
          [max]="5"
          text="9"
          label="Out of range, clamped"
        />
        <aec-meter
          data-testid="meter-forest"
          [value]="4.3"
          [max]="5"
          text="4.3"
          label="Product quality"
          showLabel
        />
        <aec-meter
          data-testid="meter-onboarding"
          [value]="3.8"
          [max]="5"
          text="3.8"
          label="Onboarding experience"
          tone="onboarding"
        />
        <aec-meter
          data-testid="meter-long"
          [value]="3"
          [max]="5"
          text="3.0"
          label="A deliberately long label that has to wrap on a narrow screen without clipping the number"
          showLabel
        />
        <div class="flex flex-col items-center gap-3" data-testid="meter-load">
          <aec-meter
            class="w-[260px] max-w-full"
            [value]="24"
            [max]="58"
            text="Showing 24 of 58"
            label="Products shown"
          />
        </div>
      </section>

      <section
        aria-labelledby="demo-figure-heading"
        class="space-y-6"
        data-testid="figure-specimen"
      >
        <h2 id="demo-figure-heading" i18n="@@demo.figure.heading">Figures</h2>
        <aec-figure data-testid="figure-normal" [value]="12" label="integrations" />
        <aec-figure data-testid="figure-large" [value]="12345" label="page views" />
        <aec-figure
          data-testid="figure-zero"
          [value]="0"
          label="We have no integrations for Bluebeam Revu on record"
          support="Not on record means we have not found one. It is not proof that none exists."
        >
          <a href="#know" class="text-t-14 font-semibold text-(--text-secondary)">Know of one?</a>
        </aec-figure>
        <div data-testid="figure-zero-bare">
          <aec-figure [value]="0" label="We have no integrations for Bluebeam Revu on record" />
        </div>
        <!-- The reviews band, flagged for Chris: two figures, one per score, never merged. -->
        <div class="grid gap-6 sm:grid-cols-2" data-testid="reviews-band">
          <div class="space-y-3 rounded-card bg-(--surface-raised) p-6 shadow-card">
            <aec-figure
              data-testid="score-quality"
              [value]="4.3"
              label="Product quality, from 12 reviews"
            />
            <aec-meter [value]="4.3" [max]="5" text="4.3" label="Product quality" />
          </div>
          <div class="space-y-3 rounded-card bg-(--surface-raised) p-6 shadow-card">
            <aec-figure
              data-testid="score-onboarding"
              [value]="3.8"
              label="Onboarding experience, from 12 reviews"
            />
            <aec-meter
              [value]="3.8"
              [max]="5"
              text="3.8"
              label="Onboarding experience"
              tone="onboarding"
            />
          </div>
        </div>
      </section>
    </section>
  `,
})
export class SpartanDemo {}
