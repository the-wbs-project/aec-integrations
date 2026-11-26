import { NgTemplateOutlet } from '@angular/common';
import { Component, LOCALE_ID, TemplateRef, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { VendorBillingLicense } from '@aeci/shared';
import { EXPIRY_WARNING_DAYS } from '@aeci/shared/entitlements';

import { Chip } from '../../shared/chip/chip';
import { AecIcon } from '../../shared/icon/icon';
import { formatTermDate } from '../../shared/term-date/format-term-date';
import { parseDate } from '../vendor-plan';

import {
  BILLING_LINK_CLASS,
  BILLING_TABLE_CELL_CLASS,
  BILLING_TABLE_HEAD_CLASS,
  BILLING_TABLE_REGION_CLASS,
  LICENSE_CHIP_ICON,
  LICENSE_CHIP_TONE,
} from './vendor-billing-styles';

/**
 * How a status chip is coloured (AECI-1866, AECI-1812; `LICENSE_CHIP_TONE` in
 * `vendor-billing-styles.ts`). `live` is the Forest wash. `warning`, for a live
 * subscription that ends soon or will not renew, is the strong edge with a clock.
 * `ended` is the quiet chip. The chip's words always carry the same state, so the
 * colour is never the only signal.
 */
export type VendorBillingLicenseTone = 'live' | 'warning' | 'ended';

const DAY_MS = 86_400_000;

/**
 * One license as the vendor Billing tab renders it: the wire row plus every label
 * derived from it, built in ONE place ({@link toVendorBillingLicenseRow}) so the
 * table and the E5.5 row actions read the same words.
 */
export interface VendorBillingLicenseRow {
  readonly license: VendorBillingLicense;
  readonly sourceLabel: string;
  readonly startsLabel: string;
  /** The scheduled end, the words for no end date, or, on an ended row, the day
   *  it actually ended (AECI-1866). */
  readonly endsLabel: string;
  /** "Live", "Ends soon", or "Ended" with the reason. The date is in Ends. */
  readonly statusLabel: string;
  readonly tone: VendorBillingLicenseTone;
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
      return $localize`:@@vendor.billing.end.lapsed:lapsed`;
    case 'released':
      return $localize`:@@vendor.billing.end.released:released`;
    case 'revoked':
      return $localize`:@@vendor.billing.end.revoked:by AEC Integrations`;
    case 'banned':
      return $localize`:@@vendor.billing.end.banned:account banned`;
    default:
      return reason;
  }
}

/**
 * Whether a live subscription's scheduled end falls inside the renewal warning
 * window (`EXPIRY_WARNING_DAYS`, the plan panel's "expiring" window), today or
 * later. A card subscription is never "ending soon": Stripe renews it, and its
 * `ends_at` is only the current period end. UTC days on both sides, the zone the
 * dates format in.
 */
function endsSoon(license: VendorBillingLicense, now: number): boolean {
  if (license.source === 'stripe') return false;
  const end = parseDate(license.ends_at);
  if (end === null) return false;
  const days = Math.round((utcDay(end.getTime()) - utcDay(now)) / DAY_MS);
  return days >= 0 && days <= EXPIRY_WARNING_DAYS;
}

function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Build the row model. Dates go through `formatTermDate`, which keeps a
 *  date-only value on its own day (Paid Tiers §5.8). `now` decides "Ends soon". */
