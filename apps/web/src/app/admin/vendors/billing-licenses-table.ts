import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  TemplateRef,
  computed,
  inject,
  input,
  output,
} from '@angular/core';

import type {
  AdminAgreementAcceptance,
  AdminBillingLicense,
  AdminBillingOwnerSeat,
  AdminLicenseReleaseRequest,
  AdminVendorBillingResponse,
} from '@aeci/shared';

import { formatTermDate } from '../../shared/term-date/format-term-date';
import { seatLabel } from '../seat-label';

/**
 * One license as the Billing tab renders it: the wire row plus every label derived
 * from it, built in ONE place ({@link toBillingLicenseRow}) so the table and the row
 * actions E4.2 (AECI-1371) adds read the same words.
 */
export interface BillingLicenseRow {
  readonly license: AdminBillingLicense;
  readonly sourceLabel: string;
  readonly startsLabel: string;
  /**
   * The scheduled end date, or the words for no end: "Monthly, renews" on a Stripe
   * license, "No end date" on any other source (a perpetual invoice or complimentary
   * grant from the E1.5 back-fill renews nothing).
   */
  readonly endsLabel: string;
  /** Live, or "Ended {date}" with the reason. */
  readonly statusLabel: string;
  /** "Cancels at term end: {reason}" on a flagged live license, else `null`. */
  readonly cancelLabel: string | null;
}

/** The context a row-actions template receives: `let-row` is the row. */
export interface BillingLicenseRowContext {
  readonly $implicit: BillingLicenseRow;
}

/** Source vocabulary (`LICENSE_SOURCES`). An unknown token shows as is. */
export function licenseSourceLabel(source: string): string {
  switch (source) {
    case 'stripe':
      return $localize`:@@admin.vendors.billing.source.stripe:Stripe`;
    case 'invoice':
      return $localize`:@@admin.vendors.billing.source.invoice:Invoice or PO`;
    case 'complimentary':
      return $localize`:@@admin.vendors.billing.source.complimentary:Complimentary`;
    default:
      return source;
  }
}

/** End-reason vocabulary (`LICENSE_END_REASONS`). */
export function licenseEndReasonLabel(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'lapsed':
      return $localize`:@@admin.vendors.billing.end.lapsed:lapsed`;
    case 'released':
      return $localize`:@@admin.vendors.billing.end.released:released`;
    case 'revoked':
      return $localize`:@@admin.vendors.billing.end.revoked:revoked by AEC Integrations`;
    default:
      return reason;
  }
}

/** Cancel-reason vocabulary (`LICENSE_CANCEL_REASONS`). */
export function licenseCancelReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'vendor-banned':
      return $localize`:@@admin.vendors.billing.cancel.vendorBanned:vendor banned`;
    case null:
      return $localize`:@@admin.vendors.billing.cancel.none:no reason recorded`;
    default:
      return reason;
  }
}

/** Build the row model for one license. Dates go through `formatTermDate`, the
 *  formatter that keeps a date-only `ends_at` from shifting a day (Paid Tiers §5.8). */
export function toBillingLicenseRow(
  license: AdminBillingLicense,
  locale: string,
): BillingLicenseRow {
  let statusLabel: string;
  if (license.live) {
    statusLabel = $localize`:@@admin.vendors.billing.status.live:Live`;
  } else {
    const date = license.ended_at ? formatTermDate(license.ended_at, locale) : '';
    const reason = licenseEndReasonLabel(license.end_reason);
    statusLabel = reason
      ? $localize`:@@admin.vendors.billing.status.endedReason:Ended ${date}:DATE:, ${reason}:REASON:`
      : $localize`:@@admin.vendors.billing.status.ended:Ended ${date}:DATE:`;
  }
  const cancelReason = licenseCancelReasonLabel(license.cancel_reason);
  return {
    license,
    sourceLabel: licenseSourceLabel(license.source),
    startsLabel: formatTermDate(license.starts_at, locale),
    endsLabel: license.ends_at
      ? formatTermDate(license.ends_at, locale)
      : license.source === 'stripe'
        ? $localize`:@@admin.vendors.billing.licenses.monthly:Monthly, renews`
        : $localize`:@@admin.vendors.billing.licenses.noEnd:No end date`,
    statusLabel,
    cancelLabel:
      license.live && license.cancel_at_term_end
        ? $localize`:@@admin.vendors.billing.cancelsAtTermEnd:Cancels at term end: ${cancelReason}:REASON:`
        : null,
  };
}

