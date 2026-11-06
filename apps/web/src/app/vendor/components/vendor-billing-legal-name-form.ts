import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import { UpdateVendorLegalNameRequestSchema, VENDOR_LEGAL_NAME_MAX } from '@aeci/shared';

import {
  BUTTON_PRIMARY_CLASS,
  BUTTON_SECONDARY_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
} from '../../shared/form-field/form-field-classes';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * The company legal name block on the vendor Billing tab (AECI-1625), under the section's
 * own "Company legal name" heading. Shows `vendors.legal_name`, and on "Change" an inline
 * form over `PUT /api/vendor/billing/legal-name`. A checkout acceptance records this name
 * (`VENDOR_SIGNUP_PROCESS.md` §4).
 *
 * The billing email form's pattern (`vendor-billing-email-form.ts`), for the Same-Behavior
 * Rule: pessimistic, await the write, re-read the billing payload through the store, then
 * announce through the shell's one live region. A failure stays in the form's own alert.
 * An empty field clears the name (`null`).
 */
@Component({
  selector: 'aec-vendor-billing-legal-name-form',
  template: `
    <div class="space-y-1.5">
      @if (!editing()) {
        <div class="flex flex-wrap items-center gap-3">
          @if (current(); as name) {
            <p class="text-sm text-(--text-primary)">
              {{ name }}
            </p>
          } @else {
            <p class="text-sm text-(--text-secondary)" i18n="@@vendor.billing.legalName.notSet">
              Not set
            </p>
          }
          <button #changeButton type="button" [class]="secondaryClass" (click)="open()">
            <span i18n="@@vendor.billing.legalName.change">Change</span>&ngsp;<span
              class="sr-only"
              i18n="@@vendor.billing.legalName.changeSr"
              >company legal name</span
            >
          </button>
        </div>
      }
      <p [class]="hintClass" id="billing-legal-name-hint" i18n="@@vendor.billing.legalName.hint">
        Your company's full legal name. We record it when an owner accepts the Managed plan
        agreement.
      </p>
    </div>

    @if (editing()) {
      <form class="mt-3 space-y-3" (submit)="submit($event)" novalidate>
        <div class="space-y-1.5">
          <label
            class="sr-only"
            for="billing-legal-name-input"
            i18n="@@vendor.billing.legalName.inputLabel"
          >
            Company legal name
          </label>
          <input
            #nameInput
            id="billing-legal-name-input"
            type="text"
            name="legal_name"
            autocomplete="organization"
            [attr.maxlength]="maxLength"
            [value]="draft()"
            (input)="onInput($event)"
            [attr.aria-invalid]="error() ? 'true' : null"
            [attr.aria-describedby]="
              error()
                ? 'billing-legal-name-hint billing-legal-name-clear billing-legal-name-error'
                : 'billing-legal-name-hint billing-legal-name-clear'
            "
            [class]="inputClass"
          />
          <p
            [class]="hintClass"
            id="billing-legal-name-clear"
            i18n="@@vendor.billing.legalName.clearHint"
          >
            Leave it empty to remove the name.
          </p>
          @if (error(); as message) {
            <p id="billing-legal-name-error" [class]="errorClass" role="alert">{{ message }}</p>
          }
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button type="submit" [disabled]="busy()" [class]="primaryClass">
            @if (busy()) {
              <span i18n="@@vendor.billing.legalName.saving">Saving…</span>
            } @else {
              <span i18n="@@vendor.billing.legalName.save">Save</span>
            }
          </button>
          <button type="button" [disabled]="busy()" [class]="secondaryClass" (click)="cancel()">
            <span i18n="@@vendor.billing.legalName.cancel">Cancel</span>
          </button>
        </div>
      </form>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorBillingLegalNameForm {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  /** The stored legal name, `null` when none is set. */
  readonly current = input.required<string | null>();

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
    if (!UpdateVendorLegalNameRequestSchema.safeParse({ legal_name: next }).success) {
      this.error.set(INVALID_NAME());
      afterNextRender(() => this.nameInput()?.nativeElement.focus(), { injector: this.injector });
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.setLegalName(next);
      await this.store.reload('billing');
      this.announcer.announce(
        next === null
          ? $localize`:@@vendor.billing.legalName.cleared:Company legal name removed.`
          : $localize`:@@vendor.billing.legalName.saved:Company legal name saved.`,
      );
      this.close();
    } catch (err) {
      this.error.set(legalNameErrorMessage(err));
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
  $localize`:@@vendor.billing.legalName.error.invalid:Enter a name of 200 characters or fewer.`;

/** Map the write's refusals onto copy that says what to do next. */
export function legalNameErrorMessage(err: unknown): string {
  const status = err instanceof HttpErrorResponse ? err.status : null;
  const code =
    err instanceof HttpErrorResponse
      ? ((err.error as { error?: { code?: string } } | null)?.error?.code ?? null)
      : null;
  if (code === 'RATE_LIMITED' || status === 429) {
    return $localize`:@@vendor.billing.legalName.error.rate:Too many changes in a short time. Try again in a minute.`;
  }
  switch (status) {
    case 400:
      return INVALID_NAME();
    case 403:
      return $localize`:@@vendor.billing.legalName.error.forbidden:Only an account owner can change the company legal name.`;
    default:
      return $localize`:@@vendor.billing.legalName.error.generic:Could not save the company legal name. Try again.`;
  }
}
