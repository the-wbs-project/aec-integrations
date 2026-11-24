/**
 * The console table recipe (AECI-1813, mock-up 14's legend, DESIGN.md §5
 * "Operator console"). One table look for every admin screen. A slice converts a
 * table by binding these constants, one per element, and deleting its own class
 * strings. Widths (`min-w-[…]` on the table) and column choices stay with the
 * screen.
 *
 * ```html
 * <div [class]="t.region" role="region" tabindex="0" aria-labelledby="jobs-cap">
 *   <table [class]="t.table" class="min-w-[36rem]">
 *     <caption id="jobs-cap" [class]="t.caption" i18n>Scheduled jobs</caption>
 *     <thead><tr>
 *       <th scope="col" [class]="t.head">Job</th>
 *       <th scope="col" [class]="t.headNum">Rows</th>
 *     </tr></thead>
 *     <tbody>
 *       <tr [class]="t.row">
 *         <th scope="row" [class]="t.rowHead">{{ name }}<span [class]="t.sub">{{ slug }}</span></th>
 *         <td [class]="t.num">{{ rows | number }}</td>
 *       </tr>
 *     </tbody>
 *   </table>
 * </div>
 * ```
 *
 * The parts, as the legend rules them:
 * - Region: scrolls sideways, `role="region"`, `tabindex="0"`, labelled by the
 *   caption. No shadow, radius or fill of its own. It is a size container, so an
 *   expanded row's content can pin to its start edge.
 * - Caption: visually hidden, with an id. The visible `h2`/`h3` names the section.
 * - Header cells: the Label role (13px, 600, sentence case, secondary ink), a
 *   hairline above and a strong rule below. Not sticky: a region that scrolls
 *   sideways has no vertical scroll, so a sticky header could never stick.
 * - Rows: hairlines, no zebra. Hover and focus-within take the muted fill.
 * - Identity cell: `th scope="row"` at 600, the record's link. A second line
 *   (`sub`) at 13px secondary for the slug or email.
 * - Numbers: end-aligned, tabular and lining figures, no wrap.
 * - Compact: 8px cells. A 44px control (`act`, `disclosure`) takes no block
 *   padding, so a row with one is 45px.
 * - Expandable row: one leading 44px disclosure (`AdminDisclosureButton`). Open,
 *   the row takes `rowOpen` and its detail row `detailRow`: both on the raised
 *   fill, the pair closed by a strong rule. The detail content sits in
 *   `detailInner`, which sticks to the region's start edge and is never wider
 *   than the region.
 * - Selected: `rowSelected`, the Forest-soft fill. The ticked checkbox is the
 *   signal, not the fill.
 * - Empty: no table. One line of text (`empty`) where the table was.
 *
 * Border colours here are utilities, which apply since AECI-2088 moved the global
 * border rule into the base layer.
 */

// No alignment in the shared part: `text-start` and `text-end` in one class list
// would be decided by stylesheet order, not by which comes last.
const CELL = 'px-3 py-2 align-middle border-b border-(--border-default)';

export const CONSOLE_TABLE = {
  /** The scroll region around the table. */
  region:
    'relative @container min-w-0 overflow-x-auto focus-visible:outline-3 focus-visible:outline-offset-0',
  /** The table. Add the screen's own `min-w-[…]` beside it. */
  table: 'w-full border-collapse text-t-14 leading-6',
  /** The visually hidden caption. */
  caption: 'sr-only text-start',
  /** A header cell. */
  head: 'whitespace-nowrap px-3 py-2 text-start align-bottom text-t-13 font-semibold leading-[1.4] tracking-[0.01em] text-(--text-secondary) border-t border-b border-t-(--border-default) border-b-(--border-strong)',
  /** A header cell over a number column. */
  headNum:
    'whitespace-nowrap px-3 py-2 text-end align-bottom text-t-13 font-semibold leading-[1.4] tracking-[0.01em] text-(--text-secondary) border-t border-b border-t-(--border-default) border-b-(--border-strong)',
  /** A body row. */
  row: 'hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  /** A selected body row. */
  rowSelected: 'bg-(--accent-primary-soft)',
  /** An expanded row: the raised fill, no rule between it and its detail row. */
  rowOpen: 'bg-(--surface-raised) [&>*]:border-b-transparent',
  /** The detail row under an expanded row. */
  detailRow: 'bg-(--surface-raised)',
  /** The one cell of the detail row (`colspan` the whole table). */
  detailCell: 'px-3 pb-6 md:ps-14 border-b border-(--border-strong)',
  /** The detail content: pinned to the region's start edge, never wider than it. */
  detailInner: 'sticky start-0 w-[calc(100cqw-24px)] max-w-full md:w-[calc(100cqw-68px)]',
  /** A body cell. */
  cell: `${CELL} text-start`,
  /** The identity cell, a `th scope="row"`. */
  rowHead: `${CELL} text-start font-semibold`,
  /** A number cell. */
  num: `${CELL} text-end tabular-nums lining-nums whitespace-nowrap`,
  /** A cell that must not wrap (a date). */
  nowrap: `${CELL} text-start whitespace-nowrap`,
  /** The last cell, holding the row's direct actions. */
  act: 'px-3 py-0 text-end align-middle whitespace-nowrap border-b border-(--border-default)',
  /** The leading cell, holding the row's one 44px disclosure. */
  disclosure: 'w-13 py-0 ps-1 pe-0 align-middle border-b border-(--border-default)',
  /** The second line inside a cell. */
  sub: 'block text-t-13 font-normal leading-[1.4] text-(--text-secondary)',
  /** A link inside a cell: the row's ink, Forest and underlined on hover. */
  link: 'rounded-mark text-inherit no-underline underline-offset-3 hover:text-(--accent-primary) hover:underline',
  /** The one line shown in place of an empty table. */
  empty: 'text-t-16 text-(--text-secondary)',
} as const;

export type ConsoleTablePart = keyof typeof CONSOLE_TABLE;

/**
 * A console panel (ruled 2026-11-24: "Flat, bordered, panel radius. No shadow").
 * White, a hairline, 16px corners, 24px padding. Its heading is a plain `h3` at
 * the global size, and the first thing under it sits 16px down.
 */
export const CONSOLE_PANEL_CLASS =
  'min-w-0 rounded-panel border border-(--border-default) bg-(--surface-base) p-6';

/** The Label role, for a `dt` or a panel's small label (`FIELD_LABEL_CLASS`'s type). */
export const CONSOLE_LABEL_CLASS =
  'block text-t-13 font-semibold leading-[1.4] tracking-[0.01em] text-(--text-secondary)';

/** A caption or intro line under a heading: 14px secondary. */
export const CONSOLE_CAPTION_CLASS = 'text-t-14 text-(--text-secondary)';
