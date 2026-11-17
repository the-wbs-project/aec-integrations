import { NgTemplateOutlet } from '@angular/common';
import { Component, input } from '@angular/core';

import type { FieldCaption, FieldCorrection } from '@aeci/shared';

import { AecCard } from '../card/card';
import { FieldCaptionLine, type FieldCaptionPage } from '../field-caption/field-caption';
import { AecIcon } from '../icon/icon';
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
  imports: [AecCard, AecIcon, FieldCaptionLine, MaintenanceMarker, NgTemplateOutlet],
  host: {
    '[class]': "variant() === 'card' ? 'hidden lg:block' : 'block lg:hidden'",
  },
  template: `
    <!-- The November 2026 language (ADR 0059): an aecCard with the facts card's overline
         group heading and its 16px glyph. From lg the heading sits left and the lines
         right, the section row's 5:7 split, so a short panel never leaves the right half
         of the page blank. Below lg it is a native <details> in the same card. -->
    @if (variant() === 'card') {
      <section
        aecCard
        aria-labelledby="listing-provenance-title"
        class="grid gap-4 p-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16"
      >
        <h2 id="listing-provenance-title" class="aec-overline text-(--text-secondary)">
          <span class="flex items-center gap-2"
            ><aec-icon name="info" decorative [size]="4" /><span i18n="@@listingProvenance.title"
              >About this listing</span
            ></span
          >
        </h2>
        <div class="min-w-0">
          <ng-container [ngTemplateOutlet]="lines" />
        </div>
      </section>
    } @else {
      <details aecCard class="group">
        <summary
          class="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4
            rounded-card px-6 py-4 text-(--text-secondary) hover:text-(--text-primary)
            focus-visible:outline-3 focus-visible:outline-offset-3
            focus-visible:outline-(--accent-primary) [&::-webkit-details-marker]:hidden"
        >
          <span class="aec-overline flex items-center gap-2"
            ><aec-icon name="info" decorative [size]="4" /><span i18n="@@listingProvenance.title"
              >About this listing</span
            ></span
          >
          <span
            class="inline-flex transition-transform duration-base ease-standard group-open:rotate-180
              motion-reduce:transition-none"
            ><aec-icon name="chevron-down" decorative [size]="5"
          /></span>
        </summary>
        <div class="border-t px-6 pt-4 pb-6">
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
