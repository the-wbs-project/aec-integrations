import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, input } from '@angular/core';
import { type FieldTree, FormField } from '@angular/forms/signals';

import { legalPath } from '../legal/legal-manifest';
import { CHOICE_INPUT_CLASS, FIELD_ERROR_CLASS } from '../shared/form-field/form-field-classes';

/**
 * The vendor terms box on every claim form (AECI-1366, `docs/VENDOR_SIGNUP_PROCESS.md`
 * §4, decision 3): "I represent this company and accept the vendor terms", with a link
 * to the current terms page. Required: `ClaimFormSchema.accepted_terms` is `z.literal(true)`,
 * so the host form stays invalid and cannot submit until it is checked. The server
 * stamps the version and records the acceptance in the claim's own batch.
 *
 * Rendered by the claim dialog's You step, the routed claim pages and the claim drawer
 * (`RequestFormBody`), on both the found and the typed-in path. The host owns the model.
 *
 * The error shows once the box was touched and left unchecked, or when the server
 * refused the submit on `accepted_terms` (`rejected`, a stale bundle). It is tied to the
 * checkbox with `aria-describedby`. The link opens in a new tab, so a claimant reading
 * the terms does not lose what they typed.
 */
@Component({
  selector: 'aec-vendor-terms-box',
  imports: [FormField],
  host: { class: 'block space-y-1.5' },
  template: `
    <div class="flex items-start gap-3">
      <input
        [id]="inputId()"
        type="checkbox"
        [formField]="field()"
        [attr.aria-invalid]="showError() ? 'true' : null"
        [attr.aria-describedby]="showError() ? errorId() : null"
        [class]="inputClass + ' mt-0.5'"
      />
      <label [attr.for]="inputId()" class="text-sm leading-relaxed text-(--text-primary)">
        <span i18n="@@requests.terms.label"
          >I represent this company and accept the
          <a
            [href]="termsHref"
            target="_blank"
            rel="noopener"
            class="font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >vendor terms<span class="sr-only"> (opens in a new tab)</span></a
          ></span
        >
      </label>
    </div>
    @if (showError()) {
      <p [id]="errorId()" [class]="errorClass" role="alert" i18n="@@requests.terms.error">
        Tick the box to confirm you represent this company and accept the vendor terms.
      </p>
    }
  `,
})
export class VendorTermsBox {
  readonly field = input.required<FieldTree<boolean>>();
  /** Id stem, as `ClaimantFields`: `claim` on the page and drawer, `claim-dialog` in the dialog. */
  readonly idPrefix = input('claim');
  /** The server refused the submit on `accepted_terms`. Shows the error until checked. */
  readonly rejected = input(false);

  protected readonly termsHref = legalPath('vendor-terms');
  protected readonly inputClass = CHOICE_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;

  protected readonly inputId = computed(() => `${this.idPrefix()}-terms`);
  protected readonly errorId = computed(() => `${this.idPrefix()}-terms-error`);

  protected readonly showError = computed(() => {
    const state = this.field()();
    if (state.value()) return false;
    return this.rejected() || state.touched();
  });
}

/**
 * Whether a failed claim or listing submit was the server refusing `accepted_terms`
 * (`400 VALIDATION_FAILED`). A bundle loaded before the box shipped never sends the key,
 * so the form shows the box's own error instead of the generic failure. Reads both the
 * envelope's `field` and every Zod issue, because another field may be reported first.
 */
export function isAcceptedTermsRejection(err: unknown): boolean {
  if (!(err instanceof HttpErrorResponse) || err.status !== 400) return false;
  const error = (err.error as { error?: { code?: string; field?: string; details?: unknown } })
    ?.error;
  if (error?.code !== 'VALIDATION_FAILED') return false;
  if (error.field === 'accepted_terms') return true;
  const issues = (error.details as { issues?: Array<{ path?: unknown[] }> } | undefined)?.issues;
  return Array.isArray(issues) && issues.some((issue) => issue.path?.[0] === 'accepted_terms');
}
