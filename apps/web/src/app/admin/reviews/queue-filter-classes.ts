import { CONSOLE_LABEL_CLASS } from '../console/console-table';

/**
 * The moderation queues' filter row (AECI-2102, mock-up 14's "queue" page). Each
 * filter is a labelled group of toggle buttons (`aria-pressed`): a segmented
 * control. The pressed one takes the Forest fill AND a tick, so the state is
 * never colour alone. The buttons stay native: a toggle in a segmented group is
 * not an `aecButton` (44px, its own fill and edge). The four queues under
 * `admin/reviews`, `admin/review-updates`, `admin/review-responses` and
 * `admin/contests` share these constants.
 *
 * ```html
 * <div [class]="f.group">
 *   <span id="x-label" [class]="f.label">Status</span>
 *   <div role="group" aria-labelledby="x-label" [class]="f.seg">
 *     <button type="button" [class]="f.option" [attr.aria-pressed]="on">
 *       @if (on) { <aec-icon name="check" decorative [size]="4" /> } Pending
 *     </button>
 *   </div>
 * </div>
 * ```
 */
export const QUEUE_FILTER = {
  /** The row of filter groups, under the page heading. */
  toolbar: 'mt-6 flex flex-wrap items-end gap-x-8 gap-y-4',
  /** One filter: its label over its control. */
  group: 'flex min-w-0 flex-col gap-2',
  /** The Label role over the control: the console's one label recipe. */
  label: CONSOLE_LABEL_CLASS,
  /** The segmented frame: a strong edge on white. */
  seg: 'inline-flex flex-wrap gap-1 rounded-control border border-(--border-strong) bg-(--surface-base) p-1',
  /** One option. Pressed: the Forest fill, white text. */
  option:
    'inline-flex min-h-9 items-center gap-2 rounded-mark px-3 text-t-14 font-semibold leading-none text-(--text-primary) hover:bg-(--surface-sunken) aria-pressed:bg-(--accent-primary) aria-pressed:text-(--surface-base) focus-visible:outline-3 focus-visible:outline-offset-3 forced-colors:aria-pressed:bg-[Highlight] forced-colors:aria-pressed:text-[HighlightText]',
} as const;

/**
 * The queues' notice (mock-up 14 `.warnbox`, the console's one cautionary box):
 * Bone fill, a strong edge, control radius. It replaces the Clay edge the cards
 * used, because Clay never carries an edge in the console.
 */
export const QUEUE_NOTICE_CLASS =
  'rounded-control border border-(--border-strong) bg-(--accent-warm) p-4 text-t-14 text-(--text-primary)';

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
