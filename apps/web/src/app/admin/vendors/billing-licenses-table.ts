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
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  AdminAgreementAcceptance,
  AdminBillingLicense,
  AdminLicenseGrant,
  AdminBillingOwnerSeat,
  AdminLicenseReleaseRequest,
  AdminVendorBillingResponse,
} from '@aeci/shared';

import { formatTermDate } from '../../shared/term-date/format-term-date';
import { plansSnapshotHref } from '../../vendor/components/vendor-agreement-href';
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

/** One license grant as the Grants section renders it (AECI-1615). */
export interface BillingGrantRow {
  readonly grant: AdminLicenseGrant;
  readonly statusLabel: string;
  readonly kindLabel: string;
  readonly sourceLabel: string;
  readonly createdLabel: string;
  readonly endsLabel: string;
  /** "Portal" or "Signed deal" once accepted, else `null`. */
  readonly methodLabel: string | null;
  /** When it left `pending_acceptance`, else `null`. */
  readonly decidedLabel: string | null;
}

/** The context a grant-actions template receives: `let-row` is the row. */
export interface BillingGrantRowContext {
  readonly $implicit: BillingGrantRow;
}

/**
 * The context a bulk-actions template receives: `let-rows` is the checked rows (live
 * only, in table order), `let-deselect="deselect"` unchecks the given license ids, and
 * `let-busy="busy"` tells the table a run is in flight so it locks the checkboxes.
 */
export interface BillingLicenseBulkContext {
  readonly $implicit: readonly BillingLicenseRow[];
  readonly deselect: (ids: readonly string[]) => void;
  readonly busy: (pending: boolean) => void;
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
    case 'banned':
      return $localize`:@@admin.vendors.billing.end.banned2:ended when the vendor was terminated or banned`;
    default:
      return reason;
  }
}

/** Cancel-reason vocabulary (`LICENSE_CANCEL_REASONS`). */
export function licenseCancelReasonLabel(reason: string | null): string {
  switch (reason) {
    case 'vendor-banned':
      return $localize`:@@admin.vendors.billing.cancel.vendorBanned:vendor banned`;
    case 'vendor-cancelled':
      return $localize`:@@admin.vendors.billing.cancel.vendorCancelled:cancelled in Stripe`;
    case null:
      return $localize`:@@admin.vendors.billing.cancel.none:no reason recorded`;
    default:
      return reason;
  }
}

/** `LICENSE_GRANT_STATUSES`. */
export function licenseGrantStatusLabel(status: string): string {
  switch (status) {
    case 'pending_acceptance':
      return $localize`:@@admin.vendors.billing.grants.status.pending:Waiting for acceptance`;
    case 'accepted':
      return $localize`:@@admin.vendors.billing.grants.status.accepted:Accepted`;
    case 'withdrawn':
      return $localize`:@@admin.vendors.billing.grants.status.withdrawn:Withdrawn`;
    case 'expired':
      return $localize`:@@admin.vendors.billing.grants.status.expired:Expired, never accepted`;
    default:
      return status;
  }
}

/** `AGREEMENT_ACCEPTANCE_METHODS`. `null` on a claim or checkout row. */
export function acceptanceMethodLabel(method: string | null): string | null {
  switch (method) {
    case null:
      return null;
    case 'portal_checkbox':
      return $localize`:@@admin.vendors.billing.grants.method.portal:Portal`;
    case 'signed_deal':
      return $localize`:@@admin.vendors.billing.grants.method.deal:Signed deal`;
    default:
      return method;
  }
}

