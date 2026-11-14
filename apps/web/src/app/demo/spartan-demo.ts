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
import { BoneBand } from '../shared/bone-band/bone-band';
import { Chip } from '../shared/chip/chip';
import { HeroBand } from '../shared/hero-band/hero-band';
import { AecIcon } from '../shared/icon/icon';

@Component({
  selector: 'aec-spartan-demo',
  imports: [
    AecButton,
    AecIcon,
    BrnButton,
    BrnDialog,
    BrnDialogClose,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    BrnDialogTrigger,
    BoneBand,
    Chip,
    HeroBand,
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
          <button
            aecButton
            variant="on-brand-secondary"
            type="button"
            data-testid="btn-on-brand-secondary"
            i18n="@@demo.buttons.onBrandSecondary"
          >
            Visit website
          </button>
          <button
            aecButton
            variant="on-brand-secondary"
            type="button"
            disabled
            data-testid="btn-on-brand-secondary-disabled"
            i18n="@@demo.buttons.onBrandSecondaryDisabled"
          >
            Visit website (disabled)
          </button>
        </div>
      </section>
    </section>

    <!-- AECI-1766: the Forest hero band, full width, with and without a panel.
         Each band renders its own h1 (the band owns it), so this probe page has
         three h1s. A real page uses one band and renders no other h1. -->
    <section aria-labelledby="demo-hero-heading" data-testid="hero-band-specimen">
      <h2
        id="demo-hero-heading"
        class="mx-auto max-w-2xl px-6 pb-4 text-xl font-semibold"
        i18n="@@demo.hero.heading"
      >
        Hero band
      </h2>
      <aec-hero-band data-testid="hero-band-with-panel">
        <p heroCrumbs class="text-t-14 text-(--text-on-brand-secondary)" i18n="@@demo.hero.crumbs">
          Products / Review
        </p>
        <aec-chip heroKicker link="/docs" data-testid="hero-chip" i18n="@@demo.hero.kicker">
          Maintained by the vendor
        </aec-chip>
        <div heroMark class="rounded-card bg-(--surface-base)" data-testid="hero-mark"></div>
        <span heroTitle i18n="@@demo.hero.title">A product name that is long enough to wrap</span>
        <p
          heroByline
          class="text-t-16 text-(--text-on-brand-secondary)"
          data-testid="hero-byline"
          i18n="@@demo.hero.byline"
        >
          By <a href="/vendors" data-testid="hero-plain-link">a vendor name</a>
        </p>
        <p class="max-w-prose text-t-18 text-(--text-on-brand-secondary)" i18n="@@demo.hero.lede">
          One line about what the product does for the people who use it.
        </p>
        <div
          class="mt-6 max-w-sm rounded-card bg-(--surface-base) p-4 text-(--text-primary)"
          data-testid="hero-white-card"
        >
          <button
            aecButton
            type="button"
            class="focus-visible:outline-(--accent-primary)"
            data-testid="hero-white-card-button"
            i18n="@@demo.hero.cardAction"
          >
            Action on a white card
          </button>
        </div>
        <button
          heroActions
          aecButton
          variant="on-brand"
          type="button"
          data-testid="hero-main-action"
          i18n="@@demo.hero.action"
        >
          Write a review
        </button>
        <a
          heroActions
          aecButton
          variant="on-brand-secondary"
          href="/docs"
          data-testid="hero-second-action"
          i18n="@@demo.hero.link"
        >
          Visit website
        </a>
        <div heroPanel class="text-(--text-on-brand)">
          <p class="text-(--text-on-brand-secondary)" i18n="@@demo.hero.panel">
            The hero panel sits on Forest. The visual for a page goes here.
          </p>
        </div>
      </aec-hero-band>
      <div class="h-8"></div>
      <aec-hero-band data-testid="hero-band-plain">
        <span heroTitle i18n="@@demo.hero.titlePlain">A band with no panel</span>
        <button
          heroActions
          aecButton
          variant="on-brand"
          type="button"
          i18n="@@demo.hero.actionPlain"
        >
          Main action
        </button>
      </aec-hero-band>
    </section>

    <!-- AECI-1766: the one Bone band. Last on the page so it meets the footer. -->
    <section aria-labelledby="demo-bone-heading" data-testid="bone-band-specimen">
      <aec-bone-band data-testid="bone-band">
        <h2
          id="demo-bone-heading"
          class="max-w-2xl font-display text-t-36 font-normal tracking-[-0.02em]"
          i18n="@@demo.bone.heading"
        >
          The one Bone band
        </h2>
        <p class="mt-4 max-w-xl text-t-16 text-(--text-secondary)" i18n="@@demo.bone.body">
          Secondary text on Bone is 6.91:1. A control keeps its own edge and fill.
        </p>
        <form class="mt-8 max-w-xl" novalidate (submit)="$event.preventDefault()">
          <div class="flex flex-wrap gap-3">
            <label class="sr-only" for="demo-bone-email" i18n="@@demo.bone.emailLabel">
              Email address
            </label>
            <input
              id="demo-bone-email"
              type="email"
              autocomplete="email"
              data-testid="bone-input"
              i18n-placeholder="@@demo.bone.emailPlaceholder"
              placeholder="you@yourfirm.com"
              class="aec-field-control min-w-0 flex-1 rounded-control border bg-(--surface-base) px-4 py-2 text-t-16 text-(--text-primary)"
            />
            <button aecButton type="submit" data-testid="bone-primary" i18n="@@demo.bone.subscribe">
              Subscribe
            </button>
          </div>
        </form>
        <div class="mt-6 flex flex-wrap items-center gap-3">
          <button
            aecButton
            variant="secondary"
            type="button"
            data-testid="bone-secondary"
            i18n="@@demo.bone.secondary"
          >
            Secondary
          </button>
          <button
            aecButton
            variant="ghost"
            type="button"
            data-testid="bone-ghost"
            i18n="@@demo.bone.ghost"
          >
            Ghost
          </button>
        </div>
      </aec-bone-band>
    </section>
  `,
})
export class SpartanDemo {}
