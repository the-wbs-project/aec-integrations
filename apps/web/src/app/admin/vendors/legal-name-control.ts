import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { AdminUpdateVendorLegalNameRequestSchema, VENDOR_LEGAL_NAME_MAX } from '@aeci/shared';

import {
  BUTTON_PRIMARY_CLASS,
  BUTTON_SECONDARY_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AdminLicensesApi } from './admin-licenses-api';

/**
 * The company legal name on the admin Billing tab (AECI-1625). Projected into the "Legal
 * name" row of `BillingLicensesTable` through its `[legalName]` slot. Shows
 * `vendors.legal_name`, and on "Change" an inline form over
 * `PUT /api/admin/vendors/:id/billing/legal-name`. A checkout acceptance records the name.
 *
 * `BillingEmailControl` is the model, for the Same-Behavior Rule: same idiom, same field
 * classes, same pessimistic save. Await the write, then hand the stored name to the host
 * through {@link changed}. A failure stays here, in the form's own alert. An empty field
 * clears the name (`null`).
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region: `VendorDetail` owns the page's `role="status"` region
 * and announces on {@link changed}.
 */
@Component({
  selector: 'aec-legal-name-control',
  template: `
    @if (!editing()) {
      <div class="flex flex-wrap items-center gap-3">
        @if (current(); as name) {
          <span class="font-medium text-(--text-primary)" data-testid="legal-name-value">{{
            name
          }}</span>
        } @else {
          <span
            class="text-(--text-secondary)"
            data-testid="legal-name-value"
            i18n="@@admin.vendors.billing.legalName.notSet"
            >Not set</span
          >
        }
        <button
          #changeButton
          type="button"
          [class]="secondaryClass"
          aria-label="Change company legal name"
          i18n-aria-label="@@admin.vendors.billing.legalName.changeLabel"
          (click)="open()"
        >
          <span i18n="@@admin.vendors.billing.legalName.change">Change</span>
        </button>
      </div>
    } @else {
      <form class="space-y-3" (submit)="submit($event)" novalidate>
        <div class="space-y-1.5">
          <label
            class="sr-only"
            for="admin-legal-name-input"
            i18n="@@admin.vendors.billing.legalName.inputLabel"
            >Company legal name</label
          >
          <input
            #nameInput
            id="admin-legal-name-input"
            type="text"
            name="legal_name"
            autocomplete="off"
            [attr.maxlength]="maxLength"
            [value]="draft()"
            (input)="onInput($event)"
            [attr.aria-invalid]="error() ? 'true' : null"
            [attr.aria-describedby]="
              error() ? 'admin-legal-name-hint admin-legal-name-error' : 'admin-legal-name-hint'
            "
            [class]="inputClass"
          />
          <p
            [class]="hintClass"
            id="admin-legal-name-hint"
            i18n="@@admin.vendors.billing.legalName.hint"
          >
            The name a checkout acceptance records. Leave it empty to remove the name.
          </p>
          @if (error(); as message) {
            <p id="admin-legal-name-error" [class]="errorClass" role="alert">{{ message }}</p>
          }
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button type="submit" [disabled]="busy()" [class]="primaryClass">
            @if (busy()) {
              <span i18n="@@admin.vendors.billing.legalName.saving">Saving…</span>
            } @else {
              <span i18n="@@admin.vendors.billing.legalName.save">Save</span>
            }
          </button>
          <button type="button" [disabled]="busy()" [class]="secondaryClass" (click)="cancel()">
            <span i18n="@@admin.vendors.billing.legalName.cancel">Cancel</span>
          </button>
        </div>
      </form>
    }
  `,
  styles: [':host { display: block; }'],
})
export class LegalNameControl {
  private readonly api = inject(AdminLicensesApi);
  private readonly injector = inject(Injector);

  readonly vendorId = input.required<string>();
  /** The stored legal name, `null` when none is set. */
  readonly current = input.required<string | null>();

  /** The name as stored after a committed write. `null` = cleared. */
  readonly changed = output<string | null>();

  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly changeButton = viewChild<ElementRef<HTMLButtonElement>>('changeButton');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly primaryClass = BUTTON_PRIMARY_CLASS;
  protected readonly secondaryClass = BUTTON_SECONDARY_CLASS;
  protected readonly maxLength = VENDOR_LEGAL_NAME_MAX;

  protected open(): void {
    this.draft.set(this.current() ?? '');
    this.error.set(null);
    this.editing.set(true);
    afterNextRender(() => this.nameInput()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancel(): void {
    this.close();
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const trimmed = this.draft().trim();
    const next = trimmed === '' ? null : trimmed;
    if (!AdminUpdateVendorLegalNameRequestSchema.safeParse({ legal_name: next }).success) {
      this.error.set(INVALID_NAME());
      afterNextRender(() => this.nameInput()?.nativeElement.focus(), { injector: this.injector });
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      const response = await this.api.updateLegalName(this.vendorId(), next);
      this.changed.emit(response.legal_name);
      this.close();
    } catch (err) {
      this.error.set(adminLegalNameErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  private close(): void {
    this.editing.set(false);
    this.error.set(null);
    afterNextRender(() => this.changeButton()?.nativeElement.focus(), { injector: this.injector });
  }
}

const INVALID_NAME = (): string =>
  $localize`:@@admin.vendors.billing.legalName.error.invalid:Enter a name of 200 characters or fewer.`;

/** Map the write's refusals onto copy that says what to do next. Structural on the
 *  status as well as `instanceof`, because the admin bundle is lazily split. */
export function adminLegalNameErrorMessage(err: unknown): string {
  const status =
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { status?: unknown }).status === 'number'
      ? (err as { status: number }).status
      : null;
  const code =
    err instanceof HttpErrorResponse
      ? ((err.error as { error?: { code?: string } } | null)?.error?.code ?? null)
      : null;
  if (code === 'RATE_LIMITED' || status === 429) {
    return $localize`:@@admin.vendors.billing.legalName.error.rate:Too many changes in a short time. Try again in a minute.`;
  }
  switch (status) {
    case 400:
      return INVALID_NAME();
    case 404:
      return $localize`:@@admin.vendors.billing.legalName.error.notFound:This vendor no longer exists. Reload the page.`;
    default:
      return $localize`:@@admin.vendors.billing.legalName.error.generic:Could not save the company legal name. Try again.`;
  }
}
