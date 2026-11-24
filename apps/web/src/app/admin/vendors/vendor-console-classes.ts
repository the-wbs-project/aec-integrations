import { CONSOLE_PANEL_CLASS } from '../console/console-table';

/**
 * Class constants the admin vendor pages share (AECI-2112, mock-up 14's "detail"
 * page). The table, panel, label and filter recipes are the console's own
 * (`admin/console/*`); the notice, form and body constants are the moderation
 * queues' (`admin/reviews/queue-classes.ts`). These are the few pieces the vendor
 * pages need on top of both.
 */

/**
 * A panel on the vendor page: the console panel, positioned so a visually hidden
 * caption or label inside it is clipped to the panel and never escapes it.
 */
export const VENDOR_PANEL_CLASS = `relative ${CONSOLE_PANEL_CLASS}`;

/** The stack of panels on a tab: 24px apart, under the tab row. */
export const VENDOR_PANEL_STACK_CLASS = 'mt-6 grid gap-6';

/** A link inside running text or a fact: the text's own ink, underlined. */
export const VENDOR_INLINE_LINK_CLASS =
  'rounded-mark font-semibold text-(--text-primary) underline decoration-(--border-strong) underline-offset-4 hover:decoration-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** A short status line under a heading: loading, empty, a count. 16px secondary. */
export const VENDOR_STATUS_LINE_CLASS = 'text-t-16 text-(--text-secondary)';

/** A load failure: the sentence, then its Try again button. */
export const VENDOR_LOAD_FAILED_CLASS = 'grid justify-items-start gap-4';

/** The sentence of a load failure or a refused write. */
export const VENDOR_FAILED_TEXT_CLASS = 'text-t-16 font-semibold text-(--text-primary)';

/**
 * An inline decision form (mock-up 14's seat and hide forms): a hairline above,
 * fields 16px apart, capped at 36rem. The queues' `QUEUE_FORM_CLASS` spaces a
 * one-field form at 8px; these forms carry up to six fields.
 */
export const VENDOR_FORM_CLASS = 'grid max-w-[36rem] gap-4 border-t border-(--border-default) pt-4';

/** The same form inside a panel, under its intro: no hairline of its own. */
export const VENDOR_PANEL_FORM_CLASS = 'grid max-w-[36rem] gap-4';

/** One field in an inline form: label, hint, control, error. */
export const VENDOR_FIELD_CLASS = 'grid gap-2';

/** The button row at the foot of an inline form. */
export const VENDOR_ACTIONS_CLASS = 'flex flex-wrap items-center gap-3';

/** A `dl` of facts: Label-role terms over 16px values, in a grid that fills the panel. */
export const VENDOR_FACTS_CLASS =
  'grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-x-6 gap-y-4 md:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]';

/** A fact's value. */
export const VENDOR_FACT_VALUE_CLASS = 'mt-1 text-t-16 text-(--text-primary) wrap-anywhere';

/**
 * A `dl` of label and value pairs side by side (a hide's record, a confirm's
 * summary): the term column sizes to its longest term from 640px.
 */
export const VENDOR_PAIRS_CLASS =
  'grid gap-x-4 gap-y-2 text-t-14 sm:grid-cols-[max-content_minmax(0,1fr)]';
