import { Component, LOCALE_ID, computed, inject, input } from '@angular/core';
import type { FieldTree } from '@angular/forms/signals';
import { ISO_COUNTRY_CODES, countryName } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { AecSelect, type AecSelectOption } from '../shared/aec-select/aec-select';

/**
 * "Company country" on the listing request form (AECI-1705,
 * `VENDOR_PROGRAM_PAGE_SPEC.md` §15.2). Required, and picked from a list, never typed:
 * the value is an ISO 3166-1 alpha-2 code (`ISO_COUNTRY_CODES`), which
 * `ListingRequestFormSchema` checks on both sides.
 *
 * The names come from `Intl.DisplayNames` in the page's locale, so the list needs no
 * hand-kept translations, and they are sorted with `compareText` (case never decides the
 * order). The control is the shared `AecSelect` (Angular Aria combobox, ADR 0010).
 *
 * Presentational over the host form's field: the host owns the model and the schema.
 * The error shows once the field is touched. The trigger's id is `{idPrefix}-trigger`,
 * which the host focuses when Continue finds the field empty.
 */
@Component({
  selector: 'aec-company-country-field',
  imports: [AecSelect],
  host: { class: 'block space-y-1.5' },
  template: `
    <aec-select
      class="block"
      layout="stacked"
      [idPrefix]="idPrefix()"
      i18n-label="@@requests.listing.country.label"
      label="Company country"
      i18n-placeholder="@@requests.listing.country.placeholder"
      placeholder="Choose a country"
      [options]="options()"
      [value]="field()().value() || null"
      [invalid]="showError()"
      [describedBy]="showError() ? idPrefix() + '-error' : ''"
      (changed)="choose($event)"
    />
    @if (showError()) {
      <p
        [id]="idPrefix() + '-error'"
        class="text-xs font-medium text-(--text-primary)"
        role="alert"
        i18n="@@requests.listing.country.error"
      >
        Choose the company's country.
      </p>
    }
  `,
})
export class CompanyCountryField {
  private readonly locale = inject(LOCALE_ID);

  /** The host form's `company_country` field: `''` until a country is chosen. */
  readonly field = input.required<FieldTree<string>>();
  readonly idPrefix = input('company-country');

  protected readonly options = computed<readonly AecSelectOption[]>(() =>
    ISO_COUNTRY_CODES.map((code) => ({ value: code, label: countryName(code, this.locale) })).sort(
      (a, b) => compareText(a.label, b.label),
    ),
  );

  protected readonly showError = computed(() => {
    const state = this.field()();
    return state.touched() && !!state.getError('standardSchema');
  });

  protected choose(code: string | null): void {
    const state = this.field()();
    state.value.set(code ?? '');
    state.markAsTouched();
  }
}
