import { ChangeDetectionStrategy, Component } from '@angular/core';

import { BAND_WRAP_CLASS } from '../band-wrap';

/**
 * AECI-1766 - the Forest hero band of a detail page (DESIGN.md §2 "Forest
 * grounds", §4 "The detail page band shell", ADR 0056). A frame, not a page:
 * AECI-1778 fills it on the product page. It owns the ground, the glow, the
 * page wrap and the vertical rhythm. The caller owns every word.
 *
 * Slots, each an attribute on the projected element:
 *  - `heroCrumbs`: the breadcrumb (`aec-breadcrumb`, AECI-1777), above the name.
 *  - `heroKicker`: the chip row above the name.
 *  - `heroMark`: a logo left of the name, in a 104px box (68px below `md`). The
 *    projected element fills the box. The caller draws its radius and ring.
 *  - `heroTitle`: the name as INLINE content, for example
 *    `<span heroTitle>Revu</span>`. The band renders the `h1` and puts Display on
 *    an inner `span`, because the unlayered `h1` rule beats a size utility on the
 *    element (DESIGN.md "The Unlayered-Heading Rule"). The `h1` holds only the
 *    title. A page that uses the band renders no other `h1`.
 *  - `heroByline`: the vendor line, under the name and beside the mark.
 *  - default content: lede and ratings, under the name row.
 *  - `heroActions`: the buttons. The main one is `aecButton variant="on-brand"`,
 *    a second one is `variant="on-brand-secondary"`.
 *  - `heroPanel`: an optional panel on `--surface-hero-panel`. At `lg` it takes a
 *    right column. Below `lg` it stacks under the text. With nothing projected the
 *    column and its gap are not rendered.
 *
 * Spacing is mock-up 6's (`.namerow`, `.hacts`): 24px above the name row, 16px
 * under it (12px below `md`), 24px above the actions, a 12px gap, and a wrapping
 * row at every width. Below `md` the actions share the row (`flex: 1`).
 *
 * The ground is `--accent-primary`, the same token the header paints, so the
 * seam between them is one ground with no edge. The glow is the one gradient the
 * design allows: two radial gradients over token colours, set in `styles.css`
 * (`.aec-hero-band`). It is held low enough that the band's top row is flat
 * Forest. Nothing here reads visitor state, so cached SSR HTML is the same for
 * every visitor. The band does not move on load.
 *
 * Inside the band, a plain link is Bone and a keyboard ring is Bone, 3px at 3px.
 * Both come from the base layer, so a caller's utility wins. A white surface
 * inside the band sets its own Forest ring with a plain utility.
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
      <div [class]="wrap">
        <div
          class="grid gap-8 lg:items-center lg:has-[.aec-hero-panel>*]:grid-cols-[minmax(0,1fr)_540px]"
          data-testid="hero-band-grid"
        >
          <div class="min-w-0">
            <ng-content select="[heroCrumbs]" />
            <ng-content select="[heroKicker]" />
            <div
              class="mt-6 mb-3 flex items-start gap-4 md:mb-4 md:items-center md:gap-6"
              data-testid="hero-band-namerow"
            >
              <div class="size-17 shrink-0 empty:hidden md:size-26 [&>*]:size-full">
                <ng-content select="[heroMark]" />
              </div>
              <div class="min-w-0">
                <h1 class="m-0 break-words">
                  <span class="font-display text-t-display font-normal tracking-[-0.02em]">
                    <ng-content select="[heroTitle]" />
                  </span>
                </h1>
                <div class="mt-3 empty:hidden">
                  <ng-content select="[heroByline]" />
                </div>
              </div>
            </div>
            <ng-content />
            <div class="mt-6 flex flex-wrap gap-3 empty:hidden max-md:[&>*]:flex-1">
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
export class HeroBand {
  protected readonly wrap = `${BAND_WRAP_CLASS} pt-4 pb-24 md:pt-6 md:pb-32`;
}
