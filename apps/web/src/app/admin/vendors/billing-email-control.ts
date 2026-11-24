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

import { AdminUpdateBillingEmailRequestSchema } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AdminLicensesApi } from './admin-licenses-api';
import { isReplayedEvent } from '../../core/event-replay';

/**
 * The billing email on the admin Billing tab (AECI-1381; decision 16 of
 * `docs/VENDOR_SIGNUP_PROCESS.md` §2, with the 2026-10-23 note on decision 17).
 * Projected into the "Billing email" row of `BillingLicensesTable` through its
 * `[billingEmail]` slot. Shows the address, and on "Change" an inline form over
 * `PUT /api/admin/vendors/:id/billing/email`.
 *
 * The vendor portal's own form (`vendor-billing-email-form.ts`) is the model: same
 * idiom, same field classes, same pessimistic save. Await the write, then hand the
 * stored address to the host through {@link changed}. The host patches its billing
 * signal and reloads the audit trail. A failure stays here, in the form's own alert.
 *
 * An empty field clears the address (`null`): the grant, renewal and plan-end
 * emails then go to the seats alone.
 *
 * The form is `novalidate`, so the browser's own bubble never competes with the
 * form's `role="alert"`. A bad address is caught here, against the request's shared
 * schema, before any request.
 *
 * ── LOOK AND FOCUS (AECI-2124) ──────────────────────────────────────────────
 * The value and a compact secondary Change fill the table's account row, as the
 * console's inline control draws it. The form opens in the row: the field, its help,
 * its error, a compact primary Save and a ghost Cancel. `AdminInlineControl` itself is
 * not used, because this form keeps its own words ("Saving…", the field's own label
 * and the Change button's name) and its native length cap. Change focuses the field.
 * Cancel, Escape and a save return focus to Change. Escape does nothing while the save
 * runs. A refused save focuses its message, because Save was disabled while it ran.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region, like `GrantLicensesControl`: `VendorDetail` owns
 * the page's `role="status"` region and announces on {@link changed}.
 */
@Component({
  selector: 'aec-billing-email-control',
  template: `
    @if (!editing()) {
      <div class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        @if (current(); as address) {
          <span
            class="min-w-0 font-semibold text-(--text-primary) wrap-anywhere"
            data-testid="billing-email-value"
            >{{ address }}</span
          >
        } @else {
          <span
            class="text-(--text-secondary)"
            data-testid="billing-email-value"
            i18n="@@admin.vendors.billing.email.notSet"
            >Not set</span
          >
        }
        <button
          #changeButton
          aecButton
          variant="secondary"
          compact
          type="button"
          aria-label="Change billing email"
          i18n-aria-label="@@admin.vendors.billing.email.changeLabel"
          (click)="open()"
        >
          <span i18n="@@admin.vendors.billing.email.change">Change</span>
        </button>
      </div>
    } @else {
      <form
        method="dialog"
        class="grid max-w-[32rem] gap-2 pb-2"
        [attr.aria-busy]="busy() ? 'true' : null"
        (submit)="submit($event)"
        (keydown.escape)="onEscape($event)"
        novalidate
      >
        <div class="grid gap-2">
          <label
            class="sr-only"
            for="admin-billing-email-input"
            i18n="@@admin.vendors.billing.email.inputLabel"
            >Billing email address</label
          >
          <input
            #emailInput
            id="admin-billing-email-input"
            type="email"
            name="billing_email"
            autocomplete="off"
            [value]="draft()"
            (input)="onInput($event)"
            [attr.aria-invalid]="error() ? 'true' : null"
            [attr.aria-describedby]="
              error()
                ? 'admin-billing-email-hint admin-billing-email-error'
                : 'admin-billing-email-hint'
            "
            [class]="inputClass"
          />
          <p
            [class]="hintClass"
            id="admin-billing-email-hint"
            i18n="@@admin.vendors.billing.email.hint"
          >
            Subscription grant, renewal notice and plan-end emails go to this address and to every
            seat. Leave it empty to remove the address.
          </p>
          @if (error(); as message) {
            <p
              #errorEl
              id="admin-billing-email-error"
              tabindex="-1"
              [class]="errorClass"
              role="alert"
            >
              {{ message }}
            </p>
          }
        </div>
        <div class="mt-2 flex flex-wrap items-center gap-3">
          <button aecButton compact type="submit" [disabled]="busy()">
            @if (busy()) {
              <span i18n="@@admin.vendors.billing.email.saving">Saving…</span>
            } @else {
              <span i18n="@@admin.vendors.billing.email.save">Save</span>
            }
          </button>
          <button aecButton variant="ghost" type="button" [disabled]="busy()" (click)="cancel()">
            <span i18n="@@admin.vendors.billing.email.cancel">Cancel</span>
          </button>
        </div>
      </form>
    }
  `,
  imports: [AecButton],
  styles: [':host { display: block; }'],
})
export class BillingEmailControl {
  private readonly api = inject(AdminLicensesApi);
  private readonly injector = inject(Injector);

  readonly vendorId = input.required<string>();
  /** The stored address, `null` when none is set. */
  readonly current = input.required<string | null>();

  /** The address as stored after a committed write. `null` = cleared. */
  readonly changed = output<string | null>();

  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly changeButton = viewChild<ElementRef<HTMLButtonElement>>('changeButton');
  private readonly errorEl = viewChild<ElementRef<HTMLElement>>('errorEl');
  private readonly emailInput = viewChild<ElementRef<HTMLInputElement>>('emailInput');

  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;

  protected open(): void {
    this.draft.set(this.current() ?? '');
    this.error.set(null);
    this.editing.set(true);
    afterNextRender(() => this.emailInput()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancel(): void {
    this.close();
  }

  /** Escape is Cancel, except while the save runs: its answer needs the form. */
  protected onEscape(event: Event): void {
    event.stopPropagation();
    if (!this.busy()) this.close();
  }

  protected onInput(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected async submit(event: Event): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    if (this.busy()) return;
    const trimmed = this.draft().trim();
    const next = trimmed === '' ? null : trimmed;
    if (!AdminUpdateBillingEmailRequestSchema.safeParse({ billing_email: next }).success) {
      this.error.set(INVALID_EMAIL());
      afterNextRender(() => this.emailInput()?.nativeElement.focus(), { injector: this.injector });
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      const response = await this.api.updateBillingEmail(this.vendorId(), next);
      this.changed.emit(response.billing_account.billing_email);
      this.close();
    } catch (err) {
      this.error.set(adminBillingEmailErrorMessage(err));
      afterNextRender(() => this.errorEl()?.nativeElement.focus(), { injector: this.injector });
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

const INVALID_EMAIL = (): string =>
  $localize`:@@admin.vendors.billing.email.error.invalid:Enter a valid email address.`;

/** Map the write's refusals onto copy that says what to do next. Structural on the
 *  status as well as `instanceof`, because the admin bundle is lazily split. */
export function adminBillingEmailErrorMessage(err: unknown): string {
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
    return $localize`:@@admin.vendors.billing.email.error.rate:Too many changes in a short time. Try again in a minute.`;
  }
  switch (status) {
    case 400:
      return INVALID_EMAIL();
    case 404:
      return $localize`:@@admin.vendors.billing.email.error.notFound:This vendor has no billing account any more. Reload the page.`;
    default:
      return $localize`:@@admin.vendors.billing.email.error.generic:Could not save the billing email. Try again.`;
  }
}
