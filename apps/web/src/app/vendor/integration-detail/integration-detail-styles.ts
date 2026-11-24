import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
} from '../../shared/form-field/form-field-classes';
import type { ChipTone } from '../../shared/chip/chip';
import type { AecIconName } from '../../shared/icon/icon-registry';
import { PORTAL_FORM_CLASS, PORTAL_SAVE_STATUS_CLASS } from '../shared/portal-form';

import type { Tone } from './integration-detail-model';

/**
 * Shared styling for the integration detail page (§6.17), in the portal's design
 * language (AECI-1811, mock-up 13).
 *
 * Buttons are `aecButton`, icons `aec-icon`, statuses `aec-chip`, panels `aecCard`.
 * What is left here is the handful of class strings several files in this folder
 * share. The page used to carry its own unlayered component CSS (borders, heading
 * sizes, pills, segmented toggles). AECI-2088 made border utilities apply, and the
 * global heading rules size `h2` and `h3`, so all of that is gone.
 *
 * Whole class names, so Tailwind's scanner sees each one. Light only.
 */
export const ID_STYLES = `:host { display: block; }`;

/** Help under a control: 12px secondary ink. */
export const HELP = `mt-1 ${FIELD_HINT_CLASS}`;
/** An inline refusal or field error. Carries `role="alert"` where it is used. */
export const ALERT = FIELD_ERROR_CLASS;
/** A text input, textarea or select: the shared field recipe. */
export const INPUT = FIELD_INPUT_CLASS;

/**
 * A form nested inside a row or a section: a white panel with the default edge. It
 * is white so the nested save bar (below) sits on the same ground. It carries
 * `PORTAL_FORM_CLASS` whole: that class is scroll margins only, no layout, and it
 * keeps a control focused by Tab clear of the sticky bar (WCAG 2.4.11). Every form
 * that renders `NESTED_SAVE_BAR` binds this panel.
 */
export const FORM_PANEL = `rounded-panel border border-(--border-default) bg-(--surface-base) p-4 ${PORTAL_FORM_CLASS}`;

/** A read-only note inside a row (a company's note, a reason): the sunken panel. */
export const NOTE_PANEL = 'rounded-panel bg-(--surface-sunken) px-4 py-3';

/**
 * The save bar of a form nested in a row: part 1's `saveBarClass`
 * (`components/vendor-integration-edit-form.ts`), the same string, so the two read
 * alike. It does not pull out over a card's padding, because the form is not the card.
 */
export const NESTED_SAVE_BAR =
  'aec-portal-save-bar sticky bottom-0 z-10 mt-8 flex flex-wrap items-center justify-end gap-x-6 gap-y-3 border-t bg-(--surface-base) py-4';

/** The nested save bar's status line, at the start. Plain text, never a live region. */
export const NESTED_SAVE_STATUS = PORTAL_SAVE_STATUS_CLASS;

/** The in-text link role (DESIGN.md, "The Link Treatment Rule"). */
export const IN_TEXT_LINK =
  'rounded-mark text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/**
 * A status on `aec-chip` (AECI-1811). The tones are the ones the portal's status
 * pill already drew: Forest wash for up to date, the one red for a disagreement, a
 * strong edge for everything else. Work that needs someone keeps its own mark (it
 * was a Clay dot), so the two strong-edged states still differ by more than words.
 * The integrations list and every status on the detail page read these two maps.
 */
export const STATUS_CHIP_TONE: Record<Tone, ChipTone> = {
  ok: 'wash',
  conflict: 'error',
  attention: 'strong',
  neutral: 'strong',
};

export const STATUS_CHIP_ICON: Record<Tone, AecIconName | null> = {
  ok: 'check',
  conflict: 'x',
  attention: 'exclamation',
  neutral: null,
};

/**
 * The portal's own toggles on the site's segmented control (DESIGN.md §5 "Segmented
 * control"; the Cards/Table toggle's recipe): a 44px framed track with the field
 * edge, 36px segments, the pressed one solid Forest with white text and a tick.
 * The track wraps. `aec-view-toggle-btn` maps the pressed segment to `Highlight` in
 * forced colours. Kept in behaviour on every portal list (ruled 2026-11-24).
 */
export const SEGMENTED_CLASS =
  'aec-field-control inline-flex max-w-full flex-wrap gap-1 border bg-(--surface-base) p-[3px]';
const SEGMENT_BASE =
  'aec-view-toggle-btn inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-mark px-4 text-t-14 font-semibold transition-colors duration-fast ease-standard focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-60';
const SEGMENT_PRESSED = 'bg-(--accent-primary) text-(--surface-base)';
const SEGMENT_RESTING = 'text-(--text-primary) hover:bg-(--surface-sunken)';

/** One segment: Forest when pressed. The caller adds a tick, so the state is not colour alone. */
export function segmentClass(pressed: boolean): string {
  return pressed ? `${SEGMENT_BASE} ${SEGMENT_PRESSED}` : `${SEGMENT_BASE} ${SEGMENT_RESTING}`;
}
