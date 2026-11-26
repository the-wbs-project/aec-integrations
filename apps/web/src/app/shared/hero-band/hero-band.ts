import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { BAND_WRAP_CLASS } from '../band-wrap';

/**
 * AECI-1766 - the Forest hero band of a detail page (DESIGN.md §2 "Forest
 * grounds", §4 "The detail page band shell", ADR 0059). A frame, not a page:
 * AECI-1778 fills it on the product page. It owns the ground, the glow, the
 * page wrap and the vertical rhythm. The caller owns every word.
 *
 * Slots, each an attribute on the projected element:
 *  - `heroCrumbs`: the breadcrumb (`aec-breadcrumb`, AECI-1777). It sits above the
 *    two-column grid, full width, as mock-ups 6 and 12 draw it (`.crumbs` before
 *    `.hero-grid`), so it stays at the top of the band however tall the panel is. With
 *    no panel the grid is one column and the breadcrumb sits right above the kicker,
 *    exactly where it sat inside the column before (AECI-1720 restore C).
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
 *    400px right column, and 540px from `xl` (mock-up 6). Below `lg` it stacks under
 *    the text. With nothing projected the column and its gap are not rendered. The
 *    narrower `lg` column is AECI-1787's: at 1024px a 540px panel left the name about
 *    230px beside the mark, and a long word in it broke mid-word.
 *
 * Spacing is mock-up 6's (`.namerow`, `.hacts`): 24px above the name row, 16px
 * under it (12px below `md`), 24px above the actions and a 12px gap. From `md` the
 * actions are a wrapping row at their own widths. From 480px to `md` they are equal
 * columns of one row (`grid-flow-col auto-cols-fr`), so one, two or three actions always
 * share the width evenly, whatever their padding or label length (AECI-1778). Below 480px
 * they stack in one full-width column, so a longer label such as "Sign in to review" stays
 * on one line and every action keeps the 44px height. A projected wrapper, such as
 * `aec-review-cta`, must let its button fill it.
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
      <div [class]="wrap()">
        <ng-content select="[heroCrumbs]" />
        <div [class]="gridClass()" data-testid="hero-band-grid">
          <div [class]="textClass()" data-testid="hero-band-text">
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
                  <span [class]="titleClass()">
                    <ng-content select="[heroTitle]" />
                  </span>
                </h1>
                <div class="mt-3 empty:hidden">
                  <ng-content select="[heroByline]" />
                </div>
              </div>
            </div>
            <ng-content />
            <div
              class="mt-6 flex flex-wrap gap-3 empty:hidden max-md:grid min-[480px]:max-md:auto-cols-fr min-[480px]:max-md:grid-flow-col"
              data-testid="hero-band-actions"
            >
              <ng-content select="[heroActions]" />
            </div>
          </div>
          <div [class]="panelClass()">
            <ng-content select="[heroPanel]" />
          </div>
        </div>
      </div>
    </div>
  `,
})
export class HeroBand {
  /**
   * The title's size. `display` is the default: the product name, and the vendor name.
   * `statement` is the pair page's h1 (DESIGN.md §3, `--t-statement`, AECI-1798), the
   * pair page's one display-scale line. `statement-wide` is mock-up 5's statement on the
   * empty pair page (AECI-1835), sized for a text column beside a 540px diagram. The size
   * sits on the inner span either way.
   */
  readonly titleSize = input<'display' | 'statement' | 'statement-wide'>('display');
  /**
   * The bottom padding. `overlap` is the default: 128px from `md`, room for a card that
   * pulls up over the band. `band` is a plain band's 64px, 96px from `md`, for a hero
   * that nothing overlaps (the empty pair page while its interest card is held, AECI-1835).
   */
  readonly bottom = input<'overlap' | 'band'>('overlap');
  /**
   * The right column's ground. `surface` is the default: the `--surface-hero-panel`
   * panel with its padding. `bare` draws no panel, for a caller whose projected content
   * is already its own white cards on Forest, as the pair page's two products are
   * (mock-up 12, AECI-1798). The column, its width and its forced-colours edge are the same.
   */
  readonly panel = input<'surface' | 'bare'>('surface');
  /**
   * Where the text column sits beside a taller panel from `lg`. `center`, the default,
   * centres it, as mock-up 12 does beside the pair page's two product cards. `start`
   * pins it to the top of the grid, as mock-up 6 does on the product page: the kicker
   * and the name sit just under the breadcrumb, whatever the panel's height (AECI-1720
   * restore C). Without a panel there is one column, so both read the same.
   */
  readonly align = input<'center' | 'start'>('center');

  /**
   * Where the right column starts. `lg` is the default: 400px from `lg`, 540px from `xl`.
   * `wide` gives the panel a fixed 540px column from 1040px, as mock-up 5 does for the
   * empty pair page's diagram (AECI-1835), and stacks it under the text below that. The
   * `wide` columns are top-aligned, as the mock-up draws them: a centred text column beside
   * a taller diagram moved whole when the web font swapped in and re-wrapped a long name
   * (layout shift 0.068 at 1280).
   */
  readonly panelFrom = input<'lg' | 'wide'>('lg');

  protected readonly gridClass = computed(() =>
    this.panelFrom() === 'wide'
      ? 'grid gap-8 min-[1040px]:items-start min-[1040px]:has-[.aec-hero-panel>*]:grid-cols-[minmax(0,1fr)_540px]'
      : 'grid gap-8 lg:items-center lg:has-[.aec-hero-panel>*]:grid-cols-[minmax(0,1fr)_400px] xl:has-[.aec-hero-panel>*]:grid-cols-[minmax(0,1fr)_540px]',
  );

  protected readonly wrap = computed(() =>
    this.bottom() === 'band'
      ? `${BAND_WRAP_CLASS} pt-4 pb-16 md:pt-6 md:pb-24`
      : `${BAND_WRAP_CLASS} pt-4 pb-24 md:pt-6 md:pb-32`,
  );

  /**
   * Below `md` the display title steps down to `--t-statement` (37px at 390, 36px at 320),
   * mock-up 7's phone size. At `--t-display` (47px at 390) a long word such as "Management"
   * did not fit beside the 68px mark and broke mid-word. Below 360px it steps once more, to
   * `--t-fig` (28px): at 320px the column beside the mark is 188px, and "Construction" or
   * "Management" at 36px is wider than that. The step is `!important` because Tailwind
   * sorts the arbitrary `max-[360px]` query before `max-md`, which would otherwise win.
   * The `h1` keeps `break-words`, so a word still
   * breaks only when it cannot fit on a line of its own (AECI-1720 restore).
   */
  protected readonly titleClass = computed(() => {
    switch (this.titleSize()) {
      case 'statement':
        return 'font-display text-t-statement font-normal tracking-[-0.02em]';
      case 'statement-wide':
        // Balanced, as mock-up 5's `.statement` is, so the lines break as it draws them.
        return 'block font-display text-t-statement-wide font-normal tracking-[-0.02em] text-balance';
      default:
        return 'font-display text-t-display font-normal tracking-[-0.02em] max-md:text-t-statement max-[360px]:text-t-fig!';
    }
  });

  protected readonly textClass = computed(
    () => `min-w-0${this.align() === 'start' ? ' lg:self-start' : ''}`,
  );

  protected readonly panelClass = computed(
    () =>
      `${
        this.panel() === 'bare'
          ? 'aec-hero-panel min-w-0 empty:hidden'
          : 'aec-hero-panel min-w-0 rounded-card bg-(--surface-hero-panel) p-6 empty:hidden md:p-8'
      }`,
  );
}
