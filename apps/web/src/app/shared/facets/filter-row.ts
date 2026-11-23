/**
 * The filter panel's parts, one spelling for every list that has a filter panel:
 * the `/products` and taxonomy term sidebar (`aec-facet-sidebar`) and `/search`
 * (AECI-1793, mock-up 10, ruling 9 of 2026-11-16). One constant per part, so a
 * row on `/search` cannot drift from a row on `/products` (DESIGN.md "The
 * Same-Behavior Rule"). Whole class names, so Tailwind's scanner sees each one.
 */

/** The group heading: the overline role on a `<legend>`. */
export const FILTER_LEGEND_CLASS = 'aec-overline mb-1 p-0 text-(--text-secondary)';

/**
 * One row: a `<label>` 44px tall (the input floor), so the whole row is the
 * target. The 8px inset puts the hover wash past the checkbox edge without
 * moving the checkbox off the column's start line.
 */
export const FILTER_ROW_CLASS =
  '-mx-2 flex min-h-11 cursor-pointer items-center gap-3 rounded-mark px-2 text-t-14 text-(--text-primary) hover:bg-(--surface-muted)';

/** The checkbox or radio: 20px, Forest when checked, the 3px focus ring. */
export const FILTER_INPUT_CLASS =
  'm-0 size-5 shrink-0 accent-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** The term name. One line, cut with an ellipsis. */
export const FILTER_LABEL_CLASS = 'min-w-0 truncate';

/** The term's count, pushed to the end edge. */
export const FILTER_COUNT_CLASS = 'ms-auto shrink-0 text-t-13 tabular-nums text-(--text-secondary)';

/**
 * "Show more (N)" and "Clear filters": the standalone link role (the Link
 * Treatment Rule) with no padding, so the text lines up with the rows, and a
 * 44px target.
 */
export const FILTER_LINK_CLASS =
  'inline-flex min-h-11 cursor-pointer items-center self-start rounded-mark text-t-14 font-semibold text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 transition-colors hover:text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
