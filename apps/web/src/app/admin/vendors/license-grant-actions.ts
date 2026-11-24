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

import {
  LICENSE_GRANT_WITHDRAW_REASON_MAX,
  type AdminLicenseGrant,
  type WithdrawLicenseGrantResponse,
} from '@aeci/shared';

import { AdminLicensesApi } from './admin-licenses-api';
import { AecButton } from '../../shared/button/button';
import { AecFormSubmit } from '../../shared/form-field/form-submit';
import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { QUEUE_FAILED_CLASS } from '../reviews/queue-classes';
import { VENDOR_ACTIONS_CLASS, VENDOR_FIELD_CLASS } from './vendor-console-classes';
import { CONSOLE_NOTICE_CLASS } from '../console/console-detail';

/**
 * The Withdraw action on a pending grant row of the admin Billing tab (AECI-1615;
 * `PATCH /api/admin/license-grants/:id`). Rendered in `BillingLicensesTable`'s Grants
 * section through its `grantActions` seam, as `LicenseRowActions` is for licenses.
 *
 * Only a `pending_acceptance` grant offers it. The confirm is inline, never a browser
 * `confirm()`, and it needs a reason, which stays in AECi's records. A withdrawn grant
 * writes no licenses, sends no email and changes no page.
 *
 * The confirm is danger (AECI-2124): nothing restores a withdrawn grant. Granting again
 * makes a new grant and emails the owner seats a second time.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region: `VendorDetail` owns the page's `role="status"`
 * region. Announcements leave through {@link announce}; the host refetches the billing
 * and the audit trail on {@link changed}.
 *
 * ── FOCUS (AECI-1994) ───────────────────────────────────────────────────────
 * Opening the form focuses the reason, and Cancel or Escape returns focus to Withdraw.
 * Escape does nothing while the request runs (AECI-2124). A refusal
 * focuses its message, because the confirm button was disabled while the request ran
 * and a disabled button drops focus.
 */
@Component({
  selector: 'aec-license-grant-actions',
  imports: [AecButton, AecFormSubmit],
  template: `
    @if (grant().status !== 'pending_acceptance') {
      <span class="text-(--text-tertiary)" aria-hidden="true">&ndash;</span>
      <span class="sr-only" i18n="@@admin.vendors.billing.grants.noAction"
        >No action on a grant that is not waiting</span
      >
    } @else if (!open()) {
      <button
        #trigger
        aecButton
        variant="secondary"
        compact
        type="button"
        (click)="openForm()"
        data-testid="grant-withdraw-open"
        i18n="@@admin.vendors.billing.grants.withdraw"
      >
        Withdraw
      </button>
    } @else {
      <form
        method="dialog"
        novalidate
        class="ms-auto grid w-80 max-w-full gap-4 whitespace-normal text-start"
        [attr.aria-busy]="pending() ? 'true' : null"
        (aecSubmit)="submit()"
        (keydown.escape)="onEscape($event)"
        data-testid="grant-withdraw-form"
      >
        <p [class]="noticeClass" i18n="@@admin.vendors.billing.grants.confirm">
          Withdraw this grant? The owner can no longer accept it. No subscription is written and no
          email is sent. There is no undo on this screen.
        </p>
        <div [class]="fieldClass">
          <label
            [attr.for]="idPrefix() + '-grant-reason'"
            [class]="labelClass"
            i18n="@@admin.vendors.billing.grants.reasonLabel"
          >
            Reason (required)
          </label>
          <p
            [id]="idPrefix() + '-grant-reason-help'"
            [class]="hintClass"
            i18n="@@admin.vendors.billing.grants.reasonHelp"
          >
            Kept in AECi's records with your name. Up to {{ reasonMax }} characters.
          </p>
          <textarea
            #reasonInput
            [id]="idPrefix() + '-grant-reason'"
            rows="2"
            [attr.maxlength]="reasonMax"
            required
            [disabled]="pending()"
            [attr.aria-describedby]="
              reasonError()
                ? idPrefix() + '-grant-reason-help ' + idPrefix() + '-grant-reason-error'
                : idPrefix() + '-grant-reason-help'
            "
            [attr.aria-invalid]="reasonError() ? 'true' : null"
            [value]="reason()"
            (input)="onReasonInput($event)"
            data-testid="grant-withdraw-reason"
            [class]="inputClass"
            class="min-h-20 resize-y"
          ></textarea>
          @if (reasonError()) {
            <p
              [id]="idPrefix() + '-grant-reason-error'"
              role="alert"
              [class]="errorClass"
              data-testid="grant-withdraw-reason-error"
              i18n="@@admin.vendors.billing.grants.reasonRequired"
            >
              Enter a reason for withdrawing this grant.
            </p>
          }
        </div>
        @if (failedMessage()) {
          <p #failedAlert tabindex="-1" role="alert" [class]="failedClass">
            {{ failedMessage() }}
          </p>
        }
        <div [class]="actionsClass">
          <button
            aecButton
            variant="danger"
            compact
            type="submit"
            [disabled]="pending()"
            data-testid="grant-withdraw-confirm"
          >
            @if (pending()) {
              <span i18n="@@admin.vendors.licenseActions.working">Working…</span>
            } @else {
              <span i18n="@@admin.vendors.billing.grants.confirmButton">Confirm withdraw</span>
            }
          </button>
          <button
            aecButton
            variant="ghost"
            type="button"
            (click)="close()"
            [disabled]="pending()"
            i18n="@@admin.vendors.licenseActions.cancel"
          >
            Cancel
          </button>
        </div>
      </form>
    }
  `,
})
export class LicenseGrantActions {
  private readonly api = inject(AdminLicensesApi);
  private readonly injector = inject(Injector);

