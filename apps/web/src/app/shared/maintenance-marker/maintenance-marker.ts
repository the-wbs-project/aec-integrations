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
 * `--text-secondary`), no status hue.
 *
 * **No leading dot.** It shipped with a 6px `--text-tertiary` dot, purely
 * decorative and `aria-hidden`. It was removed because it read as a status light
 * on a chip that has exactly one state and whose entire purpose is attribution
 * WITHOUT a trust signal — the same reason there is no checkmark here. It also
 * made this chip visibly heavier than the `RoleBadge` sitting next to it. If a
 * dot ever comes back it has to mean something.
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
    <!-- Two visible labels everywhere (ruling 2026-09-28): "AEC Integrations
         maintained" and "Vendor maintained". Where the page can prove which
         company wrote, an sr-only suffix names it, so a screen reader hears
         "Vendor maintained: Procore Technologies keeps this up to date". Plain
         sr-only text, not an aria-label: a span has no role to label. No
         control flow inside the chip: a block adds whitespace between parts.
         The inner span keeps the parts one flex item, so the leading space of
         " · Updated" is not trimmed as a flex boundary. -->
    <span
      class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
        bg-(--surface-raised) px-2.5 py-1 text-[0.75rem] font-medium tracking-[0.01em]
        text-(--text-secondary)"
      ><span
        >{{ lead() }}<span class="sr-only">{{ ownerSuffix() }}</span
        >{{ dateClause() }}</span
      ></span
    >
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

  /**
   * The company behind the vendor branch, for SCREEN READERS ONLY (AECI-1142,
   * ruling 2026-09-28). The visible label is always "Vendor maintained"; this adds
   * an sr-only ": {owner} keeps this up to date". Pass it only where the name is
   * provably the company that wrote: the vendor page (the vendor itself) and the
   * product page (the product's vendor, the only party that can edit the product
   * row). The pair page passes `null`: any endpoint vendor or the integration's
   * owner can flip a pair row to `'vendor'`, and the payload does not say which.
   */
  readonly ownerName = input<string | null>(null);

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

  /** The visible attribution: exactly one of two labels. */
  protected readonly lead = computed<string>(() =>
    this.maintainedBy() === 'vendor'
      ? $localize`:@@maintenance.vendor:Vendor maintained`
      : $localize`:@@maintenance.aeci:AEC Integrations maintained`,
  );

  /** Screen-reader-only naming of the company, vendor branch only. */
  protected readonly ownerSuffix = computed<string>(() => {
    const owner = this.ownerName();
    if (this.maintainedBy() !== 'vendor' || !owner) return '';
    return $localize`:@@maintenance.vendor.owner.sr:: ${owner}:OWNER: keeps this up to date`;
  });

  /** " · Updated {date}" (vendor) or " · Reviewed {date}" (AECi), or `''`. The verb
   *  differs by branch off the SAME column: a vendor save is an update, an AECi
   *  re-check is a review, and swapping them would misattribute the act. */
  protected readonly dateClause = computed<string>(() => {
    const date = this.formattedDate();
    if (date === null) return '';
    return this.maintainedBy() === 'vendor'
      ? $localize`:@@maintenance.vendor.dated.clause: · Updated ${date}:DATE:`
      : $localize`:@@maintenance.aeci.dated.clause: · Reviewed ${date}:DATE:`;
  });
}
