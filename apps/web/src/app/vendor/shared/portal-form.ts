/**
 * The portal form layout (AECI-1809, mock-up 13's company Profile form, ruled
 * 2026-11-24: "Two columns of fields from 768px. The save bar sticks to the foot of
 * the form card"). Built here so the Profile, product and Billing slices adopt one
 * layout. The fields themselves keep the shared recipe (`FIELD_LABEL_CLASS`,
 * `FIELD_INPUT_CLASS`, `FIELD_HINT_CLASS`, `FIELD_ERROR_CLASS`), and buttons are
 * `aecButton`.
 *
 * The shape:
 *
 * ```html
 * <form aecCard phoneFlush class="p-6 md:p-8" …>
 *   <fieldset [class]="fieldsetClass">
 *     <legend [class]="legendClass" i18n="…">Profile details</legend>
 *     <div [class]="gridClass">
 *       <div [class]="fieldClass + ' ' + spanClass">…a wide field…</div>
 *       <div [class]="fieldClass">…</div>
 *     </div>
 *   </fieldset>
 *   <div [class]="saveBarClass">
 *     <p [class]="saveStatusClass" role="status">…</p>
 *     <button aecButton type="submit" class="max-sm:w-full">Save changes</button>
 *   </div>
 * </form>
 * ```
 *
 * - **Two columns from `md`** (768px), one below. A field that needs the width (a
 *   description, a logo, an option row) spans both with {@link PORTAL_FORM_SPAN_CLASS}.
 * - **Fieldsets** stack 32px apart with a hairline between them. Each `legend` is the
 *   overline role, with 16px under it.
 * - **The save bar** sits at the foot of the form card and sticks to the bottom of
 *   the viewport while the card is on screen. The status line is at the start and the
 *   primary button at the end. Below 640px the button is full width. The bar pulls out
 *   over the card's padding, so its hairline runs edge to edge: it assumes the card's
 *   `p-6`, and `md:p-8` from 768px.
 *
 * Whole class names, so Tailwind's scanner sees each one. Light only.
 */

/** A fieldset in a portal form. The next fieldset stands 32px clear, over a hairline. */
export const PORTAL_FIELDSET_CLASS =
  'm-0 min-w-0 border-0 p-0 [&+&]:mt-8 [&+&]:border-t [&+&]:pt-8';

/** A fieldset's legend: the overline role, 16px above its fields. */
export const PORTAL_LEGEND_CLASS = 'aec-overline mb-4 p-0 text-(--text-secondary)';

/** The field grid: one column, two from `md`, 24px between rows and 32px between columns. */
export const PORTAL_FORM_GRID_CLASS = 'grid gap-x-8 gap-y-6 md:grid-cols-2';

/** A field that spans both columns. */
export const PORTAL_FORM_SPAN_CLASS = 'md:col-span-2';

/** One field's stack: label, control, hint, error, 8px apart. */
export const PORTAL_FIELD_CLASS = 'min-w-0 space-y-2';

/**
 * The sticky save bar at the foot of the form card. It pulls out over the card's
 * padding (24px, 32px from `md`) so the hairline spans the card. Below `sm` the card
 * has no frame (`phoneFlush`), so the bar loses its rounded foot too.
 */
export const PORTAL_SAVE_BAR_CLASS =
  'sticky bottom-0 z-10 -mx-6 -mb-6 mt-8 flex flex-wrap items-center justify-end gap-x-6 gap-y-3 border-t bg-(--surface-base) px-6 py-4 sm:rounded-b-card md:-mx-8 md:-mb-8 md:px-8';

/** The save bar's status line, at the start. It takes the room the button leaves. */
export const PORTAL_SAVE_STATUS_CLASS = 'me-auto min-w-0 flex-[1_1_20rem] text-t-14 leading-[1.5]';

/** The save bar's primary button: full width below `sm`. Goes beside `aecButton`. */
export const PORTAL_SAVE_BUTTON_CLASS = 'max-sm:w-full';
