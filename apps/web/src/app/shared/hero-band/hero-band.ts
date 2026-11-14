import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * AECI-1766 - the Forest hero band of a detail page (DESIGN.md §2 "Forest
 * grounds", §4 "The detail page band shell", ADR 0056). A frame, not a page:
 * AECI-1778 fills it on the product page. It owns the ground, the glow, the
 * page wrap and the vertical rhythm. The caller owns every word.
 *
 * Slots, each an attribute on the projected element:
 *  - `heroCrumbs`: the breadcrumb (`aec-breadcrumb`, AECI-1777), above the title.
 *  - `heroKicker`: the chip or logo row above the name.
 *  - `heroTitle`: the name as INLINE content, for example
 *    `<span heroTitle>Revu</span>`. The band renders the `h1` and puts Display on
 *    an inner `span`, because the unlayered `h1` rule beats a size utility on the
 *    element (DESIGN.md "The Unlayered-Heading Rule").
 *  - default content: byline, description and ratings, under the name.
 *  - `heroActions`: the buttons. The main one is `aecButton variant="on-brand"`.
 *  - `heroPanel`: an optional panel on `--surface-hero-panel`. At `lg` it takes a
 *    right column. Below `lg` it stacks under the text. With nothing projected the
 *    column and its gap are not rendered.
 *
 * The ground is `--accent-primary`, the same token the header paints, so the
 * seam between them is one ground with no edge. The glow is the one gradient the
 * design allows: two radial gradients over token colours, set in `styles.css`
 * (`.aec-hero-band`). Nothing here reads visitor state, so cached SSR HTML is
 * the same for every visitor. The band does not move on load.
 *
 * The bottom padding is 128px at `md` and up and 96px below it. The facts card
 * that overlaps the band (AECI-1778) never overlaps past that padding.
 */
@Component({
  selector: 'aec-hero-band',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="aec-hero-band bg-(--accent-primary) text-(--text-on-brand)">
      <div class="mx-auto w-full max-w-[1328px] px-6 pt-4 pb-24 md:px-8 md:pt-6 md:pb-32 lg:px-12">
        <div
          class="grid gap-8 lg:items-center lg:has-[.aec-hero-panel>*]:grid-cols-[minmax(0,1fr)_540px]"
          data-testid="hero-band-grid"
        >
          <div class="min-w-0">
            <ng-content select="[heroCrumbs]" />
            <ng-content select="[heroKicker]" />
            <h1 class="m-0 mt-4 break-words">
              <span class="font-display text-t-display font-normal tracking-[-0.02em]">
                <ng-content select="[heroTitle]" />
              </span>
            </h1>
            <ng-content />
            <div class="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap">
              <ng-content select="[heroActions]" />
            </div>
          </div>
          <div
            class="aec-hero-panel min-w-0 rounded-card bg-(--surface-hero-panel) p-6 empty:hidden md:p-8"
          >
            <ng-content select="[heroPanel]" />
          </div>
        </div>
      </div>
    </div>
  `,
})
export class HeroBand {}
