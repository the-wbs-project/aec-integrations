/**
 * The table view of an integration list on the product page, as class strings: the
 * Integrations section's table (`product-integrations-table.ts`, its rows in
 * `product-integration-row.ts`) and the hub tables of "Integrations it powers"
 * (`product-powered-table.ts`, AECI-1924). One pattern, one look (the Same-Behavior
 * Rule), so the classes live here once, as the filter panel's do in
 * `integration-filter-recipe.ts`.
 *
 * `ProductIntegrationRow` keeps its classes as static attributes, because a bound
 * `[class]` reorders the tokens and the AECI-711 null-case snapshots compare its markup
 * byte for byte. `integration-table-recipe.spec.ts` fails if its literals and these
 * strings ever differ, so the two cannot drift.
 */

/** The white card the table sits in (mock-up 6, `.table-wrap`). A wide table scrolls inside it. */
export const INTEGRATION_TABLE_FRAME_CLASS =
  'overflow-x-auto rounded-card bg-(--surface-base) shadow-card';

/**
 * The same box inside a group card (a Via lane, a hub): no radius and no shadow of its
 * own, so the Bone header row runs edge to edge with square corners and the group card's
 * own radius clips the table's foot. A rounded frame there drew a curved shape inside a
 * square one (Chris, 2026-11-19, AECI-1924). A wide table still scrolls inside it.
 */
export const INTEGRATION_TABLE_NESTED_FRAME_CLASS = 'overflow-x-auto bg-(--surface-base)';

/**
 * The table. 34rem from `md` fits the 608px body column when the facts sidebar docks at
 * `lg` (see `product-integrations-table.ts`). Below `md` the table has two columns and
 * no floor, so it never scrolls the page sideways.
 */
export const INTEGRATION_TABLE_CLASS = 'w-full border-collapse text-start text-sm md:min-w-[34rem]';

/** The Bone header row. */
export const INTEGRATION_TABLE_HEAD_CLASS =
  'border-b border-(--border-default) bg-(--accent-warm) text-start text-xs font-semibold tracking-wide text-(--text-secondary)';

/** A header cell. */
export const INTEGRATION_TABLE_TH_CLASS = 'px-4 py-3 text-start font-semibold';

/** A header cell for the Connection column, which folds into the meta line below `md`. */
export const INTEGRATION_TABLE_TH_MD_CLASS =
  'hidden px-4 py-3 text-start font-semibold md:table-cell';

/** The trailing header cell over the row links. */
export const INTEGRATION_TABLE_TH_LINK_CLASS = 'px-4 py-3';

/** The body, a hairline between rows. */
export const INTEGRATION_TABLE_BODY_CLASS = 'divide-y divide-(--border-default)';

/**
 * A row. No `relative`: a `<tr>` cannot anchor positioned children in Safari < 27, so a
 * row click is forwarded to the row's link (`forwardRowClick`). `group` lets the meta
 * line step from tertiary to secondary when the fill goes muted.
 */
export const INTEGRATION_TABLE_ROW_CLASS =
  'group cursor-pointer text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)';

/** The first cell: the product, its logo and the meta line. */
export const INTEGRATION_TABLE_FIRST_CELL_CLASS = 'px-4 py-3 font-semibold';

/**
 * The meta line under the product name: direction at every width, and below `md` the
 * mechanism and the data-object count. Tertiary at rest, secondary on the muted fill
 * (DESIGN.md "Tertiary": never on muted).
 */
export const INTEGRATION_TABLE_META_CLASS =
  'mt-1 flex flex-wrap items-center gap-x-2 text-xs text-(--text-tertiary) transition-colors group-hover:text-(--text-secondary) group-focus-within:text-(--text-secondary)';

/** The Connection cell, hidden below `md`. */
export const INTEGRATION_TABLE_CONNECTION_CELL_CLASS =
  'hidden px-4 py-3 text-(--text-secondary) md:table-cell';

/** The trailing cell that holds the row's pair-page link. */
export const INTEGRATION_TABLE_LINK_CELL_CLASS = 'px-4 py-3 text-end align-middle';

/** The row's pair-page link: the chevron, a 24px target (WCAG 2.2 SC 2.5.8). */
export const INTEGRATION_TABLE_ROW_LINK_CLASS =
  'inline-flex size-6 items-center justify-center rounded-mark align-middle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
