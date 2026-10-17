import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  ADMIN_REASON_MAX,
  ApiErrorCode,
  type AdminBillingLicense,
  type UpdateLicenseBody,
  type UpdateLicenseResponse,
} from '@aeci/shared';
import { LICENSE_GRANT_REFERENCE_MAX } from '@aeci/shared/entitlements';

import { formatTermDate } from '../../shared/term-date/format-term-date';
import { AdminLicensesApi } from './admin-licenses-api';
import type { BillingLicenseRow } from './billing-licenses-table';

/** Which edits a license offers. Mirrors the API's refusals, so no button leads to one. */
export interface LicenseRowActionSet {
  /** Live and not Stripe. An open-ended license reads "Set end date". */
  readonly extend: boolean;
  /** Live invoice licenses only. */
  readonly reference: boolean;
  /** Any live license, Stripe included. */
  readonly revoke: boolean;
}

export function licenseRowActions(license: AdminBillingLicense): LicenseRowActionSet {
  const live = license.live;
  return {
    extend: live && license.source !== 'stripe',
    reference: live && license.source === 'invoice',
    revoke: live,
  };
}

/** The UTC calendar day of a stored ISO end, the form a date input holds. */
function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The earliest `YYYY-MM-DD` a new end date may take: the day after the current end,
 * or the day after today on an open-ended license. Shared with the bulk actions.
 */
export function licenseMinEndDay(license: AdminBillingLicense, now: Date = new Date()): string {
  const end = license.ends_at;
  const from = end ? new Date(`${utcDay(end)}T00:00:00Z`) : new Date(now.getTime());
  from.setUTCDate(from.getUTCDate() + 1);
  return from.toISOString().slice(0, 10);
}

type Mode = 'extend' | 'reference' | 'revoke';

/**
 * The per-license actions on the admin Billing tab (AECI-1371, E4.2): Extend (or Set
 * end date), Change reference, Revoke. Rendered in `BillingLicensesTable`'s Actions
 * column through its `rowActions` seam.
 *
 * ── WHAT EACH ACTION DOES ───────────────────────────────────────────────────
 *  - Extend moves the end date later. Nothing else changes, so no page purges.
 *  - Change reference rewrites an invoice license's reference.
 *  - Revoke ends the license now. On a product, the product drops to Free, its
 *    Managed fields are handed back (decision 14), and the vendor is emailed.
 *    The vendor reads the reason in its portal messages. The internal note stays in
 *    the audit trail. The confirm copy says all of this before the operator presses.
 *
 * Ended licenses offer nothing (no un-end). Stripe licenses offer only Revoke: Stripe
 * owns their term and invoice. One form open at a time.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region, like `GrantLicensesControl`: `VendorDetail` owns
 * the page's `role="status"` region. Announcements leave through {@link announce};
 * the host refetches the billing and the audit trail on {@link changed}.
 */
@Component({
  selector: 'aec-license-row-actions',
  templateUrl: './license-row-actions.html',
})
export class LicenseRowActions {
  private readonly api = inject(AdminLicensesApi);
  private readonly locale = inject(LOCALE_ID);

  readonly row = input.required<BillingLicenseRow>();
  /** Prefix for the form controls' `id`/`for` pairs. Unique per row. */
  readonly idPrefix = input.required<string>();

  /** A committed edit. The host refetches the billing and the audit trail. */
  readonly changed = output<UpdateLicenseResponse>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly reasonMax = ADMIN_REASON_MAX;
  protected readonly referenceMax = LICENSE_GRANT_REFERENCE_MAX;

  protected readonly license = computed(() => this.row().license);
  protected readonly actions = computed(() => licenseRowActions(this.license()));
  protected readonly anyAction = computed(() => {
    const a = this.actions();
    return a.extend || a.reference || a.revoke;
  });
  /** No end date yet: the extend reads "Set end date". */
  protected readonly openEnded = computed(() => this.license().ends_at === null);
  protected readonly productName = computed(() => this.license().assigned_product?.name ?? null);

  protected readonly mode = signal<Mode | null>(null);
  protected readonly endsAt = signal('');
  protected readonly reference = signal('');
  protected readonly reason = signal('');
  protected readonly internalNote = signal('');
  protected readonly reasonError = signal(false);
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');

  private readonly injector = inject(Injector);
  private readonly reasonInput = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');
  private readonly firstField = viewChild<ElementRef<HTMLElement>>('firstField');
  private readonly triggers = viewChild<ElementRef<HTMLElement>>('triggers');

  /** The earliest day the date input should offer: the day after the current end. */
  protected readonly minEnd = computed(() => licenseMinEndDay(this.license()));

  /** `YYYY-MM-DD` strings compare correctly as text. */
  protected readonly endTooEarly = computed(
    () => this.endsAt() !== '' && this.endsAt() < this.minEnd(),
  );
  protected readonly canExtend = computed(() => this.endsAt() !== '' && !this.endTooEarly());
  protected readonly canReference = computed(() => {
    const value = this.reference().trim();
    return (
      value !== '' &&
      value.length <= LICENSE_GRANT_REFERENCE_MAX &&
      value !== (this.license().reference ?? '')
    );
  });

