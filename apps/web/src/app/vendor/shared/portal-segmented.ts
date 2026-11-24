/**
 * The portal's own toggles on the site's segmented control (DESIGN.md §5 "Segmented
 * control"; the Cards/Table toggle's recipe): a 44px framed track with the field
 * edge, 36px segments, the pressed one solid Forest with white text and a tick.
 * The track wraps. `aec-view-toggle-btn` maps the pressed segment to `Highlight` in
 * forced colours. Kept in behaviour on every portal list (ruled 2026-11-24).
 *
 * Built by AECI-1811 in `integration-detail/integration-detail-styles.ts`, moved here by
 * AECI-1812 so the integrations list, the detail page, Conversations and Changes read
 * one copy. Whole class names, so Tailwind's scanner sees each one. Light only.
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
