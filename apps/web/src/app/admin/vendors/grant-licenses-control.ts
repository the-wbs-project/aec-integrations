import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';

import type { GrantLicensesResponse, GrantLicensesWarning } from '@aeci/shared';
import {
  LICENSE_GRANT_NOTES_MAX,
  LICENSE_GRANT_QUANTITY_MAX,
  LICENSE_GRANT_REFERENCE_MAX,
  type AdminGrantLicenseSource,
} from '@aeci/shared/entitlements';

import { AdminLicensesApi } from './admin-licenses-api';

/** The operator's local today as `YYYY-MM-DD`, the form a date input holds. Local, not
 *  UTC, so an evening grant in the Americas does not prefill tomorrow. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The "Grant licenses" control on `/admin/vendors/:id` (AECI-1370, E4.1;
 * `VENDOR_SIGNUP_PROCESS.md` §3 step 5).
 *
 * ── A GRANT ASSIGNS NOTHING ─────────────────────────────────────────────────
 * It writes N unassigned licenses on the vendor's billing account. Which products
 * they go on is the vendor's choice (E5), so the copy says so: an operator who
 * expects a product to turn Managed on submit would otherwise go looking for a bug.
 *
 * ── IDEMPOTENT ON `grant_id` ────────────────────────────────────────────────
 * The control mints `grant_id` each time the form opens and sends it with every
 * submit from that form. A double click or a retry after a lost response therefore
 * replays the same grant (the API answers 200, `replayed: true`) rather than writing
 * a second set. Cancelling and reopening is a new grant.
 *
 * ── IT WARNS; IT DOES NOT GATE ──────────────────────────────────────────────
 * On a pure connector vendor it shows a note and stays enabled (AECI-738). The API
 * returns the same warning in `warnings[]`, shown after the grant.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region, like `ProvisionSeatControl`: `VendorDetail` owns
 * the page's `role="status"` region and its heading outline. Announcements leave
 * through {@link announce}.
 */
@Component({
  selector: 'aec-grant-licenses-control',
  templateUrl: './grant-licenses-control.html',
})
export class GrantLicensesControl {
  private readonly api = inject(AdminLicensesApi);

  readonly vendorId = input.required<string>();
  readonly vendorName = input.required<string>();
  /** The §8.8(1) payer test (AECI-738). Drives the warning ONLY, never the disabled state. */
  readonly isPureConnectorVendor = input.required<boolean>();
  /** Prefix for the form controls' `id`/`for` pairs. */
  readonly idPrefix = input.required<string>();
  readonly labelledBy = input<string | null>(null);

  /** The committed grant. The host refreshes the audit trail on it. */
  readonly granted = output<GrantLicensesResponse>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly quantityMax = LICENSE_GRANT_QUANTITY_MAX;
  protected readonly referenceMax = LICENSE_GRANT_REFERENCE_MAX;
  protected readonly notesMax = LICENSE_GRANT_NOTES_MAX;

  protected readonly formOpen = signal(false);
  private readonly grantId = signal('');
  protected readonly quantity = signal('1');
  protected readonly source = signal<AdminGrantLicenseSource>('complimentary');
  protected readonly startsAt = signal('');
  protected readonly endsAt = signal('');
  protected readonly reference = signal('');
  protected readonly notes = signal('');
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');
  /** The warnings the last committed grant came back with. */
  private readonly lastWarnings = signal<readonly GrantLicensesWarning[]>([]);
  protected readonly warnedConnector = computed(() =>
    this.lastWarnings().some((w) => w.code === 'pure_connector_vendor'),
  );

  protected readonly quantityValue = computed(() => {
    const raw = this.quantity().trim();
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return n >= 1 && n <= LICENSE_GRANT_QUANTITY_MAX ? n : null;
  });
  protected readonly quantityInvalid = computed(
    () => this.quantity().trim() !== '' && this.quantityValue() === null,
  );
  /** `YYYY-MM-DD` strings compare correctly as text. */
  protected readonly endNotAfterStart = computed(
    () => this.endsAt() !== '' && this.startsAt() !== '' && this.endsAt() <= this.startsAt(),
  );
  protected readonly needsReference = computed(
    () => this.source() === 'invoice' && this.reference().trim() === '',
  );