/**
 * The Billing tab body on `/admin/vendors/:id` (AECI-1372, E4.3; `ADMIN_PANEL_SPEC.md`
 * §5.7): the billing account, its licenses, the agreement acceptances and the
 * early-unassign requests, over `GET /api/admin/vendors/:id/billing`.
 *
 * ── PRESENTATION ONLY ────────────────────────────────────────────────────────
 * The `vendor-products-table` contract: the payload and the loading and failed
 * states come in, a retry goes out. The page owns the fetch.
 *
 * ── SEAMS ────────────────────────────────────────────────────────────────────
 *  - The grant control is PROJECTED into the Licenses section (`[billingGrant]`), so
 *    the page keeps wiring it to the live region and the refetch.
 *  - `rowActions` is a template rendered in an Actions column when set. The page puts
 *    `LicenseRowActions` there (AECI-1371, E4.2: extend, re-reference, revoke). Without
 *    it there is no Actions column.
 *
 * Read-only itself: the writes live in the projected grant control and the row actions.
 * Nothing here changes ranking or reviews, and assignment is the vendor's.
 * Light theme only.
 */
@Component({
  selector: 'aec-billing-licenses-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  templateUrl: './billing-licenses-table.html',
})
export class BillingLicensesTable {
  private readonly locale = inject(LOCALE_ID);

  readonly billing = input.required<AdminVendorBillingResponse | null>();
  readonly loading = input.required<boolean>();
  readonly failed = input.required<boolean>();
  /** E4.2's per-license actions. `null`: no Actions column. */
  readonly rowActions = input<TemplateRef<BillingLicenseRowContext> | null>(null);

  readonly retry = output<void>();

  protected readonly account = computed(() => this.billing()?.billing_account ?? null);

  protected readonly rows = computed<readonly BillingLicenseRow[]>(() =>
    (this.billing()?.licenses ?? []).map((l) => toBillingLicenseRow(l, this.locale)),
  );

  protected readonly liveCount = computed(() => this.rows().filter((r) => r.license.live).length);

  /** Live licenses flagged to end instead of renewing. Drives the banner. */
  protected readonly cancellingCount = computed(
    () => this.rows().filter((r) => r.cancelLabel !== null).length,
  );

  /**
   * Flagged licenses with no end date. They have no term end to cancel at, so the flag
   * never fires on its own: the operator revokes them by hand (ruled 2026-10-16).
   */
  protected readonly cancellingOpenEndedCount = computed(
    () => this.rows().filter((r) => r.cancelLabel !== null && r.license.ends_at === null).length,
  );

  /** The reasons on the flagged licenses, deduplicated, for the banner sentence. */
  protected readonly cancellingReasons = computed(() => {
    const reasons = new Set(
      this.rows()
        .filter((r) => r.cancelLabel !== null)
        .map((r) => licenseCancelReasonLabel(r.license.cancel_reason)),
    );
    return [...reasons].join(', ');
  });

  protected readonly acceptances = computed<readonly AdminAgreementAcceptance[]>(
    () => this.billing()?.acceptances ?? [],
  );

  protected readonly releaseRequests = computed<readonly AdminLicenseReleaseRequest[]>(
    () => this.billing()?.release_requests ?? [],
  );

  /** AECI-1373: an open request is decided on `/admin/requests`, so say where. */
  protected readonly hasOpenRelease = computed(() =>
    this.releaseRequests().some((r) => r.status === 'open'),
  );

  protected rowContext(row: BillingLicenseRow): BillingLicenseRowContext {
    return { $implicit: row };
  }

  protected seatName(seat: AdminBillingOwnerSeat): string {
    return seatLabel(seat, this.account()?.seat_emails_available !== false);
  }

  protected date(value: string): string {
    return formatTermDate(value, this.locale);
  }

  protected documentLabel(document: string): string {
    switch (document) {
      case 'vendor_terms':
        return $localize`:@@admin.vendors.billing.doc.vendorTerms:Vendor terms`;
      case 'managed_plan':
        return $localize`:@@admin.vendors.billing.doc.managedPlan:Managed plan agreement`;
      default:
        return document;
    }
  }

  protected acceptanceSourceLabel(source: string): string {
    switch (source) {
      case 'claim':
        return $localize`:@@admin.vendors.billing.acceptSource.claim:Claim form`;
      case 'checkout':
        return $localize`:@@admin.vendors.billing.acceptSource.checkout:Stripe checkout`;
      default:
        return source;
    }
  }

  protected releaseStatusLabel(status: AdminLicenseReleaseRequest['status']): string {
    switch (status) {
      case 'open':
        return $localize`:@@admin.vendors.billing.release.open:Open`;
      case 'approved':
        return $localize`:@@admin.vendors.billing.release.approved:Approved`;
      default:
        return $localize`:@@admin.vendors.billing.release.declined:Declined`;
    }
  }
}
