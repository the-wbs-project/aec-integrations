import { HttpErrorResponse } from '@angular/common/http';
import { Component, LOCALE_ID, computed, inject, input, output, signal } from '@angular/core';

import type { LinkRef, SetVendorEntitlementInput, VendorEntitlementResponse } from '@aeci/shared';

import { AdminEntitlementApi } from './admin-entitlement-api';
import { entitlementTermLabel } from './entitlement-term';

/** The three verbs of `PATCH /api/admin/vendors/:id/entitlement` (§5.1). */
export type EntitlementMode = SetVendorEntitlementInput['action'];

/**
 * The set / renew / clear entitlement control (AECI-532 §5, extracted by
 * AECI-652 §5.6).
 *
 * It lived inline in `claim-queue.html` because `/admin/claims` was the only
 * surface that could reach a vendor. `/admin/vendors/:id` is now the surface that
 * *owns* the action, and this component is why there is still exactly one copy of
 * the three sentences below rather than two that can drift apart.
 *
 * ── THE COPY IS THE POINT ────────────────────────────────────────────────────
 * Three things this control has to say, because getting them wrong is a
 * foreseeable incident rather than a typo:
 *
 *   1. Clearing an entitlement is **not** a seat revoke and **not** a ban (§5.2).
 *      Seats, logins and the dashboard all survive — read-only.
 *   2. Search is nightly in **both** directions (§5.3 / R2), so the badge can lag
 *      the action by up to a day. Never promise instant search.
 *   3. The §5.4 lockout: a cleared-but-still-seated vendor can be edited by
 *      nobody (the portal 403s, and `POST /api/promote` refuses a claimed
 *      vendor). The escape hatch — re-activate, edit, clear again — is named on
 *      screen.
 *
 * ── WHAT THIS COMPONENT DELIBERATELY DOES NOT RENDER ─────────────────────────
 * **No heading.** The block used to hard-code an `<h4>`, which is right inside a
 * claim card (shell `h1` → page `h2` → card `h3` → `h4`) and wrong on the vendor
 * page (shell `h1` → page `h2` → section `h3`). The host renders the heading at
 * whatever level its own outline requires and points `labelledBy` at it.
 *
 * **No live region.** `/admin/claims` renders one control per row, and a control
 * that owned its own `role="status"` would give that page N live regions — an
 * a11y regression that a `querySelector('[role="status"]')` assertion would not
 * even catch, since it would keep finding the first one. Announcements go out
 * through {@link announce} and the host writes them into its single region.
 *
 * `vendor` is required rather than nullable for the same reason: on a claim card
 * the vendor can genuinely be absent (a product with no `product_vendors` row),
 * and that "Unavailable" state is the host's business — the host renders it
 * instead of this component. Here, a vendor always exists.
 */
@Component({
  selector: 'aec-entitlement-control',
  templateUrl: './entitlement-control.html',
})
export class EntitlementControl {
  private readonly api = inject(AdminEntitlementApi);
  private readonly locale = inject(LOCALE_ID);

  /** The vendor the action addresses. On a claim card this is the RESOLVED target
   *  vendor — a product claim's entitlement belongs to that product's primary
   *  vendor, never to the product. */
  readonly vendor = input.required<LinkRef>();
  /** Current entitlement, or `null` for "no entitlement on record" (never granted,
   *  or cleared). */
  readonly entitlement = input.required<VendorEntitlementResponse | null>();
  /** Prefix for the form controls' `id`/`for` pairs. Two controls can share a page
   *  (`/admin/claims` renders one per row), so the ids must be caller-scoped or the
   *  labels point at the wrong inputs. */
  readonly idPrefix = input.required<string>();
  /** Id of the host's heading, wired through `aria-labelledby`. */
  readonly labelledBy = input<string | null>(null);

  /** The committed entitlement. Emitted rather than refetched: the PATCH returns
   *  the same readout the list ships, so the host drops it straight in. */
  readonly changed = output<VendorEntitlementResponse>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  /** Which verb the open form will send; `null` = no form open. */
  protected readonly formMode = signal<EntitlementMode | null>(null);
  /** Term end (`<input type="date">` → `YYYY-MM-DD`, which the wire schema accepts). */
  protected readonly periodEnd = signal('');
  protected readonly invoiceRef = signal('');
  /** Notes on set/renew; the internal audit reason on clear. */
  protected readonly note = signal('');
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');

  /** Whether the vendor currently holds the paid entitlement. `active` is the ONLY
   *  status that grants capabilities and the only one that mirrors onto the badge
   *  (§2.2) — every other status, and no row at all, reads as "not entitled". */
  protected readonly entitled = computed(() => this.entitlement()?.status === 'active');

