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

/**
 * The Withdraw action on a pending grant row of the admin Billing tab (AECI-1615;
 * `PATCH /api/admin/license-grants/:id`). Rendered in `BillingLicensesTable`'s Grants
 * section through its `grantActions` seam, as `LicenseRowActions` is for licenses.
 *
 * Only a `pending_acceptance` grant offers it. The confirm is inline, never a browser
 * `confirm()`, and it needs a reason, which stays in AECi's records. A withdrawn grant
 * writes no licenses, sends no email and changes no page.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region: `VendorDetail` owns the page's `role="status"`
 * region. Announcements leave through {@link announce}; the host refetches the billing
 * and the audit trail on {@link changed}.
 */
@Component({
  selector: 'aec-license-grant-actions',
  template: `
    @if (grant().status !== 'pending_acceptance') {
      <span class="text-(--text-tertiary)" aria-hidden="true">&ndash;</span>
      <span class="sr-only" i18n="@@admin.vendors.billing.grants.noAction"
        >No action on a grant that is not waiting</span
      >
    } @else if (!open()) {
      <button
        #trigger
        type="button"
        (click)="openForm()"
        [class]="secondaryClass"
        data-testid="grant-withdraw-open"
        i18n="@@admin.vendors.billing.grants.withdraw"
      >
        Withdraw
      </button>
    } @else {
      <form
        novalidate
        class="ms-auto w-80 rounded-(--radius-md) bg-(--surface-sunken) p-3 text-start"
        (submit)="$event.preventDefault(); submit()"
        data-testid="grant-withdraw-form"
      >
        <p class="text-sm text-(--text-primary)" i18n="@@admin.vendors.billing.grants.confirm">
          Withdraw this grant? The owner can no longer accept it. No subscription is written and no
          email is sent. There is no undo on this screen.
        </p>
        <label
          [attr.for]="idPrefix() + '-grant-reason'"
          class="mt-3 block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
          i18n="@@admin.vendors.billing.grants.reasonLabel"
        >
          Reason (required)
        </label>
        <p
          [id]="idPrefix() + '-grant-reason-help'"
          class="mt-1 text-xs text-(--text-secondary)"
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
          class="mt-2 w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        ></textarea>
        @if (reasonError()) {
          <p
            [id]="idPrefix() + '-grant-reason-error'"
            role="alert"
            class="mt-2 text-sm font-medium text-(--text-primary)"
            data-testid="grant-withdraw-reason-error"
            i18n="@@admin.vendors.billing.grants.reasonRequired"
          >
            Enter a reason for withdrawing this grant.
          </p>
        }
        @if (failedMessage()) {
          <p role="alert" class="mt-2 text-sm font-medium text-(--text-primary)">
            {{ failedMessage() }}
          </p>
        }
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            type="submit"
            [disabled]="pending()"
            [class]="primaryClass"
            data-testid="grant-withdraw-confirm"
          >
            @if (pending()) {
              <span i18n="@@admin.vendors.licenseActions.working">Working…</span>
            } @else {
              <span i18n="@@admin.vendors.billing.grants.confirmButton">Confirm withdraw</span>
            }
          </button>
          <button
            type="button"
            (click)="close()"
            [disabled]="pending()"
            [class]="secondaryClass"
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
    } finally {
      this.pending.set(false);
    }
  }

  protected readonly primaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--text-primary) bg-(--text-primary) px-4 py-1.5 text-sm font-bold text-(--surface-base) transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-3 py-1.5 text-xs font-bold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
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
