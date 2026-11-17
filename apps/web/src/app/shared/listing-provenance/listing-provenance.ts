import { NgTemplateOutlet } from '@angular/common';
import { Component, input } from '@angular/core';

import type { FieldCaption, FieldCorrection } from '@aeci/shared';

import { FieldCaptionLine, type FieldCaptionPage } from '../field-caption/field-caption';
import { MaintenanceMarker, type MaintainedBy } from '../maintenance-marker/maintenance-marker';

/** One field group's "Maintained by" caption, named. `label: null` reads the bare form. */
export interface ProvenanceGroup {
  readonly label: string | null;
  readonly caption: FieldCaption;
}

/** One AECi correction, named by its field. */
export interface ProvenanceCorrection {
  readonly label: string;
  readonly correction: FieldCorrection;
}

/**
 * Two copies per page, one per width. `card` is the sidebar card from `lg`. `disclosure`
 * is a native `<details>`, closed, below `lg`.
 */
export type ListingProvenanceVariant = 'card' | 'disclosure';

/**
 * **About this listing** (AECI-1666, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.8): the one panel
 * on a product, vendor or pair page that holds every provenance statement the page makes.
 * Counsel asked for attribution on the page, not one line per block. In order:
 *
 *   1. The record line, through `MaintenanceMarker`: "AEC Integrations maintained", or
 *      "Vendor maintained · Updated {date}". An unclaimed listing always reads the AECi
 *      form (ruling 3).
 *   2. Each group with a caption: "{Group}: Maintained by {Vendor} · updated {date}".
 *   3. Each correction: "{Field}: Corrected by AEC Integrations on {date} · Source", or
 *      "{Field}: Removed by …". A removal is listed here only (ruling 1).
 *   4. How many values on the page are under review. The marker itself stays inline in
 *      the hidden value's slot.
 *   5. The product page's note that each integration's page says who maintains it.
 *
 * **Every listing shows the panel** (ruling 2026-11-17), including a listing AEC
 * Integrations maintains alone. That panel holds at least the record line "AEC
 * Integrations maintained", plus " · Reviewed {date}" when the marker has a date. A page
 * never hides the panel, so a reader always finds who maintains the listing in one place.
 *
 * **Two copies, CSS-hidden by width.** The page mounts a `card` copy at the end of the
 * sidebar and a `disclosure` copy at the end of the main column. `display: none` takes the
 * hidden copy out of the accessibility tree. The disclosure is a native `<details>`, not
 * the Angular Aria accordion, which ships an empty panel to crawlers (DESIGN.md). Only the
 * card copy carries an `id`, so the two copies never share one.
 *
 * **Visitor-neutral.** A pure function of its inputs, with dates in UTC (the children
 * format them), so it belongs in the edge-cached HTML.
 */
@Component({
  selector: 'aec-listing-provenance',
  imports: [FieldCaptionLine, MaintenanceMarker, NgTemplateOutlet],
  host: {
    '[class]': "variant() === 'card' ? 'hidden lg:block' : 'block lg:hidden'",
  },
  template: `
    @if (variant() === 'card') {
      <section aria-labelledby="listing-provenance-title" class="space-y-3">
        <h2
          id="listing-provenance-title"
          class="aec-overline text-(--text-secondary)"
          i18n="@@listingProvenance.title"
        >
          About this listing
        </h2>
        <div
          class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-4"
        >
          <ng-container [ngTemplateOutlet]="lines" />
        </div>
      </section>
    } @else {
      <details
        class="group rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised)"
      >
        <summary
          class="flex cursor-pointer list-none items-center justify-between gap-4
            rounded-(--radius-lg) px-4 py-3 focus-visible:outline-2
            focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)
            [&::-webkit-details-marker]:hidden"
        >
          <span class="aec-overline text-(--text-secondary)" i18n="@@listingProvenance.title"
            >About this listing</span
          >
          <svg
            class="size-5 shrink-0 text-(--text-secondary) transition-transform duration-200
              group-open:rotate-180 motion-reduce:transition-none"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </summary>
        <div class="border-t border-(--border-default) px-4 py-3">
          <ng-container [ngTemplateOutlet]="lines" />
        </div>
      </details>
    }

    <ng-template #lines>
      <ul class="m-0 list-none space-y-2 p-0">
        <li>
          <aec-maintenance-marker
            [maintainedBy]="maintainedBy()"
            [reviewedAt]="reviewedAt()"
            [ownerName]="ownerName()"
            [claimed]="claimed()"
          />
        </li>
        @for (group of groups(); track $index) {
          <li>
            <aec-field-caption [caption]="group.caption" [label]="group.label" [page]="page()" />
          </li>
        }
        @for (entry of corrections(); track $index) {
          <li>
            <aec-field-caption
              [correction]="entry.correction"
              [label]="entry.label"
              [page]="page()"
            />
          </li>
        }
        @if (underReviewCount() > 0) {
          <li
            class="text-xs leading-5 text-(--text-secondary)"
            data-testid="provenance-under-review"
            i18n="@@listingProvenance.underReview"
          >
            {underReviewCount(), plural,
              =1 {1 value on this page is under review.}
              other {{{ underReviewCount() }} values on this page are under review.}
            }
          </li>
        }
        @if (integrationsNote()) {
          <li
            class="text-xs leading-5 text-(--text-secondary)"
            data-testid="provenance-integrations-note"
            i18n="@@listingProvenance.integrationsNote"
          >
            Each integration's page says who maintains it.
          </li>
        }
      </ul>
    </ng-template>
  `,
})
export class ListingProvenance {
  /** Which copy this is. See {@link ListingProvenanceVariant}. */
  readonly variant = input<ListingProvenanceVariant>('card');
  /** The record's `maintenance.maintained_by`. */
  readonly maintainedBy = input<MaintainedBy>('aeci');
  /** The record's `maintenance.last_reviewed_at`, or `null` for no date clause. */
  readonly reviewedAt = input<string | null>(null);
  /** The company behind the vendor branch, for screen readers only. See the marker. */
  readonly ownerName = input<string | null>(null);
  /** Whether a company holds the listing. `false` forces the AECi record line. */
  readonly claimed = input<boolean>(true);
  /** The field groups with a "Maintained by" caption, in page order. */
  readonly groups = input<readonly ProvenanceGroup[]>([]);
  /** AECi's corrections, each named by its field. */
  readonly corrections = input<readonly ProvenanceCorrection[]>([]);
  /** How many values on the page AECi hid while it checks them. */
  readonly underReviewCount = input<number>(0);
  /** The product page's "Each integration's page says who maintains it." */
  readonly integrationsNote = input<boolean>(false);
  /** The page, for a correction's source link click. */
  readonly page = input.required<FieldCaptionPage>();
}