/** Build the row model for one grant (AECI-1615). */
export function toBillingGrantRow(grant: AdminLicenseGrant, locale: string): BillingGrantRow {
  return {
    grant,
    statusLabel: licenseGrantStatusLabel(grant.status),
    kindLabel:
      grant.kind === 'ban_term'
        ? $localize`:@@admin.vendors.billing.grants.kind.banTerm:Ban term`
        : $localize`:@@admin.vendors.billing.grants.kind.grant:Grant`,
    sourceLabel: licenseSourceLabel(grant.source),
    createdLabel: formatTermDate(grant.created_at, locale),
    endsLabel: formatTermDate(grant.ends_at, locale),
    methodLabel: acceptanceMethodLabel(grant.acceptance_method),
    decidedLabel: grant.decided_at ? formatTermDate(grant.decided_at, locale) : null,
  };
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
 *  - `grantActions` (AECI-1615) is a template rendered in the Grants section's Actions
 *    column. The page puts `LicenseGrantActions` there (Withdraw on a pending grant).
 *  - `bulkActions` adds a checkbox column at the left edge, with select-all in its
 *    header, and renders the template above the table while one or more rows are
 *    checked. The page puts `LicenseBulkActions` there. Only a live license has a box:
 *    an ended one takes no action. Selection is local UI state, keyed by license id,
 *    so a refetch keeps it and a license that ended drops out of it. While a run is in
 *    flight the boxes are disabled and the bar stays mounted, so the run cannot lose
 *    its host before it reports back.
 *
 * Read-only itself: the writes live in the projected grant control and the row actions.
 * Nothing here changes ranking or reviews, and assignment is the vendor's.
 * Light theme only.
 */
@Component({
  selector: 'aec-billing-licenses-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, RouterLink],
  templateUrl: './billing-licenses-table.html',
})
export class BillingLicensesTable {
  private readonly locale = inject(LOCALE_ID);

  readonly billing = input.required<AdminVendorBillingResponse | null>();
  readonly loading = input.required<boolean>();
  readonly failed = input.required<boolean>();
  /** E4.2's per-license actions. `null`: no Actions column. */
  readonly rowActions = input<TemplateRef<BillingLicenseRowContext> | null>(null);
  /** Bulk actions over the checked rows. `null`: no checkbox column. */
  readonly bulkActions = input<TemplateRef<BillingLicenseBulkContext> | null>(null);
  /** AECI-1615: per-grant actions. `null`: no Actions column on the Grants table. */
  readonly grantActions = input<TemplateRef<BillingGrantRowContext> | null>(null);

  readonly retry = output<void>();

  protected readonly account = computed(() => this.billing()?.billing_account ?? null);

  protected readonly rows = computed<readonly BillingLicenseRow[]>(() =>
    (this.billing()?.licenses ?? []).map((l) => toBillingLicenseRow(l, this.locale)),
  );

  protected readonly liveCount = computed(() => this.rows().filter((r) => r.license.live).length);

  // ── Selection (bulk actions) ───────────────────────────────────────────────
  private readonly selectedIds = signal<ReadonlySet<string>>(new Set());
  /** A bulk run is in flight: the boxes are locked and the bar stays up. */
  protected readonly bulkPending = signal(false);

  /** Rows that may be checked: live ones. */
  private readonly selectableRows = computed(() => this.rows().filter((r) => r.license.live));

  /** The checked rows still live on the current payload, in table order. */
  protected readonly selectedRows = computed(() => {
    const ids = this.selectedIds();
    return this.selectableRows().filter((r) => ids.has(r.license.id));
  });

  protected readonly allSelected = computed(
    () =>
      this.selectableRows().length > 0 &&
      this.selectedRows().length === this.selectableRows().length,
  );

  protected readonly someSelected = computed(
    () => this.selectedRows().length > 0 && !this.allSelected(),
  );

  protected readonly bulkContext = computed<BillingLicenseBulkContext>(() => ({
    $implicit: this.selectedRows(),
    deselect: (ids) => this.deselect(ids),
    busy: (pending) => this.bulkPending.set(pending),
  }));

  protected isSelected(row: BillingLicenseRow): boolean {
    return this.selectedIds().has(row.license.id);
  }

  protected toggle(row: BillingLicenseRow, checked: boolean): void {
    this.selectedIds.update((ids) => {
      const next = new Set(ids);
      if (checked) next.add(row.license.id);
      else next.delete(row.license.id);
      return next;
    });
  }

  protected toggleAll(checked: boolean): void {
    this.selectedIds.set(
      checked ? new Set(this.selectableRows().map((r) => r.license.id)) : new Set(),
    );
  }

  private deselect(ids: readonly string[]): void {
    this.selectedIds.update((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

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

  /** AECI-1615: pending first, then newest first, as the API orders them. Defaulted:
   *  an API that predates the field sends none. */
  protected readonly grantRows = computed<readonly BillingGrantRow[]>(() =>
    (this.billing()?.grants ?? []).map((g) => toBillingGrantRow(g, this.locale)),
  );

  protected grantContext(row: BillingGrantRow): BillingGrantRowContext {
    return { $implicit: row };
  }

  protected methodLabel(method: string | null): string | null {
    return acceptanceMethodLabel(method);
  }

  /** A claim's incorporated policy versions (AECI-1619), when both are recorded. */
  protected policiesLabel(a: AdminAgreementAcceptance): string | null {
    const listing = a.listing_accuracy_version;
    const reviews = a.review_guidelines_version;
    if (listing === null || reviews === null) return null;
    return $localize`:@@admin.vendors.billing.acceptances.policies:Policies: Listing Accuracy Policy ${listing}:LISTING_ACCURACY:, Review Guidelines ${reviews}:REVIEW_GUIDELINES:`;
  }

  /** A checkout or grant row's recorded Plans page (AECI-1619), linked to its snapshot. */
  protected plansPage(
    a: AdminAgreementAcceptance,
  ): { readonly label: string; readonly href: string | null } | null {
    const version = a.plans_page_version;
    if (version === null) return null;
    return {
      label: $localize`:@@admin.vendors.billing.acceptances.plansPage:Plans page ${version}:VERSION:`,
      href: plansSnapshotHref(version),
    };
  }

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

  protected selectLabel(row: BillingLicenseRow): string {
    const product = row.license.assigned_product?.name;
    return product
      ? $localize`:@@admin.vendors.billing.licenses.selectProduct:Select the subscription on ${product}:PRODUCT:`
      : $localize`:@@admin.vendors.billing.licenses.selectUnassigned:Select this unassigned subscription (${row.sourceLabel}:SOURCE:)`;
  }

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
      case 'grant':
        return $localize`:@@admin.vendors.billing.acceptSource.grant:Grant`;
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
