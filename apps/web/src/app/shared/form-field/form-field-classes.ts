/**
 * The form-field class recipe the claim dialog shipped (AECI-1293,
 * `shared/claim-dialog/claim-dialog-flow.ts`), named once so the onboarding
 * "About you" form (AECI-1296) lays out the same way instead of drifting.
 *
 * The stack per field is: label, control, hint, error, inside `space-y-2`.
 * Fields sit `space-y-6` apart. The hint goes directly under the control
 * (`DESIGN.md` "Inputs / Fields"), and its id stays in `aria-describedby` from
 * first render, with the error id appended when the error shows.
 *
 * Users today: the claim dialog flow, `ClaimantFields`, `ProfileDetailsForm`,
 * `/welcome` and the `/account` "About you" section. The label constants also
 * reach the sign-in email label and the search box's visible label, which the
 * home pair finder and the claim dialog use (AECI-2003).
 * Light only. The strings are byte-identical to what the claim dialog had
 * inline, so moving them here changed no rendered class. The two button
 * constants are the exception: since AECI-1758 they are the `aecButton` recipe.
 * Every field error in the app uses `FIELD_ERROR_CLASS`, so the error look is set
 * here once (AECI-1984, the Same-Behavior Rule).
 */

import { buttonClass } from '../button/button';

/**
 * The Label role's type (`DESIGN.md` §3): 13px at weight 600 on a 1.4 line, tracking
 * +0.01em, in sentence case, secondary ink. No display, so an inline label (the
 * `aec-select` inline layout) can take it.
 */
export const FIELD_LABEL_TYPE_CLASS =
  'text-t-13 font-semibold tracking-[0.01em] text-(--text-secondary)';

/**
 * A field label, or a `legend` acting as one: the Label role on its own line. Since
 * AECI-1850 it is no longer the uppercase overline: uppercase is for overlines only
 * (the Sentence-Case Rule). Every public form label imports this or
 * `FIELD_LABEL_TYPE_CLASS`, never a hand copy. `src/field-label.guard.spec.ts` fails
 * on the old uppercase recipe written out in public code.
 */
export const FIELD_LABEL_CLASS = `block ${FIELD_LABEL_TYPE_CLASS}`;

/** The "(optional)" marker inside a label. */
export const FIELD_OPTIONAL_CLASS = 'font-normal text-(--text-tertiary)';

/**
 * A text input, textarea or select. `aec-field-control` (unlayered,
 * `styles.css`) draws the edge: `--border-field` at rest (3:1, WCAG 1.4.11), a
 * 2px `--status-error` edge when `aria-invalid="true"`, Forest on focus. It also
 * pins the 44px height and the 12px radius. Do not add a border-colour utility
 * here: the unlayered class beats it, so it would do nothing. The fill is always `surface-base` and a control takes no
 * shadow (DESIGN.md "Inputs / Fields"). Disabled is the sunken tint, never opacity.
 */
export const FIELD_INPUT_CLASS =
  'aec-field-control w-full rounded-control border bg-(--surface-base) px-4 py-2 text-t-16 text-(--text-primary) disabled:cursor-not-allowed focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** Persistent help text, directly under the control. */
export const FIELD_HINT_CLASS = 'text-xs text-(--text-secondary)';

/**
 * A field's inline error, under the hint. Carries `role="alert"`. `aec-field-error`
 * (unlayered, `styles.css`) draws the alert icon before the message, so colour is
 * never the only error signal and no caller template changes. Set `aria-invalid="true"`
 * on the control too: that is what paints its red edge (AECI-1984).
 */
export const FIELD_ERROR_CLASS =
  'aec-field-error flex items-start gap-2 text-t-14 font-semibold text-(--status-error)';

/**
 * One bordered choice row wrapping a native radio or checkbox: the plan
 * question's card. 44px tall, tinted when checked. `aec-choice-card`
 * (unlayered, `styles.css`) draws the border, and turns it `--status-error`
 * when the input inside has `aria-invalid="true"`.
 */
export const CHOICE_CARD_CLASS =
  'aec-choice-card flex min-h-11 cursor-pointer items-center gap-3 rounded-control border bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) has-[:checked]:bg-(--accent-primary-soft) has-[:checked]:font-semibold';

/**
 * The native radio or checkbox, in a choice card or on its own.
 * `aec-choice-input` gives a bare box a `--status-error` outline when it has
 * `aria-invalid="true"`.
 */
export const CHOICE_INPUT_CLASS =
  'aec-choice-input size-4 shrink-0 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/**
 * The primary action: Continue, Send, Save. The `aecButton` recipe
 * (`shared/button/button.ts`, AECI-1758), so every caller binding `[class]` to it
 * renders the shared button. New code uses `<button aecButton>` instead.
 */
export const BUTTON_PRIMARY_CLASS = buttonClass('primary');

/** The secondary action beside it: Back, Skip, Not now. `aecButton variant="secondary"`. */
export const BUTTON_SECONDARY_CLASS = buttonClass('secondary');

/**
 * The action row under a form: secondary at the start, primary at the end.
 * Below `sm` the buttons stack full width with the primary on top. The DOM
 * keeps secondary then primary, so the keyboard order matches the row from
 * `sm` up. The secondary takes `sm:me-auto`, never a bare `me-auto`, which
 * would stop it stretching in the stacked column.
 */
export const FORM_FOOTER_CLASS =
  'flex flex-col-reverse gap-3 border-t sm:flex-row sm:flex-wrap sm:items-center sm:justify-end';
