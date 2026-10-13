import { Component, input } from '@angular/core';
import type { FieldTree } from '@angular/forms/signals';

import type { PlanInterest } from '@aeci/shared';

import { CHOICE_CARD_CLASS, FIELD_LABEL_CLASS } from '../shared/form-field/form-field-classes';
import { planLabel } from '../vendor/vendor-plan';

/** One radio. `value` is the wire value of `plan_interest`. */
interface PlanOption {
  readonly value: PlanInterest;
  readonly label: string;
}

/**
 * "Which plan are you interested in?" (AECI-1293, `VENDOR_PROGRAM_PAGE_SPEC.md` §15.2
 * step 3): three native radios, Free, Managed and Not sure yet, in a `fieldset` named by
 * its `legend`. Rendered by the claim dialog's plan step and by the claim page and
 * drawer (§15.6).
 *
 * Optional: `''` is "not answered". Nothing is checked unless the host seeded the
 * field (the dialog seeds Managed from a Managed control, Free from the Free card). The
 * answer is informational for the reviewer, who still picks the plan at approval with
 * nothing preselected (`STAGE_2_PAID_TIERS_SPEC.md` §13.6), so the hint says the plan
 * is confirmed before anything is billed.
 *
 * Bound by hand rather than through `[formField]`: a radio group is one value across
 * three inputs, and `[checked]` plus `(change)` keeps that explicit.
 */
@Component({
  selector: 'aec-plan-interest-field',
  host: { class: 'block' },
  template: `
    <fieldset [attr.aria-describedby]="idPrefix() + '-plan-hint'">
      <legend [class]="legendClass" i18n="@@claimDialog.plan.legend">
        Which plan are you interested in?
        <span class="font-normal normal-case text-(--text-tertiary)">(optional)</span>
      </legend>
      <p
        [id]="idPrefix() + '-plan-hint'"
        class="mt-1.5 text-xs text-(--text-secondary)"
        i18n="@@claimDialog.plan.hint"
      >
        You can change your mind. We confirm the plan with you before anything is billed.
      </p>
      <div class="mt-3 grid gap-2">
        @for (opt of options; track opt.value) {
          <label [class]="cardClass">
            <input
              type="radio"
              [name]="idPrefix() + '-plan'"
              [value]="opt.value"
              [checked]="field()().value() === opt.value"
              (change)="field()().value.set(opt.value)"
              class="size-4 accent-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
            <span>{{ opt.label }}</span>
          </label>
        }
      </div>
    </fieldset>
  `,
})
export class PlanInterestField {
  /** The `plan_interest` field: `''` or a `PlanInterest`. */
  readonly field = input.required<FieldTree<'' | PlanInterest>>();
  readonly idPrefix = input('claim');

  protected readonly legendClass = FIELD_LABEL_CLASS;
  protected readonly cardClass = CHOICE_CARD_CLASS;

  protected readonly options: readonly PlanOption[] = [
    { value: 'free', label: planLabel('free') },
    { value: 'managed', label: planLabel('managed') },
    { value: 'not_sure', label: $localize`:@@claimDialog.plan.notSure:Not sure yet` },
  ];
}
