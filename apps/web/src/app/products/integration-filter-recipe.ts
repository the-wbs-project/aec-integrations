/**
 * The mock-up 6 recipe for an integration list's head, filter panel and list row
 * (AECI-1720), as class strings both product-page lists bind: the Integrations section
 * and "Integrations it powers" (AECI-1788). Two filter panels on one page look and
 * behave alike (the Same-Behavior Rule), so the classes live here once.
 *
 * The panel is Bone, but it is a panel inside the white body band, not a band. The
 * About band stays the page's one Bone band (DESIGN.md §2, "One Bone band").
 */

/** The section `<h2>`'s inner span. The size sits on the span (the Unlayered-Heading Rule). */
export const INTEGRATION_LIST_HEADING_CLASS =
  'font-display text-t-24 leading-tight font-semibold tracking-[-0.02em] text-(--text-primary) md:text-t-36';

/** The filter panel (mock-up 6, `.deck`): one compact Bone panel. */
export const INTEGRATION_FILTER_PANEL_CLASS = 'mt-4 grid gap-4 rounded-card bg-(--accent-warm) p-4';

/** The search box's glyph, inside the field at its start edge. */
export const INTEGRATION_SEARCH_ICON_CLASS =
  'pointer-events-none absolute inset-y-0 start-4 flex items-center text-(--text-secondary)';

/** The search field (mock-up 6, `.sfield`): the field recipe with room for the glyph. */
export const INTEGRATION_SEARCH_INPUT_CLASS =
  'aec-field-control w-full rounded-control border bg-(--surface-base) py-2 ps-11 pe-3 text-t-16 text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** The list row (mock-up 6, `.lane-row`) under the panel: heading, status, "Clear filters". */
export const INTEGRATION_LIST_ROW_CLASS =
  'mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-2';

/** The status and "Clear filters" group at the list row's end. */
export const INTEGRATION_LIST_ROW_END_CLASS =
  'flex flex-wrap items-center gap-x-4 gap-y-1 sm:ms-auto';

/** "Showing n of m", a polite status that stays in the DOM so the first change is heard. */
export const INTEGRATION_STATUS_CLASS = 'text-t-14 text-(--text-secondary)';

/** "Clear filters": an in-text button with its x glyph. */
export const INTEGRATION_CLEAR_CLASS =
  'inline-flex min-h-6 items-center gap-1 rounded-mark text-t-14 font-semibold text-(--accent-primary) underline-offset-2 transition-colors hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
