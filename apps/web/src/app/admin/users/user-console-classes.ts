import {
  CONSOLE_CAPTION_CLASS,
  CONSOLE_LABEL_CLASS,
  CONSOLE_PANEL_CLASS,
} from '../console/console-table';

/**
 * The looks `/admin/users` and `/admin/users/:id` need beyond the console recipe
 * (AECI-2128, mock-up 14's list and detail pages). The table, panel and label are
 * the console's own (`admin/console/*`); fields are the shared field recipe.
 */
export const USER_CLASSES = {
  caption: CONSOLE_CAPTION_CLASS,
  panel: CONSOLE_PANEL_CLASS,
  label: CONSOLE_LABEL_CLASS,
  /** A loading, empty or "not available" line. 16px secondary. */
  statusLine: 'text-t-16 text-(--text-secondary)',
  /** A load failure: the sentence, then its Try again button. */
  loadFailed: 'grid justify-items-start gap-4',
  /** The sentence of a load failure or a refused write. */
  failedText: 'text-t-16 font-semibold text-(--text-primary)',
  /** A fact the operator should know that is not a caution: sunken, hairline. */
  note: 'rounded-control border border-(--border-default) bg-(--surface-sunken) p-4 text-t-14 text-(--text-secondary)',
  /** A caution (mock-up 14 `.warnbox`): Bone fill, strong edge. */
  caution:
    'rounded-control border border-(--border-strong) bg-(--accent-warm) p-4 text-t-14 text-(--text-primary)',
  /** A link inside running text or a fact: the text's own ink, underlined. */
  inlineLink:
    'rounded-mark text-(--text-primary) underline decoration-(--border-strong) underline-offset-4 hover:decoration-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)',
  /** A standalone link under a heading: Forest, underlined. */
  link: 'rounded-mark text-t-14 font-semibold text-(--accent-primary) underline underline-offset-4 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)',
  /** A `dl` of facts: Label-role terms over 16px values, filling the panel. */
  facts:
    'grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-x-6 gap-y-4 md:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]',
  /** A fact's value. */
  factValue: 'mt-1 text-t-16 text-(--text-primary) wrap-anywhere',
  /** A help line under a heading or a table. */
  help: 'text-xs text-(--text-secondary)',
  /** The stack inside a panel: 16px apart. */
  stack: 'grid gap-4',
  /** The button row at the foot of a form. */
  actions: 'flex flex-wrap items-center gap-3',
} as const;