  protected readonly canSubmit = computed(
    () =>
      this.quantityValue() !== null &&
      this.startsAt() !== '' &&
      this.endsAt() !== '' &&
      !this.endNotAfterStart() &&
      !this.needsReference() &&
      this.reference().length <= LICENSE_GRANT_REFERENCE_MAX &&
      this.notes().length <= LICENSE_GRANT_NOTES_MAX,
  );

  protected openForm(): void {
    this.failedMessage.set('');
    this.lastWarnings.set([]);
    this.grantId.set(crypto.randomUUID());
    this.quantity.set('1');
    this.source.set('complimentary');
    this.startsAt.set(todayLocal());
    this.endsAt.set('');
    this.reference.set('');
    this.notes.set('');
    this.formOpen.set(true);
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.grantId.set('');
  }

  protected onQuantityInput(event: Event): void {
    this.quantity.set((event.target as HTMLInputElement).value);
  }

  protected onSourceChange(source: AdminGrantLicenseSource): void {
    this.source.set(source);
  }

  protected onStartInput(event: Event): void {
    this.startsAt.set((event.target as HTMLInputElement).value);
  }

  protected onEndInput(event: Event): void {
    this.endsAt.set((event.target as HTMLInputElement).value);
  }

  protected onReferenceInput(event: Event): void {
    this.reference.set((event.target as HTMLInputElement).value);
  }

  protected onNotesInput(event: Event): void {
    this.notes.set((event.target as HTMLTextAreaElement).value);
  }

  protected async submit(): Promise<void> {
    const quantity = this.quantityValue();
    if (quantity === null || !this.canSubmit() || this.pending()) return;

    const reference = this.reference().trim();
    const notes = this.notes().trim();
    this.failedMessage.set('');
    this.pending.set(true);
    try {
      const result = await this.api.grantLicenses(this.vendorId(), {
        grant_id: this.grantId(),
        quantity,
        source: this.source(),
        starts_at: this.startsAt(),
        ends_at: this.endsAt(),
        ...(reference ? { reference } : {}),
        ...(notes ? { notes } : {}),
      });
      this.granted.emit(result);
      this.closeForm();
      this.lastWarnings.set(result.warnings);
      this.announce.emit(this.announcementFor(result));
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }

  /** Names what did NOT happen as well as what did: no product changed plan. */
  private announcementFor(result: GrantLicensesResponse): string {
    const count = result.licenses.length;
    const vendor = this.vendorName();
    if (result.replayed) {
      return $localize`:@@admin.vendors.licenses.announce.replayed:This grant was already recorded for ${vendor}:VENDOR:. Nothing changed.`;
    }
    return count === 1
      ? $localize`:@@admin.vendors.licenses.announce.grantedOne:1 license granted to ${vendor}:VENDOR:. It is not on a product yet.`
      : $localize`:@@admin.vendors.licenses.announce.granted:${count}:COUNT: licenses granted to ${vendor}:VENDOR:. None is on a product yet.`;
  }
}

/** Each status the endpoint returns gets a sentence the operator can act on. */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 400) {
      return $localize`:@@admin.vendors.licenses.error.invalid:Check the form: the end date must be after the start, and an invoice grant needs a reference.`;
    }
    if (err.status === 404) {
      const resource = (err.error as { error?: { details?: { resource?: string } } } | null)?.error
        ?.details?.resource;
      return resource === 'billing_account'
        ? $localize`:@@admin.vendors.licenses.error.noAccount:This vendor has no billing account yet. One is created with its first owner seat. Nothing was granted.`
        : $localize`:@@admin.vendors.licenses.error.vendor:We could not find this vendor. Reload the page.`;
    }
    if (err.status === 409) {
      return $localize`:@@admin.vendors.licenses.error.conflict:This grant clashes with one already recorded. Cancel, reopen the form and grant again. Nothing was written.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.vendors.licenses.error.forbidden:You do not have permission to grant licenses.`;
    }
    if (err.status === 429) {
      return $localize`:@@admin.vendors.licenses.error.rateLimited:Too many changes at once. Wait a minute, then try again.`;
    }
  }
  return $localize`:@@admin.vendors.licenses.error.failed:Something went wrong. Please try again.`;
}
