/**
 * The console's detail-page looks (AECI-1729, mock-up 14's "detail" page), beside the
 * table recipe (`console-table.ts`) and the filter (`console-filter.ts`). Before the
 * cleanup slice each screen folder held its own copy of these strings (claims, vendors,
 * users, legal, DMCA, email, audit, the reporting pages). One constant per look now,
 * and every screen binds it.
 *
 * ```html
 * <dl [class]="factsClass">
 *   <div><dt [class]="labelClass">Plan</dt><dd [class]="factValueClass">{{ plan }}</dd></div>
 * </dl>
 * <div [class]="noticeClass">A caution the operator reads before acting.</div>
 * ```
 *
 * Whole class names, so Tailwind's scanner sees each one. Light only.
 */

/** A `dl` of facts (mock-up 14 `.facts-dl`): Label-role terms over 16px values, auto-fill columns. */
export const CONSOLE_FACTS_CLASS =
  'grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-x-6 gap-y-4 md:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]';

/** A fact's value, under its Label-role term. A long id or URL wraps anywhere. */
export const CONSOLE_FACT_VALUE_CLASS = 'mt-1 text-t-16 text-(--text-primary) wrap-anywhere';

/**
 * The console's cautionary box (mock-up 14 `.warnbox`): Bone fill, a strong edge, control
 * radius. Clay never carries an edge in the console. The danger form's warning uses it too.
 */
export const CONSOLE_NOTICE_CLASS =
  'rounded-control border border-(--border-strong) bg-(--accent-warm) p-4 text-t-14 text-(--text-primary)';

/**
 * A neutral box: a fact the operator should see that is not a caution (the
 * connector-vendor flag, the in-review explainer, publishing turned off on this tier).
 * Sunken, hairline, control radius.
 */
export const CONSOLE_NEUTRAL_BOX_CLASS =
  'rounded-control border border-(--border-default) bg-(--surface-sunken) p-4 text-t-14 text-(--text-primary)';

/**
 * A Forest link inside a detail row or a panel (mock-up 14 `.inlink`): underlined at rest,
 * so it reads as a link outside a table cell. The table's own `link` part is for the
 * identity cell.
 */
export const CONSOLE_FOREST_LINK_CLASS =
  'inline-flex items-center gap-1 rounded-mark text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3';

/** A link inside running text or a cell: the text's own ink, underlined. */
export const CONSOLE_TEXT_LINK_CLASS =
  'rounded-mark text-(--text-primary) underline decoration-(--border-strong) underline-offset-4 hover:decoration-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** A loading, empty or count line under a heading. 16px secondary. */
export const CONSOLE_STATUS_LINE_CLASS = 'text-t-16 text-(--text-secondary)';

/** A load failure: the sentence, then its Try again button. */
export const CONSOLE_LOAD_FAILED_CLASS = 'grid justify-items-start gap-4';

/** The sentence of a load failure or a refused write. */
export const CONSOLE_FAILED_TEXT_CLASS = 'text-t-16 font-semibold text-(--text-primary)';

/** A summary figure under its Label-role term: 24px display face, tabular figures. */
export const CONSOLE_FIGURE_CLASS =
  'mt-1 font-display text-t-24 font-semibold leading-tight tabular-nums lining-nums text-(--text-primary)';
