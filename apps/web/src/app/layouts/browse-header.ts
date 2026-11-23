/**
 * The page header's parts on the browse pages: `/products`, the four taxonomy
 * term pages and the four taxonomy index pages (AECI-1794, AECI-1795, mock-up
 * 10). One spelling, so the headers cannot drift apart (DESIGN.md "The
 * Same-Behavior Rule").
 *
 * Order: the breadcrumb, the `h1`, the lede, then an optional count line.
 *
 * - `title`: 16px below the breadcrumb. No size class. The `h1` takes the
 *   Headline role (`--t-fig`) from the unlayered global `h1` rule, and a size
 *   utility would lose to that rule anyway.
 * - `lede`: the Lede role, 20px sans at 1.5, secondary, 42rem measure.
 * - `count`: the term page's product count, 14px secondary.
 */
export const BROWSE_HEADER_CLASS = {
  title: 'mt-4',
  lede: 'mt-3 max-w-2xl text-t-20 text-(--text-secondary)',
  count: 'mt-3 text-t-14 text-(--text-secondary)',
} as const;
