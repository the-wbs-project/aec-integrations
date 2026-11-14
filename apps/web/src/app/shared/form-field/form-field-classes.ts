/**
 * The form-field class recipe the claim dialog shipped (AECI-1293,
 * `shared/claim-dialog/claim-dialog-flow.ts`), named once so the onboarding
 * "About you" form (AECI-1296) lays out the same way instead of drifting.
 *
 * The stack per field is: label, control, hint, error, inside `space-y-1.5`.
 * Fields sit `space-y-6` apart. The hint goes directly under the control
 * (`DESIGN.md` "Inputs / Fields"), and its id stays in `aria-describedby` from
 * first render, with the error id appended when the error shows.
 *
 * Users today: the claim dialog flow, `ClaimantFields`, `ProfileDetailsForm`,
 * `/welcome` and the `/account` "About you" section.
 * Light only. The strings are byte-identical to what the claim dialog had
 * inline, so moving them here changed no rendered class.
 */

/** A field label, or a `legend` acting as one: the uppercase overline role. */
export const FIELD_LABEL_CLASS =
  'block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';

/** The "(optional)" marker inside a label. */
export const FIELD_OPTIONAL_CLASS = 'font-normal normal-case text-(--text-tertiary)';

/**
 * A text input, textarea or select. `aec-field-control` (unlayered,
 * `styles.css`) draws the edge: `--border-field` at rest (3:1, WCAG 1.4.11), a
 * 2px `--status-error` edge when `aria-invalid="true"`, Forest on focus. It also
 * pins the 44px height and the 12px radius. A border-colour utility here would
 * never apply, because the unlayered `* { border-color }` rule beats every
 * layered utility. The fill is always `surface-base` and a control takes no
 * shadow (DESIGN.md "Inputs / Fields"). Disabled is the sunken tint, never opacity.
 */
export const FIELD_INPUT_CLASS =
  'aec-field-control w-full rounded-control border bg-(--surface-base) px-4 py-2 text-t-16 text-(--text-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** Persistent help text, directly under the control. */
export const FIELD_HINT_CLASS = 'text-xs text-(--text-secondary)';

/**
 * A field's inline error, under the hint. Carries `role="alert"`. `aec-field-error`
 * (unlayered, `styles.css`) draws the alert icon before the message, so colour is
 * never the only error signal and no caller template changes.
 */
export const FIELD_ERROR_CLASS = 'aec-field-error text-t-14 font-semibold text-(--status-error)';

/**
 * One bordered choice row wrapping a native radio or checkbox: the plan
 * question's card. 44px tall, tinted when checked.
 */
export const CHOICE_CARD_CLASS =
  'flex min-h-11 cursor-pointer items-center gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) has-[:checked]:bg-(--accent-primary-soft) has-[:checked]:font-semibold';

/** The native radio or checkbox inside a choice card. */
export const CHOICE_INPUT_CLASS =
  'size-4 shrink-0 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/** The primary action: Continue, Send, Save. */
export const BUTTON_PRIMARY_CLASS =
  'inline-flex min-h-11 items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';

/** The secondary action beside it: Back, Skip, Not now. */
export const BUTTON_SECONDARY_CLASS =
  'inline-flex min-h-11 items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-5 py-2.5 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/**
 * The action row under a form: secondary at the start, primary at the end.
 * Below `sm` the buttons stack full width with the primary on top. The DOM
 * keeps secondary then primary, so the keyboard order matches the row from
 * `sm` up. The secondary takes `sm:me-auto`, never a bare `me-auto`, which
 * would stop it stretching in the stacked column.
 */
export const FORM_FOOTER_CLASS =
  'flex flex-col-reverse gap-3 border-t sm:flex-row sm:flex-wrap sm:items-center sm:justify-end';
