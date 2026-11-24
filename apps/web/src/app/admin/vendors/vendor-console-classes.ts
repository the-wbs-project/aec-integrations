import { CONSOLE_PANEL_CLASS } from '../console/console-table';

/**
 * Class constants the admin vendor pages share (AECI-2112, mock-up 14's "detail"
 * page). The table, panel, label and filter recipes are the console's own
 * (`admin/console/*`), and so are the notice, facts, status-line and load-failure
 * looks (`admin/console/console-detail.ts`, AECI-1729); the form and body constants
 * are the moderation queues' (`admin/reviews/queue-classes.ts`). These are the few
 * pieces the vendor pages need on top of both.
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

/**
 * A `dl` of label and value pairs side by side (a hide's record, a confirm's
 * summary): the term column sizes to its longest term from 640px.
 */
export const VENDOR_PAIRS_CLASS =
  'grid gap-x-4 gap-y-2 text-t-14 sm:grid-cols-[max-content_minmax(0,1fr)]';
