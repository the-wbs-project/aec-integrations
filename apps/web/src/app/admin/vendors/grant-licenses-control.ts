import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';

import {
  ApiErrorCode,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  SIGNED_DEAL_ROLE_MAX,
  SIGNED_DEAL_TEXT_MAX,
  SignedDealSchema,
  type GrantLicensesResponse,
  type GrantLicensesWarning,
  type LicenseGrantStatus,
  type SignedDealInput,
} from '@aeci/shared';
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
 * ── IT WAITS FOR AN ACCEPTANCE (AECI-1615) ──────────────────────────────────
 * A grant writes a pending `license_grants` row and no licenses. They exist once an
 * owner seat accepts the Managed plan agreement on the vendor's Billing tab (counsel
 * Q5). The "Recorded signed deal" section, collapsed by default, records a deal signed
 * by a person with authority that names the agreement by version and date and says
 * signing accepts it (ruling R5). With it open, every field is required, and the grant
 * is active at once. After a grant the control says which of the two happened, from
 * the response `status`.
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
  protected readonly dealTextMax = SIGNED_DEAL_TEXT_MAX;
  protected readonly dealRoleMax = SIGNED_DEAL_ROLE_MAX;
  /** The version a grant pins today. A signed deal must name it. */
  protected readonly currentVersion = LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan;

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

  // ── Recorded signed deal (AECI-1615, ruling R5) ───────────────────────────
  protected readonly dealOpen = signal(false);
  protected readonly dealSignerName = signal('');
  protected readonly dealSignerRole = signal('');
  protected readonly dealCompany = signal('');
  protected readonly dealEmail = signal('');
  protected readonly dealReference = signal('');
  protected readonly dealVersion = signal('');
  protected readonly dealVersionDate = signal('');
  protected readonly dealSigningAccepts = signal(false);
  protected readonly dealSignedAt = signal('');
  /** The last committed grant's status, for the line under the form. */
  protected readonly lastStatus = signal<LicenseGrantStatus | null>(null);

  /** The deal block as the API takes it, or `null` while any field fails the shared
   *  schema. Only read while the section is open. */
  private readonly dealValue = computed<SignedDealInput | null>(() => {
    const parsed = SignedDealSchema.safeParse({
      signer_name: this.dealSignerName(),
      signer_role: this.dealSignerRole(),
      company_legal_name: this.dealCompany(),
      signer_email: this.dealEmail(),
      deal_reference: this.dealReference(),
      version_named: this.dealVersion(),
      version_date_named: this.dealVersionDate(),
      signing_accepts: this.dealSigningAccepts(),
      signed_at: this.dealSignedAt(),
    });
    return parsed.success ? parsed.data : null;
  });
  /** A typed email the schema refuses. An empty one only disables the submit. */
  protected readonly dealEmailInvalid = computed(
    () =>
      this.dealEmail().trim() !== '' &&
      !SignedDealSchema.shape.signer_email.safeParse(this.dealEmail()).success,
  );
  /** The API refuses any version but the one the grant pins. */
  protected readonly dealVersionMismatch = computed(
    () => this.dealVersion().trim() !== '' && this.dealVersion().trim() !== this.currentVersion,
  );
  /** `YYYY-MM-DD` strings compare correctly as text. */
  protected readonly dealSignedInFuture = computed(
    () => this.dealSignedAt() !== '' && this.dealSignedAt() > todayLocal(),
  );
  protected readonly dealValid = computed(
    () => this.dealValue() !== null && !this.dealVersionMismatch() && !this.dealSignedInFuture(),
  );

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
      this.notes().length <= LICENSE_GRANT_NOTES_MAX &&
      (!this.dealOpen() || this.dealValid()),
  );

  protected openForm(): void {
    this.failedMessage.set('');
    this.lastWarnings.set([]);
    this.lastStatus.set(null);
    this.grantId.set(crypto.randomUUID());
    this.quantity.set('1');
    this.source.set('complimentary');
    this.startsAt.set(todayLocal());
    this.endsAt.set('');
    this.reference.set('');
    this.notes.set('');
    this.dealOpen.set(false);
    this.dealSignerName.set('');
    this.dealSignerRole.set('');
    this.dealCompany.set('');
    this.dealEmail.set('');
    this.dealReference.set('');
    this.dealVersion.set(this.currentVersion);
    this.dealVersionDate.set('');
    this.dealSigningAccepts.set(false);
    this.dealSignedAt.set('');
    this.formOpen.set(true);
  }

  protected toggleDeal(): void {
    this.dealOpen.update((open) => !open);
  }

  /** One handler for the deal's text and date inputs. */
  protected onDealInput(
    target:
      | 'name'
      | 'role'
      | 'company'
      | 'email'
      | 'reference'
      | 'version'
      | 'versionDate'
      | 'signedAt',
    event: Event,
  ): void {
    const value = (event.target as HTMLInputElement).value;
    const fields = {
      name: this.dealSignerName,
      role: this.dealSignerRole,
      company: this.dealCompany,
      email: this.dealEmail,
      reference: this.dealReference,
      version: this.dealVersion,
      versionDate: this.dealVersionDate,
      signedAt: this.dealSignedAt,
    } as const;
    fields[target].set(value);
  }

  protected onDealAcceptsChange(event: Event): void {
    this.dealSigningAccepts.set((event.target as HTMLInputElement).checked);
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
    const deal = this.dealValue();
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
        ...(this.dealOpen() && deal ? { signed_deal: deal } : {}),
      });
      this.granted.emit(result);
      this.closeForm();
      this.lastWarnings.set(result.warnings);
      this.lastStatus.set(result.status);
      this.announce.emit(this.announcementFor(result));
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }

  /** Names what did NOT happen as well as what did: no product changed plan, and a
   *  pending grant has no subscriptions yet (AECI-1615). */
  private announcementFor(result: GrantLicensesResponse): string {
    const count = result.grant.quantity;
    const vendor = this.vendorName();
    if (result.replayed) {
      return $localize`:@@admin.vendors.licenses.announce.replayed:This grant was already recorded for ${vendor}:VENDOR:. Nothing changed.`;
    }
    if (result.status === 'accepted') {
      return count === 1
        ? $localize`:@@admin.vendors.billing.grants.announce.activeOne:1 subscription granted to ${vendor}:VENDOR:. Active: recorded signed deal. It is not on a product yet.`
        : $localize`:@@admin.vendors.billing.grants.announce.active:${count}:COUNT: subscriptions granted to ${vendor}:VENDOR:. Active: recorded signed deal. None is on a product yet.`;
    }
    return count === 1
      ? $localize`:@@admin.vendors.billing.grants.announce.pendingOne:1 subscription granted to ${vendor}:VENDOR:. Waiting for an owner to accept in the portal.`
      : $localize`:@@admin.vendors.billing.grants.announce.pending:${count}:COUNT: subscriptions granted to ${vendor}:VENDOR:. Waiting for an owner to accept in the portal.`;
  }
}

