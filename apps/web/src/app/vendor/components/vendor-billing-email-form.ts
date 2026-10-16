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

import { UpdateBillingEmailRequestSchema } from '@aeci/shared';

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
 * The billing email block on the vendor Billing tab, under the section's own
 * "Billing email" heading (AECI-1390, E5.4; decision 16
 * of `docs/VENDOR_SIGNUP_PROCESS.md` §2). Shows the address, and on "Change" an
 * inline form over `PUT /api/vendor/billing/email` (E5.3).
 *
 * Pessimistic, like the seat-invite form (`vendor-seat-invite-form.ts`) and for its
 * reason: `STAGE_2_REALTIME_SPEC.md` keeps forms pessimistic. Await the write, then
 * re-read the billing payload through the store, then announce through the shell's
 * one live region. A failure stays here, in the form's own alert.
 *
 * An empty field clears the address (`null`): those emails then go to the seats alone.
 *
 * The form is `novalidate`, so the browser's own bubble never competes with the
 * form's `role="alert"`. A bad address is caught here, against the request's shared
 * schema, before any request (AECI-1390).
 */
@Component({
  selector: 'aec-vendor-billing-email-form',
  template: `
    <div class="space-y-1.5">
      @if (!editing()) {
        <div class="flex flex-wrap items-center gap-3">
          @if (current(); as address) {
            <p class="text-sm text-(--text-primary)">
              {{ address }}
            </p>
          } @else {
            <p class="text-sm text-(--text-secondary)" i18n="@@vendor.billing.email.notSet">
              Not set
            </p>
          }
          <button #changeButton type="button" [class]="secondaryClass" (click)="open()">
            <span i18n="@@vendor.billing.email.change">Change</span>
            <span class="sr-only" i18n="@@vendor.billing.email.changeSr">billing email</span>
          </button>
        </div>
      }
      <p [class]="hintClass" id="billing-email-hint" i18n="@@vendor.billing.email.hint">
        License grant and plan-end emails go to this address and to every seat.
      </p>
    </div>

    @if (editing()) {
      <form class="mt-3 space-y-3" (submit)="submit($event)" novalidate>
        <div class="space-y-1.5">
          <label class="sr-only" for="billing-email-input" i18n="@@vendor.billing.email.inputLabel">
            Billing email address
          </label>
          <input
            #emailInput
            id="billing-email-input"
            type="email"
            name="billing_email"
            autocomplete="email"
            [value]="draft()"
            (input)="onInput($event)"
            [attr.aria-invalid]="error() ? 'true' : null"
            [attr.aria-describedby]="
              error()
                ? 'billing-email-hint billing-email-clear billing-email-error'
                : 'billing-email-hint billing-email-clear'
            "
            [class]="inputClass"
          />
          <p [class]="hintClass" id="billing-email-clear" i18n="@@vendor.billing.email.clearHint">
            Leave it empty to remove the address.
          </p>
          @if (error(); as message) {
            <p id="billing-email-error" [class]="errorClass" role="alert">{{ message }}</p>
          }
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button type="submit" [disabled]="busy()" [class]="primaryClass">
            @if (busy()) {
              <span i18n="@@vendor.billing.email.saving">Saving…</span>
            } @else {
              <span i18n="@@vendor.billing.email.save">Save</span>
            }
          </button>
          <button type="button" [disabled]="busy()" [class]="secondaryClass" (click)="cancel()">
            <span i18n="@@vendor.billing.email.cancel">Cancel</span>
          </button>
        </div>
      </form>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorBillingEmailForm {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  /** The stored address, `null` when none is set. */
  readonly current = input.required<string | null>();

  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly changeButton = viewChild<ElementRef<HTMLButtonElement>>('changeButton');
  private readonly emailInput = viewChild<ElementRef<HTMLInputElement>>('emailInput');

  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly primaryClass = BUTTON_PRIMARY_CLASS;
  protected readonly secondaryClass = BUTTON_SECONDARY_CLASS;

  protected open(): void {
    this.draft.set(this.current() ?? '');
    this.error.set(null);
    this.editing.set(true);
    afterNextRender(() => this.emailInput()?.nativeElement.focus(), { injector: this.injector });
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
    if (!UpdateBillingEmailRequestSchema.safeParse({ billing_email: next }).success) {
      this.error.set(INVALID_EMAIL());
      afterNextRender(() => this.emailInput()?.nativeElement.focus(), { injector: this.injector });
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.setBillingEmail(next);
      await this.store.reload('billing');
      this.announcer.announce(
        next === null
          ? $localize`:@@vendor.billing.email.cleared:Billing email removed.`
          : $localize`:@@vendor.billing.email.saved:Billing email saved.`,
      );
      this.close();
    } catch (err) {
      this.error.set(billingEmailErrorMessage(err));
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
  $localize`:@@vendor.billing.email.error.invalid:Enter a valid email address.`;

/** Map the write's refusals onto copy that says what to do next. */
export function billingEmailErrorMessage(err: unknown): string {
  const status = err instanceof HttpErrorResponse ? err.status : null;
  const code =
    err instanceof HttpErrorResponse
      ? ((err.error as { error?: { code?: string } } | null)?.error?.code ?? null)
      : null;
  if (code === 'RATE_LIMITED' || status === 429) {
    return $localize`:@@vendor.billing.email.error.rate:Too many changes in a short time. Try again in a minute.`;
  }
  switch (status) {
    case 400:
      return INVALID_EMAIL();
    case 403:
      return $localize`:@@vendor.billing.email.error.forbidden:Only an account owner can change the billing email.`;
    case 404:
      return $localize`:@@vendor.billing.email.error.notFound:Your company has no billing account yet. Contact AEC Integrations.`;
    default:
      return $localize`:@@vendor.billing.email.error.generic:Could not save the billing email. Try again.`;
  }
}
