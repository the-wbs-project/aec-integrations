import { Component, input } from '@angular/core';
import { type FieldTree, FormField } from '@angular/forms/signals';

import { FIELD_INPUT_CLASS, FIELD_LABEL_CLASS } from '../shared/form-field/form-field-classes';

/**
 * The claim form's identity fields (AECI-847, AECI-1293): name, role, LinkedIn profile
 * and work email. Extracted from `RequestFormBody` so the claim page, the claim drawer
 * and step 2 of the claim dialog (`shared/claim-dialog/`) render the same four fields
 * with the same validation (`ClaimFormSchema`, the LinkedIn host allowlist) and the
 * same copy. The host form owns the model and the schema; this only renders.
 *
 * `idPrefix` keeps the ids unique when two forms could share a page. The claim page
 * and drawer keep the shipped `claim` prefix, so `#claim-name` and friends are unchanged.
 */
@Component({
  selector: 'aec-claimant-fields',
  imports: [FormField],
  host: { class: 'block space-y-6' },
  template: `
    <div class="space-y-1.5">
      <label
        [attr.for]="idPrefix() + '-name'"
        [class]="labelClass"
        i18n="@@requests.claim.name.label"
      >
        Your name
      </label>
      <input
        [id]="idPrefix() + '-name'"
        type="text"
        autocomplete="name"
        [formField]="name()"
        [attr.aria-invalid]="name()().touched() && name()().invalid() ? 'true' : null"
        [attr.aria-describedby]="showError(name()) ? idPrefix() + '-name-error' : null"
        [class]="inputClass"
      />
      @if (showError(name())) {
        <p
          [id]="idPrefix() + '-name-error'"
          class="text-xs font-medium text-(--text-primary)"
          role="alert"
          i18n="@@requests.claim.name.error"
        >
          Your name is required.
        </p>
      }
    </div>

    <div class="space-y-1.5">
      <label
        [attr.for]="idPrefix() + '-role'"
        [class]="labelClass"
        i18n="@@requests.claim.role.label"
      >
        Your role at the company
      </label>
      <input
        [id]="idPrefix() + '-role'"
        type="text"
        autocomplete="organization-title"
        [formField]="role()"
        [attr.aria-invalid]="role()().touched() && role()().invalid() ? 'true' : null"
        [attr.aria-describedby]="showError(role()) ? idPrefix() + '-role-error' : null"
        [class]="inputClass"
      />
      @if (showError(role())) {
        <p
          [id]="idPrefix() + '-role-error'"
          class="text-xs font-medium text-(--text-primary)"
          role="alert"
          i18n="@@requests.claim.role.error"
        >
          Your role is required.
        </p>
      }
    </div>

    <div class="space-y-1.5">
      <label
        [attr.for]="idPrefix() + '-linkedin'"
        [class]="labelClass"
        i18n="@@requests.claim.linkedin.label"
      >
        LinkedIn profile
        <span class="font-normal normal-case text-(--text-tertiary)">(optional)</span>
      </label>
      <input
        [id]="idPrefix() + '-linkedin'"
        type="url"
        inputmode="url"
        autocomplete="url"
        i18n-placeholder="@@requests.claim.linkedin.placeholder"
        placeholder="https://www.linkedin.com/in/your-profile"
        [formField]="linkedin()"
        [attr.aria-invalid]="linkedin()().touched() && linkedin()().invalid() ? 'true' : null"
        [attr.aria-describedby]="
          showError(linkedin())
            ? idPrefix() + '-linkedin-hint ' + idPrefix() + '-linkedin-error'
            : idPrefix() + '-linkedin-hint'
        "
        [class]="inputClass"
      />
      <p
        [id]="idPrefix() + '-linkedin-hint'"
        class="text-xs text-(--text-secondary)"
        i18n="@@requests.claim.linkedin.hint"
      >
        Adding your profile is the fastest way for us to confirm you work here.
      </p>
      @if (showError(linkedin())) {
        <p
          [id]="idPrefix() + '-linkedin-error'"
          class="text-xs font-medium text-(--text-primary)"
          role="alert"
          i18n="@@requests.claim.linkedin.error"
        >
          Enter a LinkedIn profile URL, starting with https://www.linkedin.com/in/
        </p>
      }
    </div>

    <div class="space-y-1.5">
      <label
        [attr.for]="idPrefix() + '-email'"
        [class]="labelClass"
        i18n="@@requests.claim.email.label"
      >
        Your work email
      </label>
      <input
        [id]="idPrefix() + '-email'"
        type="email"
        inputmode="email"
        autocomplete="email"
        [formField]="email()"
        [attr.aria-invalid]="email()().touched() && email()().invalid() ? 'true' : null"
        [attr.aria-describedby]="showError(email()) ? idPrefix() + '-email-error' : null"
        [class]="inputClass"
      />
      @if (showError(email())) {
        <p
          [id]="idPrefix() + '-email-error'"
          class="text-xs font-medium text-(--text-primary)"
          role="alert"
          i18n="@@requests.email.invalid"
        >
          Enter a valid email address.
        </p>
      }
    </div>
  `,
})
export class ClaimantFields {
  readonly name = input.required<FieldTree<string>>();
  readonly role = input.required<FieldTree<string>>();
  readonly linkedin = input.required<FieldTree<string>>();
  readonly email = input.required<FieldTree<string>>();
  /** Id stem for every control and message. The claim page and drawer use `claim`. */
  readonly idPrefix = input('claim');

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;

  protected showError(field: FieldTree<string>): boolean {
    return field().touched() && !!field().getError('standardSchema');
  }
}