  protected open(mode: Mode): void {
    this.failedMessage.set('');
    this.reasonError.set(false);
    this.endsAt.set('');
    this.reference.set(this.license().reference ?? '');
    this.reason.set('');
    this.internalNote.set('');
    this.mode.set(mode);
    // The button the operator pressed is gone: put focus on the form's first field.
    afterNextRender(() => this.firstField()?.nativeElement.focus(), { injector: this.injector });
  }

  protected close(): void {
    const mode = this.mode();
    this.mode.set(null);
    this.failedMessage.set('');
    // Back to the button that opened the form.
    afterNextRender(
      () =>
        this.triggers()
          ?.nativeElement.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)
          ?.focus(),
      { injector: this.injector },
    );
  }

  protected onEndInput(event: Event): void {
    this.endsAt.set((event.target as HTMLInputElement).value);
  }

  protected onReferenceInput(event: Event): void {
    this.reference.set((event.target as HTMLInputElement).value);
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonError() && this.reason().trim()) this.reasonError.set(false);
  }

  protected onNoteInput(event: Event): void {
    this.internalNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected submitExtend(): Promise<void> {
    if (!this.canExtend()) return Promise.resolve();
    return this.send({ action: 'extend', ends_at: this.endsAt() });
  }

  protected submitReference(): Promise<void> {
    if (!this.canReference()) return Promise.resolve();
    return this.send({ action: 'reference', reference: this.reference().trim() });
  }

  protected submitRevoke(): Promise<void> {
    const reason = this.reason().trim();
    if (!reason) {
      this.reasonError.set(true);
      this.reasonInput()?.nativeElement.focus();
      return Promise.resolve();
    }
    const note = this.internalNote().trim();
    return this.send({ action: 'revoke', reason, ...(note ? { internalNote: note } : {}) });
  }

  private async send(input: UpdateLicenseBody): Promise<void> {
    if (this.pending()) return;
    this.failedMessage.set('');
    this.pending.set(true);
    try {
      const result = await this.api.updateLicense(this.license().id, input);
      this.mode.set(null);
      this.changed.emit(result);
      this.announce.emit(this.announcementFor(result));
    } catch (err) {
      this.failedMessage.set(licenseErrorMessage(err));
    } finally {
      this.pending.set(false);
    }
  }

  /** Names the product and what happened to its plan, or that nothing changed. */
  private announcementFor(result: UpdateLicenseResponse): string {
    const product = this.productName();
    if (!result.changed) {
      return $localize`:@@admin.vendors.licenseActions.announce.unchanged:The license already had that reference. Nothing changed.`;
    }
    switch (result.action) {
      case 'extend': {
        const date = result.license.ends_at
          ? formatTermDate(result.license.ends_at, this.locale)
          : '';
        return $localize`:@@admin.vendors.licenseActions.announce.extended:License now ends on ${date}:DATE:.`;
      }
      case 'reference': {
        const reference = result.license.reference ?? '';
        return $localize`:@@admin.vendors.licenseActions.announce.referenced:License reference changed to ${reference}:REFERENCE:.`;
      }
      case 'revoke':
        return product
          ? $localize`:@@admin.vendors.licenseActions.announce.revokedProduct:License revoked. ${product}:PRODUCT: is on the Free plan now, and the vendor was told why.`
          : $localize`:@@admin.vendors.licenseActions.announce.revoked:License revoked. It was not on a product, so no plan changed. The vendor was told why.`;
    }
  }
}

/** Each status the endpoint returns gets a sentence the operator can act on.
 *  Shared with the bulk actions. */
export function licenseErrorMessage(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 400) {
      return $localize`:@@admin.vendors.licenseActions.error.invalid:Check the form: a new end date must be after the current one, and a reference or reason cannot be blank.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.vendors.licenseActions.error.gone:We could not find this license. Reload the page.`;
    }
    if (
      err.status === 409 &&
      (err.error as { error?: { code?: string } } | null)?.error?.code ===
        ApiErrorCode.CONTEST_INTEGRATION_CHANGED
    ) {
      // AECI-1375: the revoke ended the vendor's last live license while field
      // contests on its integrations changed. The batch rolled back.
      return $localize`:@@admin.vendors.licenseActions.error.contestChanged:Field contests on this vendor's integrations changed while the license was being revoked. Nothing was saved. Try again.`;
    }
    if (err.status === 409) {
      return $localize`:@@admin.vendors.licenseActions.error.stripe:Stripe manages this license. Change its term or invoice in Stripe. Nothing was changed.`;
    }
    if (err.status === 422) {
      return $localize`:@@admin.vendors.licenseActions.error.state:This license changed or ended since you opened it, or this change does not apply to it. Reload the page and try again. Nothing was changed.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.vendors.licenseActions.error.forbidden:You do not have permission to change licenses.`;
    }
    if (err.status === 429) {
      return $localize`:@@admin.vendors.licenseActions.error.rateLimited:Too many changes at once. Wait a minute, then try again.`;
    }
  }
  return $localize`:@@admin.vendors.licenseActions.error.failed:Something went wrong. Please try again.`;
}