  readonly grant = input.required<AdminLicenseGrant>();
  /** Prefix for the form controls' `id`/`for` pairs. Unique per row. */
  readonly idPrefix = input.required<string>();

  /** A committed withdraw. The host refetches the billing and the audit trail. */
  readonly changed = output<WithdrawLicenseGrantResponse>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly reasonMax = LICENSE_GRANT_WITHDRAW_REASON_MAX;
  protected readonly open = signal(false);
  protected readonly reason = signal('');
  protected readonly reasonError = signal(false);
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');

  private readonly reasonInput = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');
  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly failedAlert = viewChild<ElementRef<HTMLElement>>('failedAlert');

  protected openForm(): void {
    this.reason.set('');
    this.reasonError.set(false);
    this.failedMessage.set('');
    this.open.set(true);
    // The button the operator pressed is gone: put focus on the reason.
    afterNextRender(() => this.reasonInput()?.nativeElement.focus(), { injector: this.injector });
  }

  protected close(): void {
    this.open.set(false);
    this.failedMessage.set('');
    afterNextRender(() => this.trigger()?.nativeElement.focus(), { injector: this.injector });
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonError() && this.reason().trim()) this.reasonError.set(false);
  }

  protected async submit(): Promise<void> {
    if (this.pending()) return;
    const reason = this.reason().trim();
    if (!reason || reason.length > LICENSE_GRANT_WITHDRAW_REASON_MAX) {
      this.reasonError.set(true);
      this.reasonInput()?.nativeElement.focus();
      return;
    }
    this.failedMessage.set('');
    this.pending.set(true);
    try {
      const result = await this.api.withdrawLicenseGrant(this.grant().id, reason);
      this.open.set(false);
      this.changed.emit(result);
      this.announce.emit(
        $localize`:@@admin.vendors.billing.grants.announce.withdrawn:Grant withdrawn. The owner can no longer accept it.`,
      );
    } catch (err) {
      this.failedMessage.set(withdrawErrorMessage(err));
      // AECI-1994: the confirm button was disabled while the request ran, which drops focus.
      afterNextRender(() => this.failedAlert()?.nativeElement.focus(), {
        injector: this.injector,
      });
    } finally {
      this.pending.set(false);
    }
  }

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly noticeClass = CONSOLE_NOTICE_CLASS;
  protected readonly failedClass = QUEUE_FAILED_CLASS;
  protected readonly fieldClass = VENDOR_FIELD_CLASS;
  protected readonly actionsClass = VENDOR_ACTIONS_CLASS;

  /** Escape is Cancel, except while the request runs: its answer needs the form. */
  protected onEscape(event: Event): void {
    event.stopPropagation();
    if (!this.pending()) this.close();
  }
}

/** Each status the withdraw endpoint returns gets a sentence the operator can act on. */
function withdrawErrorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    switch (err.status) {
      case 400:
        return $localize`:@@admin.vendors.billing.grants.error.invalid:Enter a reason of up to ${LICENSE_GRANT_WITHDRAW_REASON_MAX}:MAX: characters.`;
      case 404:
        return $localize`:@@admin.vendors.billing.grants.error.gone:We could not find this grant. Reload the page.`;
      case 422:
        return $localize`:@@admin.vendors.billing.grants.error.notPending:This grant is no longer waiting. An owner may have accepted it, or it expired. Reload the page. Nothing was changed.`;
      case 403:
        return $localize`:@@admin.vendors.billing.grants.error.forbidden:You do not have permission to withdraw grants.`;
      case 429:
        return $localize`:@@admin.vendors.licenseActions.error.rateLimited:Too many changes at once. Wait a minute, then try again.`;
    }
  }
  return $localize`:@@admin.vendors.licenseActions.error.failed:Something went wrong. Please try again.`;
}
