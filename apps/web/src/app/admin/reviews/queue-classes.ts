/**
 * Class constants the four moderation queues share (AECI-2102): `admin/reviews`,
 * `admin/review-updates`, `admin/review-responses` and `admin/contests`. They
 * dress each row's expanded detail and its decision forms. The filter row is the
 * console's own piece, `CONSOLE_FILTER` in `admin/console/console-filter.ts`.
 */

/** A detail row's two columns: the record on the start side, the decision on the end side. */
export const QUEUE_DETAIL_GRID_CLASS =
  'grid gap-x-12 gap-y-6 pt-2 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]';

/** Long free text in a detail row (a review, an update, a reply, a reason). */
export const QUEUE_BODY_CLASS =
  'max-w-[42rem] whitespace-pre-line text-t-16 leading-relaxed text-(--text-primary)';

/** A row of small facts (`dl`) in a detail row. */
export const QUEUE_FACTS_CLASS = 'flex flex-wrap gap-x-6 gap-y-2 text-t-14';

/** The help line under a decision's buttons. */
export const QUEUE_HELP_CLASS = 'max-w-prose text-t-14 text-(--text-secondary)';

/** A decision form: label, help, field, error, buttons. */
export const QUEUE_FORM_CLASS = 'grid max-w-[32rem] gap-2 border-t border-(--border-default) pt-4';

/** A row's failure line, under its decision. */
export const QUEUE_FAILED_CLASS = 'text-t-14 font-semibold text-(--text-primary)';
