import { DATA_OBJECT_ICONS } from '../shared/icon/icon-maps';
import type { AecIconName } from '../shared/icon/icon-registry';

/**
 * The integration card recipe (DESIGN.md "The integration card"): one roomy card for
 * one integration, from mock-ups 5 and 6 (`.card`), given more room after the owner's
 * reviews of 2026-11-18. Two users: the empty pair page's closest-match card (AECI-1835)
 * and the product page's integration card (AECI-1720), with the connector page's hub
 * cards on its compact variant. Class strings only, like `integration-filter-recipe.ts`,
 * because the cards' contents differ (a lane row, Via rows, under-review markers).
 *
 * Light only. No new token, size or radius.
 */

/** The card body: 24px padding on a phone, 32px from md, 20px between blocks. */
export const MATCH_CARD_BODY_CLASS = 'flex h-full flex-col gap-5 p-6 md:p-8';

/** The card, for a caller whose card is not `interactive`: the body with its own hover. */
export const MATCH_CARD_CLASS = `group/card relative ${MATCH_CARD_BODY_CLASS} transition-shadow duration-base ease-standard hover:shadow-menu`;

/**
 * The compact variant, for a card nested inside a group card on the connector page:
 * 24px padding at every width and 16px between blocks, so a nested card is neither
 * cramped nor larger than the cards beside its group.
 */
export const MATCH_CARD_COMPACT_BODY_CLASS = 'flex h-full flex-col gap-4 p-6';

/** The name's type: the Title role (`--t-24`), one step above the mock-ups' 20px, on a
 *  1.1 line. Put it on the name's own element (a heading's unlayered rule beats a size
 *  utility on the heading itself). */
export const MATCH_CARD_NAME_TEXT_CLASS = 'font-display text-t-24 leading-[1.1] font-semibold';

/** The name as a heading that carries its own size (an `h4`, which no unlayered rule sizes). */
export const MATCH_CARD_NAME_CLASS = `m-0 ${MATCH_CARD_NAME_TEXT_CLASS} break-words`;

/** The compact variant's name: the Card title role (`--t-20`). */
export const MATCH_CARD_COMPACT_NAME_TEXT_CLASS = 'text-t-20 leading-tight font-semibold';

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

/**
 * The card grid (`.aec-integration-grid` in `styles.css`): one column on a phone, two
 * from md, and a third only where every card would still be at least 400px wide. The
 * page wrap caps a list at 1,232px, under the 1,248px three such cards need, so a page
 * list never takes three.
 */
export const MATCH_CARD_GRID_CLASS = 'aec-integration-grid';

/** A data object's glyph on its chip, where the icon map has one. */
export function matchChipIcon(slug: string): AecIconName | null {
  return (DATA_OBJECT_ICONS as Readonly<Record<string, AecIconName | null>>)[slug] ?? null;
}