  /** The entitlement state, as a short badge label. */
  protected readonly statusLabel = computed(() => {
    switch (this.entitlement()?.status) {
      case 'active':
        return $localize`:@@admin.claims.ent.status.active:Verified: entitlement active`;
      case 'pending':
        return $localize`:@@admin.claims.ent.status.pending:Arrangement pending`;
      case 'expired':
        return $localize`:@@admin.claims.ent.status.expired:Term expired`;
      case 'revoked':
        return $localize`:@@admin.claims.ent.status.revoked:Entitlement cleared`;
      default:
        return $localize`:@@admin.claims.ent.status.none:No entitlement on record`;
    }
  });

  /** The term readout. A `null` `period_end` is PERPETUAL (what the §2.4 backfill
   *  wrote), never "unknown" — so it must not render as a blank. Shared with
   *  `/admin/claims` so the two copies of this sentence cannot drift. */
  protected readonly termLabel = computed(() => {
    const e = this.entitlement();
    return e ? entitlementTermLabel(e.period_end, this.locale) : null;
  });

  protected openForm(mode: EntitlementMode): void {
    this.failedMessage.set('');
    this.formMode.set(mode);
    // Renew pre-fills from the current row so an admin extending a term edits one
    // field and does not silently blank the paperwork (the API patches, it does
    // not replace).
    const e = this.entitlement();
    this.periodEnd.set(mode === 'renew' ? (e?.period_end ?? '') : '');
    this.invoiceRef.set(mode === 'renew' ? (e?.invoice_ref ?? '') : '');
    this.note.set('');
  }

  protected closeForm(): void {
    this.formMode.set(null);
    this.periodEnd.set('');
    this.invoiceRef.set('');
    this.note.set('');
  }

  protected onPeriodEndInput(event: Event): void {
    this.periodEnd.set((event.target as HTMLInputElement).value);
  }

  protected onInvoiceRefInput(event: Event): void {
    this.invoiceRef.set((event.target as HTMLInputElement).value);
  }

  protected onNoteInput(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
  }

  /** Send the action, then hand the committed readout back to the host. */
  protected async submit(): Promise<void> {
    const vendor = this.vendor();
    const mode = this.formMode();
    if (!mode || this.pending()) return;

    const note = this.note().trim();
    const periodEnd = this.periodEnd().trim();
    const invoiceRef = this.invoiceRef().trim();
    const input: SetVendorEntitlementInput =
      mode === 'clear'
        ? { action: 'clear', ...(note ? { reason: note } : {}) }
        : {
            action: mode,
            ...(periodEnd ? { period_end: periodEnd } : {}),
            ...(invoiceRef ? { invoice_ref: invoiceRef } : {}),
            ...(note ? { notes: note } : {}),
          };

    this.failedMessage.set('');
    this.pending.set(true);
    try {
      const entitlement = await this.api.setEntitlement(vendor.id, input);
      this.changed.emit(entitlement);
      this.closeForm();
      this.announce.emit(this.announcementFor(mode, vendor.name));
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }

  /** Announced politely — the badge state changes in place, with no row removal to
   *  signal it. Deliberately says "within a day", never "now": the Algolia sync is
   *  nightly in BOTH directions (§5.3). */
  private announcementFor(mode: EntitlementMode, vendorName: string): string {
    switch (mode) {
      case 'set':
        return $localize`:@@admin.claims.ent.announce.set:Entitlement granted for ${vendorName}:NAME:. Search results update within a day.`;
      case 'renew':
        return $localize`:@@admin.claims.ent.announce.renewed:Entitlement renewed for ${vendorName}:NAME:.`;
      case 'clear':
        return $localize`:@@admin.claims.ent.announce.cleared:Entitlement cleared for ${vendorName}:NAME:. Portal access continues, read-only. Search results update within a day.`;
    }
  }
}

/** A 422 means the entitlement is already in the requested state (another admin got
 *  there first); a 403 is the guardrail. Both keep the form open so the reviewer can
 *  react — nothing is dropped, because an entitlement row is not a queue item. */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 422) {
      return $localize`:@@admin.claims.ent.error.state:That entitlement is already in the state you asked for. Reload to see the current one.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.claims.ent.error.forbidden:That entitlement change isn't allowed. To remove a vendor's entitlement, clear it rather than downgrading the tier.`;
    }
    if (err.status === 400) {
      return $localize`:@@admin.claims.ent.error.term:Check the term dates: the end date must come after the start date.`;
    }
  }
  return $localize`:@@admin.claims.ent.error.failed:Something went wrong. Please try again.`;
}
