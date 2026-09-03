import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';

import type {
  AdminVendorRow,
  ConnectorCatalogManagementResponse,
  ConnectorManagedBy,
  LinkRef,
} from '@aeci/shared';

import { AdminVendorsApi } from '../vendors/admin-vendors-api';
import { ManagedByApi } from './managed-by-api';

/**
 * The `managed_by` flip control (AECI-722's UI over AECI-720's endpoint).
 *
 * ── IT RE-IMPLEMENTS NOTHING ────────────────────────────────────────────────
 * `PATCH /api/admin/connector-catalogs/:id` already owns the guarded UPDATE, the
 * `audit_log` row in the same `db.batch`, the 422 same-state gate and the 404 on
 * an unknown `vendorId`. This control renders current state, collects the two
 * optional fields, and reports what came back.
 *
 * ── WHY IT CONFIRMS ─────────────────────────────────────────────────────────
 * Flipping to `vendor` FREEZES the review lane: from that moment
 * `POST /api/promote/connector-catalog` refuses every page for this catalogue
 * with `CATALOG_VENDOR_MANAGED`. That is a consequence an operator should have to
 * mean, so the action is a two-step form rather than a toggle — and the copy says
 * what freezes, because a control whose blast radius is invisible gets pressed by
 * accident.
 *
 * It also says what it does NOT do. `vendorId` is recorded in the audit metadata
 * and grants nothing: `STAGE_2_SPEC.md` §8.9(2) fences the connector seat off
 * from `vendor_entitlements` entirely, and §8.9(3) leaves provisioning unbuilt.
 * An operator who assumed "hand over the catalogue" also handed over a login
 * would be wrong in a way nothing else on the page corrects.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region, matching `EntitlementControl`'s extraction
 * contract: the host owns its single `role="status"` region and the heading level
 * its outline requires, and announcements go out through {@link announce}.
 */
@Component({
  selector: 'aec-managed-by-control',
  templateUrl: './managed-by-control.html',
})
export class ManagedByControl {
  private readonly api = inject(ManagedByApi);
  private readonly vendorsApi = inject(AdminVendorsApi);

  readonly catalogId = input.required<string>();
  readonly managedBy = input.required<ConnectorManagedBy>();
  /** The connector product, for copy that names what is being handed over. */
  readonly connector = input.required<LinkRef>();
  /** Prefix for the form controls' `id`/`for` pairs, so two controls could share
   *  a page without colliding — the same rule `EntitlementControl` states. */
  readonly idPrefix = input.required<string>();
  readonly labelledBy = input<string | null>(null);

  /** The committed readout. Emitted rather than refetched: the PATCH returns the
   *  post-state, so the host drops it straight in. */
  readonly changed = output<ConnectorCatalogManagementResponse>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  /** `null` = no form open. Otherwise the state the form will move TO. */
  protected readonly formMode = signal<ConnectorManagedBy | null>(null);
  protected readonly reason = signal('');
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');

  // ── The optional vendor, only meaningful when handing a lane over ──────────
  protected readonly vendorQuery = signal('');
  protected readonly vendorResults = signal<readonly AdminVendorRow[]>([]);
  protected readonly vendorSearching = signal(false);
  protected readonly selectedVendor = signal<AdminVendorRow | null>(null);

  protected readonly frozen = computed(() => this.managedBy() === 'vendor');
  /** The state the button offers, which is always the other one. */
  protected readonly target = computed<ConnectorManagedBy>(() =>
    this.managedBy() === 'vendor' ? 'review' : 'vendor',
  );

  protected openForm(): void {
    this.failedMessage.set('');
    this.formMode.set(this.target());
    this.reason.set('');
    this.vendorQuery.set('');
    this.vendorResults.set([]);
    this.selectedVendor.set(null);
  }

  protected closeForm(): void {
    this.formMode.set(null);
    this.reason.set('');
    this.vendorResults.set([]);
    this.selectedVendor.set(null);
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  protected onVendorQueryInput(event: Event): void {
    this.vendorQuery.set((event.target as HTMLInputElement).value);
  }

  /** Look the vendor up rather than accepting a typed id. The endpoint validates
   *  it against `vendors` anyway (a typo would otherwise park a dangling id in
   *  the audit metadata, which is the ONLY record of the handover) — searching
   *  here just means the operator finds that out before pressing the button. */
  protected async searchVendors(): Promise<void> {
    const search = this.vendorQuery().trim();
    if (!search || this.vendorSearching()) return;
    this.vendorSearching.set(true);
    try {
      const response = await this.vendorsApi.listVendors({ search, perPage: 10 });
      this.vendorResults.set(response.data);
    } catch {
      this.vendorResults.set([]);
    } finally {
      this.vendorSearching.set(false);
    }
  }

  protected chooseVendor(vendor: AdminVendorRow): void {
    this.selectedVendor.set(vendor);
    this.vendorResults.set([]);
  }

  protected clearVendor(): void {
    this.selectedVendor.set(null);
  }

  /** Send the flip, then hand the committed readout back to the host. */
  protected async submit(): Promise<void> {
    const mode = this.formMode();
    if (!mode || this.pending()) return;

    const reason = this.reason().trim();
    const vendor = this.selectedVendor();

    this.failedMessage.set('');
    this.pending.set(true);
    try {
      const result = await this.api.setManagement(this.catalogId(), {
        managedBy: mode,
        // Only ever sent on a handover: reclaiming a lane has no vendor to name.
        ...(mode === 'vendor' && vendor ? { vendorId: vendor.id } : {}),
        ...(reason ? { reason } : {}),
      });
      this.changed.emit(result);
      this.closeForm();
      this.announce.emit(this.announcementFor(mode));
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }

  private announcementFor(mode: ConnectorManagedBy): string {
    const name = this.connector().name;
    return mode === 'vendor'
      ? $localize`:@@admin.connectors.managed.announce.frozen:${name}:NAME: is now vendor-managed. The review lane is frozen for it.`
      : $localize`:@@admin.connectors.managed.announce.reclaimed:${name}:NAME: is now review-managed. The review lane is open for it again.`;
  }
}

/**
 * AECI-720's two specific failures get their own copy, because both are things
 * the operator can act on and "something went wrong" would strand them.
 *
 * A 422 means the catalogue is already in the state they asked for — someone else
 * moved it, so their mental model of who controls this lane is wrong, which is
 * exactly why the endpoint refuses to treat it as a silent no-op. A 404 on a
 * handover means the vendor id did not resolve.
 */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 422) {
      return $localize`:@@admin.connectors.managed.error.state:This catalogue is already in the lane you asked for. Someone else may have moved it. Reload to see where it stands.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.connectors.managed.error.vendor:We could not find that vendor. Search again and pick from the results.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.connectors.managed.error.forbidden:You do not have permission to change how this catalogue is managed.`;
    }
  }
  return $localize`:@@admin.connectors.managed.error.failed:Something went wrong. Please try again.`;
}
