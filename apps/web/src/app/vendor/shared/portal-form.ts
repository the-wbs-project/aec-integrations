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
 * <form aecCard phoneFlush [class]="formClass + ' p-6 md:p-8'" …>
 *   <fieldset [class]="fieldsetClass">
 *     <legend [class]="legendClass" i18n="…">Profile details</legend>
 *     <div [class]="gridClass">
 *       <div [class]="fieldClass + ' ' + spanClass">…a wide field…</div>
 *       <div [class]="fieldClass">…</div>
 *     </div>
 *   </fieldset>
 *   <div [class]="saveBarClass">
 *     <p [class]="saveStatusClass">{{ status() }}</p>
 *     <button aecButton type="submit" [class]="saveButtonClass">Save changes</button>
 *   </div>
 * </form>
 * ```
 *
 * - **The status line is not a live region.** The portal has ONE polite live region,
 *   in the shell (`STAGE_2_REALTIME_SPEC.md` §6.3: never add a second). Show the
 *   result in the status line as plain text, and announce the same sentence through
 *   `inject(VendorPortalAnnouncer).announce(message)` (`vendor/vendor-announcer.ts`).
 *   A field error stays `role="alert"` beside its field (`FIELD_ERROR_CLASS`).
 * - **A focused field never hides under the bar** (WCAG 2.4.11).
 *   {@link PORTAL_FORM_CLASS} on the `<form>` gives every control in it a bottom
 *   scroll margin taller than the bar, so the browser's own focus scrolling stops it
 *   above the bar: 96px, and 192px below `sm`, where the status line and a full-width
 *   button stack.
 *
 * - **Escape is Cancel in a nested form** (AECI-2133). A form nested in a row, a section
 *   or a card, with a Cancel button, takes `aecCloseOnEscape` (`close-on-escape.ts`):
 *   `[escapeBusy]` is what disables Cancel, and `(escapeCancel)` calls Cancel's own
 *   handler, so both close the same way and return focus to the opener. Not on a form
 *   inside a dialog: the dialog owns Escape.
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

/**
 * On the `<form>` that carries the save bar: every focusable control in it keeps clear
 * of the sticky bar when focus scrolls it into view (WCAG 2.4.11). The margin is a
 * scroll margin, not layout: nothing moves until the browser scrolls to a control.
 */
export const PORTAL_FORM_CLASS =
  '[&_:is(input,select,textarea,button,a,[tabindex]):not(.aec-portal-save-bar_*)]:scroll-mb-24 ' +
  'max-sm:[&_:is(input,select,textarea,button,a,[tabindex]):not(.aec-portal-save-bar_*)]:scroll-mb-48';

/**
 * A fieldset in a portal form. The next fieldset stands 32px clear, over a hairline.
 *
 * The legend floats (mock-up 13's `.fs legend`). A browser draws a fieldset's
 * rendered legend INTO the fieldset's top border, so with the hairline on the
 * fieldset a plain legend sat on the line, cutting it. A floated legend is not the
 * rendered legend: it flows inside the padding, under the hairline, and the first
 * thing after it clears the float.
 */
export const PORTAL_FIELDSET_CLASS =
  'm-0 min-w-0 border-0 p-0 [&+&]:mt-8 [&+&]:border-t [&+&]:pt-8 [&>legend]:float-start [&>legend]:w-full [&>legend+*]:clear-both';

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
  'aec-portal-save-bar sticky bottom-0 z-10 -mx-6 -mb-6 mt-8 flex flex-wrap items-center justify-end gap-x-6 gap-y-3 border-t bg-(--surface-base) px-6 py-4 sm:rounded-b-card md:-mx-8 md:-mb-8 md:px-8';

/**
 * The save bar of a form nested inside a row, a section or another card (the
 * integration detail page's forms, the integrations list's create and edit forms, the
 * connector mapping form). The same sticky bar, but it does not pull out over a card's
 * padding, because the form is not the card. It keeps the `aec-portal-save-bar` marker,
 * so {@link PORTAL_FORM_CLASS} and `aecKeepClearOfSaveBar` (`keep-clear-of-save-bar.ts`)
 * still leave the bar's own controls alone. One constant since AECI-1812: there were
 * three byte-identical copies.
 */
export const PORTAL_NESTED_SAVE_BAR_CLASS =
  'aec-portal-save-bar sticky bottom-0 z-10 mt-8 flex flex-wrap items-center justify-end gap-x-6 gap-y-3 border-t bg-(--surface-base) py-4';

/** The save bar's status line, at the start. It takes the room the button leaves. */
export const PORTAL_SAVE_STATUS_CLASS = 'me-auto min-w-0 flex-[1_1_20rem] text-t-14 leading-[1.5]';

/** The save bar's primary button: full width below `sm`. Goes beside `aecButton`. */
export const PORTAL_SAVE_BUTTON_CLASS = 'max-sm:w-full';
