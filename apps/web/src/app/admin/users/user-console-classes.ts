import {
  CONSOLE_CAPTION_CLASS,
  CONSOLE_LABEL_CLASS,
  CONSOLE_PANEL_CLASS,
} from '../console/console-table';
import {
  CONSOLE_FACTS_CLASS,
  CONSOLE_FACT_VALUE_CLASS,
  CONSOLE_FAILED_TEXT_CLASS,
  CONSOLE_LOAD_FAILED_CLASS,
  CONSOLE_NOTICE_CLASS,
  CONSOLE_STATUS_LINE_CLASS,
  CONSOLE_TEXT_LINK_CLASS,
} from '../console/console-detail';

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
  statusLine: CONSOLE_STATUS_LINE_CLASS,
  /** A load failure: the sentence, then its Try again button. */
  loadFailed: CONSOLE_LOAD_FAILED_CLASS,
  /** The sentence of a load failure or a refused write. */
  failedText: CONSOLE_FAILED_TEXT_CLASS,
  /** A fact the operator should know that is not a caution: sunken, hairline. */
  note: 'rounded-control border border-(--border-default) bg-(--surface-sunken) p-4 text-t-14 text-(--text-secondary)',
  /** A caution (mock-up 14 `.warnbox`): Bone fill, strong edge. */
  caution: CONSOLE_NOTICE_CLASS,
  /** A link inside running text or a fact: the text's own ink, underlined. */
  inlineLink: CONSOLE_TEXT_LINK_CLASS,
  /** A standalone link under a heading: Forest, underlined. */
  link: 'rounded-mark text-t-14 font-semibold text-(--accent-primary) underline underline-offset-4 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)',
  /** A `dl` of facts: Label-role terms over 16px values, filling the panel. */
  facts: CONSOLE_FACTS_CLASS,
  /** A fact's value. */
  factValue: CONSOLE_FACT_VALUE_CLASS,
  /** A help line under a heading or a table. */
  help: 'text-xs text-(--text-secondary)',
  /** The stack inside a panel: 16px apart. */
  stack: 'grid gap-4',
  /** The button row at the foot of a form. */
  actions: 'flex flex-wrap items-center gap-3',
} as const;
