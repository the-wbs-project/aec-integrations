import { formatDate } from '@angular/common';
import { Component, LOCALE_ID, computed, inject, input } from '@angular/core';

/** Who is on the hook for a record's accuracy. */
export type MaintainedBy = 'aeci' | 'vendor';

/**
 * The **maintenance marker** for a catalog record: who maintains it, and when it
 * was last actually reviewed. Rendered on the product detail, vendor detail, and
 * product-PAIR pages.
 *
 * The point of this component is attribution WITHOUT a trust signal. It is
 * deliberately not a checkmark, shield, or tick: AECi verifies nothing today
 * (zero vendor attestations until the Stage 2 portal), so a badge that reads as
 * endorsement would be a lie. A name and a date are falsifiable claims a reader
 * can hold us to; a checkmark is not. Same neutral chip tokens as
 * `products/agreement-badge.ts` (`--border-default` / `--surface-raised` /
 * `--text-secondary`), no status hue, decorative dot.
 *
 * ## Where the date comes from — and what it must never come from
 *
 * Both inputs are fed by the `maintenance` object on `ProductDetail`,
 * `VendorDetail`, and `ProductPairResponse`, backed by the `last_reviewed_at` /
 * `maintained_by` columns added in AECI-616 (`STAGE_2_ATTESTATIONS_SPEC.md` §13).
 * `last_reviewed_at` is written by exactly two paths — an explicit
 * `lastReviewedAt` in the promote payload, and a vendor attestation.
 *
 * **`reviewedAt` is still `null` for the overwhelming majority of records, and the
 * bare attribution that produces is correct rather than missing data.** Nothing was
 * backfilled, deliberately. The tempting substitute, `products.updated_at`, is
 * unusable on two counts:
 *
 *   1. it is declared `.$onUpdate(...)` (`apps/api/src/db/schema.ts`), so ANY
 *      write restamps it; and
 *   2. the promote ingest re-asserts `promotion_status` on every re-promote
 *      (`apps/api/src/routes/promote.ts`), so a bulk re-promote of the catalog
 *      would silently refresh every date at once. Production bears this out:
 *      60 products share a single `updated_at` day, 40 share another.
 *
 * A date that refreshes itself without anyone re-checking the record is exactly
 * the failure this marker exists to prevent. **Do not wire this input to
 * `updated_at`, `created_at`, or `promoted_at`, and do not backfill from them** —
 * that constraint outlived the Stage 1 workaround and still binds.
 *
 * The `vendor` branch is reached when a vendor holds a live attestation on the
 * record; it reverts to `aeci` when their last one is retracted, and the date
 * survives that (the review happened; withdrawing an assertion does not un-happen
 * it).
 */
@Component({
  selector: 'aec-maintenance-marker',
  template: `
    <span
      class="inline-flex items-center gap-1.5 rounded-(--radius-sm) border border-(--border-default)
        bg-(--surface-raised) px-2.5 py-1 text-[0.75rem] font-medium tracking-[0.01em]
        text-(--text-secondary)"
    >
      <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-(--text-tertiary)"></span>
      {{ label() }}
    </span>
  `,
})
export class MaintenanceMarker {
  /** Who maintains the record. `vendor` requires a live vendor attestation. */
  readonly maintainedBy = input<MaintainedBy>('aeci');

  /**
   * ISO-8601 timestamp of the last REAL review of this record, or `null` when
   * the record has never been reviewed since the marker shipped — which is still
   * the common case, since nothing was backfilled (see the class doc). `null`
   * renders bare attribution with no date clause.
   */
  readonly reviewedAt = input<string | null>(null);

  private readonly locale = inject(LOCALE_ID);

  /**
   * Formatted in UTC, not the ambient zone: the SSR Worker runs in UTC and the
   * browser does not, so a zone-local format would render two different dates
   * either side of midnight and trip a hydration mismatch.
   */
  private readonly formattedDate = computed<string | null>(() => {
    const at = this.reviewedAt();
    if (!at) return null;
    const parsed = new Date(at);
    if (Number.isNaN(parsed.getTime())) return null;
    return formatDate(parsed, 'MMMM d, y', this.locale, 'UTC');
  });

  protected readonly label = computed<string>(() => {
    const date = this.formattedDate();
    if (this.maintainedBy() === 'vendor') {
      return date === null
        ? $localize`:@@maintenance.vendor:Vendor-maintained`
        : $localize`:@@maintenance.vendor.dated:Vendor-maintained · Updated ${date}:DATE:`;
    }
    return date === null
      ? $localize`:@@maintenance.aeci:Maintained by AEC Integrations`
      : $localize`:@@maintenance.aeci.dated:Maintained by AEC Integrations · Reviewed ${date}:DATE:`;
  });
}
