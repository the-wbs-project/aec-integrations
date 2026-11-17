import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { BAND_WRAP_CLASS } from '../band-wrap';

/**
 * AECI-1766 - the Forest hero band of a detail page (DESIGN.md §2 "Forest
 * grounds", §4 "The detail page band shell", ADR 0057). A frame, not a page:
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
 *
 * **Holding the columns (owner ruling 2026-11-17, item 82).** From `lg` the two
 * columns are centred against each other. When a caller grows the panel in
 * place, as the product hero's "Show all" does, centring would push the text
 * column down by half the growth (about 300px with 32 categories). The caller
 * calls `holdColumns()` just before the panel grows. The band measures where each
 * column sits now, then top-aligns both at those offsets, so neither moves.
 * `releaseColumns()` returns to centring. A plain top-align is not enough: when
 * the panel is the taller column, the text is centred some way down, and a
 * top-align would move it up instead. The hold applies only from `lg`, it is set
 * only by a click, and the server never renders it, so cached HTML is unchanged.
 * A caller that never calls it gets today's layout.
 */
@Component({
  selector: 'aec-hero-band',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="aec-hero-band bg-(--accent-primary) text-(--text-on-brand)">
      <div [class]="wrap">
        <div
          #grid
          class="grid gap-8 lg:items-center lg:has-[.aec-hero-panel>*]:grid-cols-[minmax(0,1fr)_400px] xl:has-[.aec-hero-panel>*]:grid-cols-[minmax(0,1fr)_540px]"
          data-testid="hero-band-grid"
        >
          <div
            class="min-w-0 lg:data-held:mt-(--aec-hero-held) lg:data-held:self-start"
            [attr.data-held]="held() ? '' : null"
            [style.--aec-hero-held]="held() ? held()!.text + 'px' : null"
          >
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
          <div
            [class]="panelClass()"
            [attr.data-held]="held() ? '' : null"
            [style.--aec-hero-held]="held() ? held()!.panel + 'px' : null"
          >
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
   * pair page's one display-scale line. The size sits on the inner span either way.
   */
  readonly titleSize = input<'display' | 'statement'>('display');
  /**
   * The right column's ground. `surface` is the default: the `--surface-hero-panel`
   * panel with its padding. `bare` draws no panel, for a caller whose projected content
   * is already its own white cards on Forest, as the pair page's two products are
   * (mock-up 12, AECI-1798). The column, its width and its forced-colours edge are the same.
   */
  readonly panel = input<'surface' | 'bare'>('surface');

  protected readonly wrap = `${BAND_WRAP_CLASS} pt-4 pb-24 md:pt-6 md:pb-32`;

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
  protected readonly titleClass = computed(() =>
    this.titleSize() === 'statement'
      ? 'font-display text-t-statement font-normal tracking-[-0.02em]'
      : 'font-display text-t-display font-normal tracking-[-0.02em] max-md:text-t-statement max-[360px]:text-t-fig!',
  );

  protected readonly panelClass = computed(
    () =>
      `${
        this.panel() === 'bare'
          ? 'aec-hero-panel min-w-0 empty:hidden'
          : 'aec-hero-panel min-w-0 rounded-card bg-(--surface-hero-panel) p-6 empty:hidden md:p-8'
      } lg:data-held:mt-(--aec-hero-held) lg:data-held:self-start`,
  );

  private readonly grid = viewChild.required<ElementRef<HTMLElement>>('grid');

  /** Each column's offset from the grid's top while held, or `null` (centred). */
  protected readonly held = signal<{ readonly text: number; readonly panel: number } | null>(null);

  /**
   * Pin both columns where they sit now. Call it before the panel grows, while the
   * layout is still the old one. Browser only: it is called from a click.
   */
  holdColumns(): void {
    const grid = this.grid().nativeElement;
    const [text, panel] = Array.from(grid.children) as HTMLElement[];
    const top = grid.getBoundingClientRect().top;
    this.held.set({
      text: text.getBoundingClientRect().top - top,
      panel: panel.getBoundingClientRect().top - top,
    });
  }

  /** Return both columns to centring. */
  releaseColumns(): void {
    this.held.set(null);
  }
}
