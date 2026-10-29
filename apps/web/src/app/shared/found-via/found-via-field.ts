import { Component, computed, input, model, signal } from '@angular/core';

import { FOUND_VIA_DETAIL_MAX, FOUND_VIA_FOLLOW_UP, type FoundVia } from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../aec-select/aec-select';
import { FIELD_INPUT_CLASS, FIELD_LABEL_CLASS } from '../form-field/form-field-classes';
import { FOUND_VIA_FOLLOW_UP_LABELS, FOUND_VIA_OPTIONS } from './found-via-labels';

const CLEAR_ANSWER_LABEL = $localize`:@@foundVia.clearAnswer:Clear answer`;

/** The announcement when the follow-up box appears or its question changes. */
function followUpAppeared(question: string): string {
  return $localize`:@@foundVia.followUp.appeared:A follow-up question appeared: ${question}:question:`;
}

/**
 * The optional "How did you find AEC Integrations?" question (AECI-1063,
 * `docs/ANALYTICS.md` §11b), shared by the claim and listing forms, the mailing
 * band, `/updates` and the feedback form.
 *
 * Presentational over two models. `value` is the wire value (`''` = not
 * answered) and `detail` is the follow-up text. The host owns submitting, and
 * neither field is ever required.
 *
 * The choice is the shared `AecSelect` (Angular Aria combobox, ADR 0010). Like
 * the "About you" questions, unanswered shows the placeholder, and once there is
 * an answer a "Clear answer" row leads the list. The follow-up text box renders
 * only for the channels in `FOUND_VIA_FOLLOW_UP`, and its question follows the
 * choice. Moving to a channel with no follow-up, or clearing, empties the
 * detail, so a stale answer never rides the submit.
 *
 * The component owns one polite live region that is always in the DOM. It says
 * when the follow-up box appears, because a screen reader does not otherwise
 * hear content added after the control it is on.
 */
@Component({
  selector: 'aec-found-via-field',
  imports: [AecSelect],
  host: { class: 'block' },
  template: `
    <div class="space-y-3">
      <aec-select
        class="block"
        layout="stacked"
        [idPrefix]="idPrefix()"
        i18n-label="@@foundVia.label"
        label="How did you find AEC Integrations? (optional)"
        i18n-placeholder="@@foundVia.choose"
        placeholder="Choose one"
        [options]="options()"
        [value]="value() || null"
        (changed)="choose($event)"
      />

      @if (followUpLabel(); as question) {
        <div class="space-y-1.5">
          <label [for]="idPrefix() + '-detail'" [class]="labelClass">{{ question }}</label>
          <input
            [id]="idPrefix() + '-detail'"
            type="text"
            autocomplete="off"
            [attr.maxlength]="detailMax"
            [value]="detail()"
            (input)="onDetailInput($event)"
            [class]="inputClass"
            data-testid="found-via-detail"
          />
        </div>
      }

      <p class="sr-only" role="status" aria-live="polite" data-testid="found-via-status">
        {{ announcement() }}
      </p>
    </div>
  `,
})
export class FoundViaField {
  /** The chosen channel. `''` means not answered, as on the wire. */
  readonly value = model<'' | FoundVia>('');
  /** The follow-up answer. Cleared when the choice has no follow-up. */
  readonly detail = model('');
  /** Stable id stem, unique per host page. */
  readonly idPrefix = input('found-via');

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly detailMax = FOUND_VIA_DETAIL_MAX;

  protected readonly announcement = signal('');

  protected readonly options = computed<AecSelectOption[]>(() =>
    this.value() === ''
      ? [...FOUND_VIA_OPTIONS]
      : [{ value: null, label: CLEAR_ANSWER_LABEL }, ...FOUND_VIA_OPTIONS],
  );

  protected readonly followUpLabel = computed(() => {
    const choice = this.value();
    return choice !== '' && FOUND_VIA_FOLLOW_UP.has(choice)
      ? (FOUND_VIA_FOLLOW_UP_LABELS[choice] ?? null)
      : null;
  });

  protected choose(next: string | null): void {
    const choice = (next ?? '') as '' | FoundVia;
    this.value.set(choice);
    const question = this.followUpLabel();
    if (question === null) {
      if (this.detail() !== '') this.detail.set('');
      this.announcement.set('');
    } else {
      this.announcement.set(followUpAppeared(question));
    }
  }

  protected onDetailInput(event: Event): void {
    this.detail.set((event.target as HTMLInputElement).value);
  }
}