export function toVendorBillingLicenseRow(
  license: VendorBillingLicense,
  locale: string,
  now: number,
): VendorBillingLicenseRow {
  let statusLabel: string;
  let tone: VendorBillingLicenseTone;
  if (!license.live) {
    tone = 'ended';
    const reason = endReasonLabel(license.end_reason);
    statusLabel = reason
      ? $localize`:@@vendor.billing.status.endedNoDate:Ended, ${reason}:REASON:`
      : $localize`:@@vendor.billing.status.endedBare:Ended`;
  } else if (endsSoon(license, now)) {
    tone = 'warning';
    statusLabel = $localize`:@@vendor.billing.status.endsSoon:Ends soon`;
  } else {
    // A live subscription that will not renew keeps the word "Live". Its "Cancels at
    // term end" badge says so in words, and the warning tone repeats it in colour.
    tone = license.cancel_at_term_end ? 'warning' : 'live';
    statusLabel = $localize`:@@vendor.billing.status.live:Live`;
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
  // An ended row's Ends is the day it ended, not the term end it never reached
  // (AECI-1866). `ended_at` is always set on an ended row; the fallback is defensive.
  const endedOn = !license.live ? (license.ended_at ?? license.ends_at) : null;
  return {
    license,
    sourceLabel: vendorLicenseSourceLabel(license.source),
    startsLabel: formatTermDate(license.starts_at, locale),
    endsLabel: endedOn
      ? formatTermDate(endedOn, locale)
      : license.ends_at
        ? formatTermDate(license.ends_at, locale)
        : license.source === 'stripe'
          ? $localize`:@@vendor.billing.ends.monthly:Monthly, no end date`
          : $localize`:@@vendor.billing.ends.none:No end date`,
    statusLabel,
    tone,
    badges,
  };
}

/**
 * The licenses table on the vendor Billing tab (AECI-1390, E5.4;
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.21). One row per license.
 *
 * Live subscriptions fill the main table. Ended ones sit below it in a closed
 * native `<details>`, "Ended subscriptions (n)", with the same columns, dimmed
 * (AECI-1866). No filters: the list holds a handful of rows, and a filter would bring
 * the Same-Behavior Rule's full filter pattern with it. Both tables render from one
 * template and one `<colgroup>`, so their columns cannot drift apart.
 *
 * A license is per product. Plans never move a listing's position, so nothing here
 * talks about ranking, price or buying. Buying is the section's "Pay by card"
 * panel (AECI-1502), never a control in this table.
 *
 * ── STATUS CHIPS (AECI-1866, AECI-1812) ─────────────────────────────────────
 * The status and the badges are `aec-chip`s. The tones are `LICENSE_CHIP_TONE` in
 * `vendor-billing-styles.ts`. Until AECI-1812 they were unlayered status-chip
 * rules in `styles.css`. The cleanup slice (AECI-1729) deleted them.
 *
 * ── THE TABLES ──────────────────────────────────────────────────────────────
 * Each table scrolls sideways inside its own labelled, focusable region, so the page
 * never does (AECI-1812: at 390px the Billing page was 1056px wide).
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
  imports: [AecIcon, Chip, NgTemplateOutlet, RouterLink],
  template: `
    @if (rows().length === 0) {
      <p class="text-sm text-(--text-secondary)" i18n="@@vendor.billing.licenses.empty">
        No subscriptions yet. Subscriptions your company pays for, or that AEC Integrations grants,
        appear here.
      </p>
    } @else {
      @if (liveRows().length > 0) {
        <div
          [class]="regionClass"
          role="region"
          tabindex="0"
          aria-labelledby="vendor-billing-licenses-caption"
          data-testid="licenses-region"
        >
          <table [class]="tableClass()">
            <caption
              id="vendor-billing-licenses-caption"
              class="sr-only"
              i18n="@@vendor.billing.licenses.caption"
            >
              Subscriptions
            </caption>
            <ng-container
              [ngTemplateOutlet]="tableBody"
              [ngTemplateOutletContext]="{ $implicit: liveRows() }"
            />
          </table>
        </div>
      } @else {
        <p
          class="text-sm text-(--text-secondary)"
          data-testid="licenses-none-live"
          i18n="@@vendor.billing.licenses.noneLive"
        >
          No live subscriptions.
        </p>
      }
      @if (endedRows().length > 0) {
        <details class="group mt-4" data-testid="licenses-ended">
          <summary
            class="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-mark text-t-14 font-semibold text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary) [&::-webkit-details-marker]:hidden"
            data-testid="licenses-ended-summary"
          >
            <span
              class="inline-flex shrink-0 -rotate-90 text-(--text-secondary) transition-transform duration-200 group-open:rotate-0 motion-reduce:transition-none"
              aria-hidden="true"
            >
              <aec-icon name="chevron-down" decorative [size]="4" />
            </span>
            <span i18n="@@vendor.billing.ended.summary"
              >Ended subscriptions ({{ endedRows().length }})</span
            >
          </summary>
          <div
            [class]="regionClass + ' mt-2'"
            role="region"
            tabindex="0"
            aria-labelledby="vendor-billing-ended-caption"
          >
            <table [class]="tableClass()">
              <caption
                id="vendor-billing-ended-caption"
                class="sr-only"
                i18n="@@vendor.billing.ended.caption"
              >
                Ended subscriptions
              </caption>
              <ng-container
                [ngTemplateOutlet]="tableBody"
                [ngTemplateOutletContext]="{ $implicit: endedRows() }"
              />
            </table>
          </div>
        </details>
      }
    }
    @if (truncated()) {
      <p class="mt-2 text-xs text-(--text-secondary)" i18n="@@vendor.billing.licenses.truncated">
        Showing the first 500 subscriptions. Ask AEC Integrations for the full list.
      </p>
    }

    <ng-template #tableBody let-group>
      <colgroup>
        <!-- Fixed rem widths, never percentages: Product takes the rest, and the
             table's min width (tableClass) keeps that rest at 12rem or more, so a
             narrow screen scrolls the table instead of crushing its columns. -->
        <col class="w-[8.5rem]" />
        <col />
        <col class="w-[7.5rem]" />
        <col class="w-[7.5rem]" />
        <col class="w-[14rem]" />
        <col class="w-[8rem]" />
        @if (rowActions()) {
          <col class="w-[13rem]" />
        }
      </colgroup>
      <thead>
        <tr>
          <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.source">Source</th>
          <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.product">Product</th>
          <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.starts">Starts</th>
          <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.ends">Ends</th>
          <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.status">Status</th>
          <th scope="col" [class]="thClass" i18n="@@vendor.billing.col.reference">Reference</th>
          @if (rowActions()) {
            <th scope="col" [class]="thClass">
              <span class="sr-only" i18n="@@vendor.billing.col.actions">Actions</span>
            </th>
          }
        </tr>
      </thead>
      <tbody>
        @for (row of asRows(group); track row.license.id) {
          <tr
            [class]="row.tone === 'ended' ? 'text-(--text-secondary)' : 'text-(--text-primary)'"
            data-testid="license-row"
            [attr.data-tone]="row.tone"
          >
            <td [class]="cellClass">
              {{ row.sourceLabel }}
            </td>
            <td [class]="cellClass + ' break-words'">
              @if (row.license.assigned_product; as product) {
                <a
                  [routerLink]="['..', 'products', product.slug]"
                  [class]="row.tone === 'ended' ? endedLinkClass : linkClass"
                  >{{ product.name }}</a
                >
              } @else {
                <span class="text-(--text-secondary)" i18n="@@vendor.billing.pool">
                  In pool, not assigned
                </span>
              }
            </td>
            <td [class]="cellClass + ' text-(--text-secondary)'">{{ row.startsLabel }}</td>
            <td [class]="cellClass + ' text-(--text-secondary)'">{{ row.endsLabel }}</td>
            <td [class]="cellClass">
              <span class="flex flex-wrap items-center gap-1">
                <aec-chip
                  density="dense"
                  [tone]="chipTone[row.tone]"
                  [icon]="chipIcon[row.tone]"
                  data-testid="license-status"
                  >{{ row.statusLabel }}</aec-chip
                >
                @for (badge of row.badges; track badge) {
                  <aec-chip density="dense" tone="strong" data-testid="license-badge">{{
                    badge
                  }}</aec-chip>
                }
              </span>
            </td>
            <td [class]="cellClass + ' break-words text-(--text-secondary)'">
              @if (row.license.reference; as reference) {
                {{ reference }}
              } @else {
                <span aria-hidden="true">&ndash;</span>
                <span class="sr-only" i18n="@@vendor.billing.reference.none">None</span>
              }
            </td>
            @if (rowActions(); as actions) {
              <td [class]="cellClass + ' text-end'">
                <ng-container
                  [ngTemplateOutlet]="actions"
                  [ngTemplateOutletContext]="{ $implicit: row }"
                />
              </td>
            }
          </tr>
        }
      </tbody>
    </ng-template>
  `,
  styles: [':host { display: block; }'],
})
export class VendorBillingLicenses {
  private readonly locale = inject(LOCALE_ID);

  /** Live first, then ended. The API already orders them so; the split below
   *  only guards that order. */
  readonly licenses = input.required<readonly VendorBillingLicense[]>();
  /** The read hit `VENDOR_BILLING_LICENSES_MAX`. */
  readonly truncated = input(false);
  /** E5.5's per-license actions. `null`: no Actions column. */
  readonly rowActions = input<TemplateRef<VendorBillingLicenseRowContext> | null>(null);

  protected readonly rows = computed<readonly VendorBillingLicenseRow[]>(() => {
    const now = Date.now();
    return this.licenses().map((l) => toVendorBillingLicenseRow(l, this.locale, now));
  });
  protected readonly liveRows = computed(() => this.rows().filter((r) => r.license.live));
  protected readonly endedRows = computed(() => this.rows().filter((r) => !r.license.live));

  /** The template context is untyped; this narrows `let-group` for the loop. */
  protected asRows(group: unknown): readonly VendorBillingLicenseRow[] {
    return group as readonly VendorBillingLicenseRow[];
  }

  /**
   * The fixed columns plus a 12rem floor for Product: 58rem, or 71rem with the
   * 13rem Actions column. Below that the wrapper's `overflow-x-auto` scrolls.
   * Full literals so Tailwind sees both.
   */
  protected readonly tableClass = computed(() =>
    this.rowActions()
      ? 'w-full min-w-[71rem] table-fixed border-collapse text-start text-sm'
      : 'w-full min-w-[58rem] table-fixed border-collapse text-start text-sm',
  );

  protected readonly regionClass = BILLING_TABLE_REGION_CLASS;
  protected readonly thClass = BILLING_TABLE_HEAD_CLASS;
  protected readonly cellClass = BILLING_TABLE_CELL_CLASS;
  protected readonly linkClass = BILLING_LINK_CLASS;
  /** An ended row's product link: the link role in secondary ink, as the row is. */
  protected readonly endedLinkClass =
    'rounded-mark text-(--text-secondary) underline underline-offset-2 hover:text-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
  protected readonly chipTone = LICENSE_CHIP_TONE;
  protected readonly chipIcon = LICENSE_CHIP_ICON;
}
