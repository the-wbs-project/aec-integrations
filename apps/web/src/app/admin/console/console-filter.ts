import { CONSOLE_LABEL_CLASS } from './console-table';

/**
 * The console's segmented filter (AECI-2102, mock-up 14's "queue" page): a
 * labelled group of toggle buttons, one pressed at a time, for a list's Status,
 * Sort by or Show filter. The pressed option takes the Forest fill AND a tick, so
 * the state is never colour alone. In forced-colours mode it maps to Highlight.
 *
 * The options stay native `<button>`s with `aria-pressed`: a toggle in a
 * segmented group is not an `aecButton` (44px, its own fill and edge). The
 * native-button guard counts each `@for` of options once.
 *
 * ```html
 * <div [class]="f.toolbar">
 *   <div [class]="f.group">
 *     <span id="x-status-label" [class]="f.label" i18n="…">Status</span>
 *     <div role="group" aria-labelledby="x-status-label" [class]="f.seg">
 *       @for (opt of options; track opt.key) {
 *         <button type="button" [class]="f.option" [attr.aria-pressed]="value() === opt.key"
 *                 (click)="set(opt.key)">
 *           @if (value() === opt.key) { <aec-icon name="check" decorative [size]="4" /> }
 *           {{ opt.label }}
 *         </button>
 *       }
 *     </div>
 *   </div>
 * </div>
 * ```
 *
 * Bind `f = CONSOLE_FILTER` and one constant per element. The row wraps; each
 * control wraps its own options at 320px.
 */
export const CONSOLE_FILTER = {
  /** The row of filter groups, under the page heading. */
  toolbar: 'mt-6 flex flex-wrap items-end gap-x-8 gap-y-4',
  /** One filter: its label over its control. */
  group: 'flex min-w-0 flex-col gap-2',
  /** The Label role over the control. */
  label: CONSOLE_LABEL_CLASS,
  /** The segmented frame: a strong edge on white. */
  seg: 'inline-flex flex-wrap gap-1 rounded-control border border-(--border-strong) bg-(--surface-base) p-1',
  /** One option. Pressed: the Forest fill, white text. */
  option:
    'inline-flex min-h-9 items-center gap-2 rounded-mark px-3 text-t-14 font-semibold leading-none text-(--text-primary) hover:bg-(--surface-sunken) aria-pressed:bg-(--accent-primary) aria-pressed:text-(--surface-base) focus-visible:outline-3 focus-visible:outline-offset-3 forced-colors:aria-pressed:bg-[Highlight] forced-colors:aria-pressed:text-[HighlightText]',
} as const;
