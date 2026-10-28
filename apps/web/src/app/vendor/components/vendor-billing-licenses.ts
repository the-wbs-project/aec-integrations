import { NgTemplateOutlet } from '@angular/common';
import { Component, LOCALE_ID, TemplateRef, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { VendorBillingLicense } from '@aeci/shared';

import { formatTermDate } from '../../shared/term-date/format-term-date';

/**
 * One license as the vendor Billing tab renders it: the wire row plus every label
 * derived from it, built in ONE place ({@link toVendorBillingLicenseRow}) so the
 * table and the E5.5 row actions read the same words.
 */
export interface VendorBillingLicenseRow {
  readonly license: VendorBillingLicense;
  readonly sourceLabel: string;
  readonly startsLabel: string;
  /** The scheduled end, or the words for no end date. */
  readonly endsLabel: string;
  /** "Live", or "Ended {date}" with the reason. */
  readonly statusLabel: string;
  /** The flags on a live license, as badge text. Empty when ended. */
  readonly badges: readonly string[];
}

/** The context a row-actions template receives: `let-row` is the row. */
export interface VendorBillingLicenseRowContext {
  readonly $implicit: VendorBillingLicenseRow;
}

/** How a license was paid for (`LICENSE_SOURCES`), in the vendor's words. */
export function vendorLicenseSourceLabel(source: string): string {
  switch (source) {
    case 'complimentary':
      return $localize`:@@vendor.billing.source.complimentary:Complimentary`;
    case 'invoice':
      return $localize`:@@vendor.billing.source.invoice:Invoice`;
    case 'stripe':
      return $localize`:@@vendor.billing.source.card:Card`;
    default:
      return source;
  }
}

/** Why a license ended (`LICENSE_END_REASONS`). */
function endReasonLabel(reason: string | null): string | null {
  switch (reason) {
    case null:
      return null;
    case 'lapsed':
      return $localize`:@@vendor.billing.end.lapsed:term ended`;
    case 'released':
      return $localize`:@@vendor.billing.end.released:released`;
    case 'revoked':
      return $localize`:@@vendor.billing.end.revoked:ended by AEC Integrations`;
    default:
      return reason;
  }
}

/** Build the row model. Dates go through `formatTermDate`, which keeps a
 *  date-only value on its own day (Paid Tiers §5.8). */
export function toVendorBillingLicenseRow(
  license: VendorBillingLicense,
  locale: string,
): VendorBillingLicenseRow {
  let statusLabel: string;
  if (license.live) {
    statusLabel = $localize`:@@vendor.billing.status.live:Live`;
  } else {
    const date = license.ended_at ? formatTermDate(license.ended_at, locale) : '';
    const reason = endReasonLabel(license.end_reason);
    statusLabel = reason
      ? $localize`:@@vendor.billing.status.endedReason:Ended ${date}:DATE:, ${reason}:REASON:`
      : $localize`:@@vendor.billing.status.ended:Ended ${date}:DATE:`;
  }
  const badges: string[] = [];
  if (license.live && license.release_at_renewal) {
    badges.push($localize`:@@vendor.billing.badge.releases:Releases at renewal`);
  }
  if (license.live && license.open_release_request) {
    const date = formatTermDate(license.open_release_request.created_at, locale);
    badges.push(
      $localize`:@@vendor.billing.badge.requested:Early unassign requested ${date}:DATE:`,
    );
  }
  if (license.live && license.cancel_at_term_end) {
    badges.push($localize`:@@vendor.billing.badge.cancels:Cancels at term end`);
  }
  return {
    license,
    sourceLabel: vendorLicenseSourceLabel(license.source),
    startsLabel: formatTermDate(license.starts_at, locale),
    endsLabel: license.ends_at
      ? formatTermDate(license.ends_at, locale)
      : license.source === 'stripe'
        ? $localize`:@@vendor.billing.ends.monthly:Monthly, no end date`
        : $localize`:@@vendor.billing.ends.none:No end date`,
    statusLabel,
    badges,
  };
}

/**
 * The licenses table on the vendor Billing tab (AECI-1390, E5.4;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21). One row per license, live first, as the
 * API orders them (`GET /api/vendor/billing`).
 *
 * A license is per product. Plans never move a listing's position, so nothing here
 * talks about ranking, price or buying. Buying is the section's "Pay by card"
 * panel (AECI-1502), never a control in this table.
 *
 * ── THE ACTIONS SLOT (E5.5) ──────────────────────────────────────────────────
 * `rowActions` is a template rendered in an Actions column when set, the admin
 * table's seam (`admin/vendors/billing-licenses-table.ts`). E5.5 fills it with the
 * assign control or the actions menu (`vendor-license-actions.ts`). What a release
 * has set shows here as a Status badge, not in the actions cell.
 * Without it there is no Actions column.
 *
 * Presentation only: the section owns the read, the loading and the failure.
 */
@Component({
  selector: 'aec-vendor-billing-licenses',
  imports: [NgTemplateOutlet, RouterLink],
  template: `
    @if (rows().length === 0) {
      <p class="text-sm text-(--text-secondary)" i18n="@@vendor.billing.licenses.empty">
        No licenses yet. Licenses your company pays for, or that AEC Integrations grants, appear
        here.
      </p>
    } @else {
      <div class="overflow-x-auto">
        <table class="w-full min-w-[44rem] border-collapse text-start text-sm">
          <caption class="sr-only" i18n="@@vendor.billing.licenses.caption">
            Licenses
          </caption>
          <thead>
            <tr class="border-b border-(--border-default) text-(--text-secondary)">
              <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.source">Source</th>
              <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.product">Product</th>
              <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.starts">Starts</th>
              <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.ends">Ends</th>
              <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.status">Status</th>
              <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.reference">Reference</th>
              @if (rowActions()) {
                <th scope="col" class="py-2 font-label font-semibold">
                  <span class="sr-only" i18n="@@vendor.billing.col.actions">Actions</span>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.license.id) {
              <tr
                class="border-b border-(--border-default) last:border-0"
                data-testid="license-row"
              >
                <td class="py-3 pe-4 text-(--text-primary)">{{ row.sourceLabel }}</td>
                <td class="py-3 pe-4">
                  @if (row.license.assigned_product; as product) {
                    <a
                      [routerLink]="['..', 'products', product.slug]"
                      class="text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                      >{{ product.name }}</a
                    >
                  } @else {
                    <span class="text-(--text-secondary)" i18n="@@vendor.billing.pool">
                      In pool, not assigned
                    </span>
                  }
                </td>
                <td class="py-3 pe-4 text-(--text-secondary)">{{ row.startsLabel }}</td>
                <td class="py-3 pe-4 text-(--text-secondary)">{{ row.endsLabel }}</td>
                <td class="py-3 pe-4">
                  <span
                    class="inline-flex items-center rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]"
                    [class]="row.license.live ? liveBadgeClass : endedBadgeClass"
                    >{{ row.statusLabel }}</span
                  >
                  @for (badge of row.badges; track badge) {
                    <span
                      class="ms-1 mt-1 inline-flex items-center rounded-(--radius-sm) border border-(--border-strong) bg-(--surface-raised) px-2 py-0.5 text-xs font-semibold text-(--text-primary)"
                      >{{ badge }}</span
                    >
                  }
                </td>
                <td class="py-3 pe-4 text-(--text-secondary)">
                  @if (row.license.reference; as reference) {
                    {{ reference }}
                  } @else {
                    <span aria-hidden="true">&ndash;</span>
                    <span class="sr-only" i18n="@@vendor.billing.reference.none">None</span>
                  }
                </td>
                @if (rowActions(); as actions) {
                  <td class="py-3 text-end">
                    <ng-container
                      [ngTemplateOutlet]="actions"
                      [ngTemplateOutletContext]="{ $implicit: row }"
                    />
                  </td>
                }
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
    @if (truncated()) {
      <p class="mt-2 text-xs text-(--text-secondary)" i18n="@@vendor.billing.licenses.truncated">
        Showing the first 500 licenses. Ask AEC Integrations for the full list.
      </p>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorBillingLicenses {
  private readonly locale = inject(LOCALE_ID);

  /** Live first, then ended. The API already orders them so; the stable
   *  partition below only guards that order. */
  readonly licenses = input.required<readonly VendorBillingLicense[]>();
  /** The read hit `VENDOR_BILLING_LICENSES_MAX`. */
  readonly truncated = input(false);
  /** E5.5's per-license actions. `null`: no Actions column. */
  readonly rowActions = input<TemplateRef<VendorBillingLicenseRowContext> | null>(null);

  protected readonly rows = computed<readonly VendorBillingLicenseRow[]>(() =>
    [...this.licenses().filter((l) => l.live), ...this.licenses().filter((l) => !l.live)].map((l) =>
      toVendorBillingLicenseRow(l, this.locale),
    ),
  );

  protected readonly thClass = 'py-2 pe-4 font-label font-semibold';
  protected readonly liveBadgeClass =
    'border-(--accent-primary) bg-(--surface-raised) text-(--accent-primary)';
  protected readonly endedBadgeClass =
    'border-(--border-strong) bg-(--surface-raised) text-(--text-primary)';
}
