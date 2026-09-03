import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';

import type { ProvisionVendorSeatResponse, VendorProductRoles } from '@aeci/shared';

import { productRolesLabel } from '../product-roles/product-roles-label';
import { SeatProvisionApi } from './seat-provision-api';

/** `ProvisionVendorSeatSchema.reason`'s cap, mirrored so the textarea can stop an
 *  over-long note before the round trip. A 400 from this endpoint covers BOTH the
 *  email shape and this length, and the client cannot tell them apart — so the
 *  copy names both and the field prevents the one it can. */
const REASON_MAX_LENGTH = 500;

/**
 * The seat-provisioning control (AECI-740's UI over its own endpoint).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * `STAGE_2_SPEC.md` §8.9(1) settled that a pure **connector** vendor is never
 * sold verification, and gets a catalogue-maintenance seat instead. §8.9(2)
 * showed the seat cannot be a `vendor_entitlements` row — `vendors.verified`
 * mirrors off `status = 'active'` rather than `tier`, so ANY active row lights
 * the badge. Every prior path to a seat opened one on the way, which is why
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 had to tell operators not to press Grant
 * and to park the claim instead. This control is how a parked claim finally
 * resolves.
 *
 * ── IT RE-IMPLEMENTS NOTHING ────────────────────────────────────────────────
 * `POST /api/admin/vendors/:id/seats` owns the identity resolution, the 409
 * exclusivity refusals, the `audit_log` row in the same `db.batch`, and the
 * idempotent no-op. This control collects an address and renders what came back.
 *
 * ── WHY IT CONFIRMS, AND WHAT THE COPY MUST SAY ─────────────────────────────
 * A seat is portal access to a vendor's own record, so it is a consequence an
 * operator should have to mean — hence a two-step form rather than a one-click
 * button, matching the revoke directly beneath it. The copy states what the seat
 * is NOT (no badge, no entitlement, no attestation) for the same reason
 * `ManagedByControl` states that a handover grants no seat: nothing else on the
 * page corrects the assumption, and here the assumption runs the other way.
 *
 * ── IT WARNS; IT DOES NOT GATE ──────────────────────────────────────────────
 * On a vendor that owns endpoint products the control shows a warning and stays
 * ENABLED. That is the AECI-738 rule verbatim (§5.2 step 1): `product_role` is
 * curated upstream in the review app, so a mis-roled record would hard-block a
 * legitimate operator, and §5.2 is an operator procedure rather than an API rule.
 * Turning the procedure into a gate is a separate decision.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region, matching `EntitlementControl`'s and
 * `ManagedByControl`'s extraction contract: `VendorDetail` owns the page's single
 * `role="status"` region and the heading level its outline requires, and
 * announcements leave through {@link announce}.
 */
@Component({
  selector: 'aec-provision-seat-control',
  templateUrl: './provision-seat-control.html',
})
export class ProvisionSeatControl {
  private readonly api = inject(SeatProvisionApi);

  readonly vendorId = input.required<string>();
  /** The §8.8(1) payer test, from the detail payload (AECI-738). Drives the
   *  warning ONLY — never the disabled state. */
  readonly isPureConnectorVendor = input.required<boolean>();
  readonly productRoles = input.required<VendorProductRoles>();
  /** Prefix for the form controls' `id`/`for` pairs, so two controls could share
   *  a page without colliding — the rule `EntitlementControl` states. */
  readonly idPrefix = input.required<string>();
  readonly labelledBy = input<string | null>(null);

  /** The committed readout. The host refreshes the roster and the audit trail on
   *  it, because a provision writes a row to both. */
  readonly provisioned = output<ProvisionVendorSeatResponse>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly formOpen = signal(false);
  protected readonly email = signal('');
  protected readonly reason = signal('');
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');

  /** The aggregate role breakdown in words, through the SHARED label helper so
   *  this screen and `/admin/claims` cannot describe one vendor differently. */
  protected readonly rolesLabel = computed(() => productRolesLabel(this.productRoles()));

  /** A vendor owning NO products is UNKNOWN, not exempt (AECI-738) — so it gets
   *  the warning too. `is_pure_connector_vendor` is already `false` in that case;
   *  this is only about which sentence to show. */
  protected readonly noProducts = computed(() => this.productRoles().total === 0);

  protected readonly reasonMaxLength = REASON_MAX_LENGTH;

  protected readonly canSubmit = computed(
    () => this.email().trim().length > 0 && this.reason().length <= REASON_MAX_LENGTH,
  );

  protected openForm(): void {
    this.failedMessage.set('');
    this.formOpen.set(true);
    this.email.set('');
    this.reason.set('');
  }

  protected closeForm(): void {
    this.formOpen.set(false);
    this.email.set('');
    this.reason.set('');
  }

  protected onEmailInput(event: Event): void {
    this.email.set((event.target as HTMLInputElement).value);
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  protected async submit(): Promise<void> {
    const email = this.email().trim();
    if (!email || this.pending()) return;

    const reason = this.reason().trim();
    this.failedMessage.set('');
    this.pending.set(true);
    try {
      const result = await this.api.provisionSeat(this.vendorId(), {
        email,
        ...(reason ? { reason } : {}),
      });
      this.provisioned.emit(result);
      this.closeForm();
      this.announce.emit(this.announcementFor(result));
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }

  /**
   * The announcement names what did NOT happen as well as what did. "Seat added"
   * alone would leave a screen-reader user to infer the badge state from a table
   * they have to go and read; the one thing an operator must be sure of here is
   * that provisioning did not verify the vendor.
   */
  private announcementFor(result: ProvisionVendorSeatResponse): string {
    const email = result.email;
    if (result.noop) {
      return $localize`:@@admin.vendors.provision.announce.noop:${email}:EMAIL: already holds this seat. Nothing changed.`;
    }
    return $localize`:@@admin.vendors.provision.announce.added:Seat added for ${email}:EMAIL:. No entitlement was opened and the verified badge is unchanged.`;
  }
}

/**
 * Each status the endpoint can return is something the operator can act on, so
 * each gets its own sentence. "Something went wrong" would strand them on the
 * two that matter most.
 *
 * The **503** is the one worth spelling out: `SUPABASE_SERVICE_ROLE_KEY` is
 * legitimately absent on local dev and on every PR preview, so on those tiers it
 * is the DEFAULT outcome rather than an incident — the same copy the claim queue
 * carries for the same seam.
 */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 409) {
      return $localize`:@@admin.vendors.provision.error.conflict:That account cannot take this seat: it is either a site admin or already linked to a different vendor. One account belongs to one vendor.`;
    }
    if (err.status === 503) {
      return $localize`:@@admin.vendors.provision.error.unavailable:Seat provisioning is unavailable: the account service isn't configured on this environment. Nothing was changed.`;
    }
    if (err.status === 400) {
      return $localize`:@@admin.vendors.provision.error.invalid:Check the email address and keep the reason under ${REASON_MAX_LENGTH}:MAX: characters, then try again.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.vendors.provision.error.forbidden:You do not have permission to add a seat to this vendor.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.vendors.provision.error.vendor:We could not find this vendor. Reload the page.`;
    }
  }
  return $localize`:@@admin.vendors.provision.error.failed:Something went wrong. Please try again.`;
}