/** Each status and code the endpoint returns gets a sentence the operator can act on. */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const code = (err.error as { error?: { code?: string } } | null)?.error?.code;
    const field = (err.error as { error?: { field?: string } } | null)?.error?.field;
    if (err.status === 400 && field?.startsWith('signed_deal')) {
      const version = LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan;
      return $localize`:@@admin.vendors.billing.grants.error.deal:Check the signed deal: it must name version ${version}:VERSION: of the Managed plan agreement, and it cannot be signed in the future. Nothing was granted.`;
    }
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
    if (err.status === 409 && code === ApiErrorCode.VENDOR_STILL_BANNED) {
      return $localize`:@@admin.vendors.licenses.error.stillBanned:Every owner seat on this vendor is banned. Unban a seat first, then grant. Nothing was granted.`;
    }
    if (err.status === 409 && code === ApiErrorCode.VENDOR_SEATS_CHANGED) {
      return $localize`:@@admin.vendors.licenses.error.seatsChanged:This vendor's seats changed while the grant ran. Reload the page and check its seats. Nothing was granted.`;
    }
    if (err.status === 409) {
      return $localize`:@@admin.vendors.licenses.error.conflict:This grant clashes with one already recorded. Cancel, reopen the form and grant again. Nothing was written.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.vendors.licenses.error.forbidden:You do not have permission to grant subscriptions.`;
    }
    if (err.status === 429) {
      return $localize`:@@admin.vendors.licenses.error.rateLimited:Too many changes at once. Wait a minute, then try again.`;
    }
  }
  return $localize`:@@admin.vendors.licenses.error.failed:Something went wrong. Please try again.`;
}
