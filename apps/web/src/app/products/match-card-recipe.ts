/**
 * The match card recipe (AECI-1835, DESIGN.md "The match card"): the empty pair page's
 * closest-match card, from mock-up 5's `.card`, given more room after the owner's review
 * of 2026-11-18. Class strings only, like `integration-filter-recipe.ts`, so the product
 * page's integration card can adopt the same set in a follow-up without sharing a
 * component (its content differs: a lane row, captions, under-review markers).
 *
 * Light only. No new token, size or radius.
 */

/** The card: 24px padding on a phone, 32px from md, 20px between blocks. */
export const MATCH_CARD_CLASS =
  'group/card relative flex h-full flex-col gap-5 p-6 transition-shadow duration-base ease-standard hover:shadow-menu md:p-8';

/** The name: the Title role (`--t-24`), one step above the mock-up's 20px, on a 1.1 line. */
export const MATCH_CARD_NAME_CLASS =
  'm-0 font-display text-t-24 leading-[1.1] font-semibold break-words';

/** The byline under the name. */
export const MATCH_CARD_BYLINE_CLASS = 'm-0 mt-1 text-t-13 text-(--text-secondary)';

/** Mock-up 5's `.rates` box: 16px padding, 8px rows, the raised fill and default edge. */
export const MATCH_CARD_SCORES_CLASS =
  'grid gap-2 rounded-control border bg-(--surface-raised) p-4 text-t-13';

/**
 * One score row. The label never wraps. Where the box is too narrow for the label, the
 * stars and the score on one line (below sm, and from md to lg in two columns), every
 * row stacks the stars under its label, so no row is two lines beside a one-line row.
 */
export const MATCH_CARD_SCORE_ROW_CLASS =
  'flex items-center justify-between gap-3 max-sm:flex-col max-sm:items-start max-sm:gap-1 md:max-lg:flex-col md:max-lg:items-start md:max-lg:gap-1';

/** A labelled block ("Shares with", "Moves with"): 4px more above it than the card gap. */
export const MATCH_CARD_BLOCK_CLASS = 'mt-1 space-y-2';

/** Mock-up 5's `.mini` chip: 31px, 13px at 600 on a 1.6 line, the sunken fill. */
export const MATCH_CHIP_CLASS =
  'inline-flex items-center gap-1 rounded-pill bg-(--surface-sunken) py-[5px] ps-2 pe-3 text-t-13 leading-[1.6] font-semibold text-(--text-primary)';

/** The same chip while the reader has picked its data object: Forest soft with a Forest edge. */
export const MATCH_CHIP_HIT_CLASS =
  'inline-flex items-center gap-1 rounded-pill bg-(--accent-primary-soft) py-[5px] ps-2 pe-3 text-t-13 leading-[1.6] font-semibold text-(--accent-primary) ring-1 ring-(--accent-primary) ring-inset';

/** A chip's 14px glyph. */
export const MATCH_CHIP_ICON_CLASS = 'text-(--text-secondary)';

/** Chips wrap with 8px gaps. */
export const MATCH_CHIP_ROW_CLASS = 'flex flex-wrap gap-2';

/** The foot: the pair link, its stretched target the whole card, 4px above. */
export const MATCH_CARD_FOOT_CLASS =
  'mt-auto flex items-center justify-between gap-3 pt-1 text-t-14 font-semibold text-(--text-secondary) no-underline transition-colors after:absolute after:inset-0 after:rounded-card group-hover/card:text-(--text-primary)';

/** The foot's 34px round button. It holds a chevron, never an arrow (the Arrow Rule). */
export const MATCH_CARD_GO_CLASS =
  'grid size-8.5 shrink-0 place-items-center rounded-full bg-(--surface-sunken) transition-colors group-hover/card:bg-(--surface-sunken-hover)';
