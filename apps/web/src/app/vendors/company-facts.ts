import { formatDate } from '@angular/common';
import { Component, LOCALE_ID, computed, inject, input } from '@angular/core';

import type { CompanyFactSource, CompanyFacts as CompanyFactsData } from '@aeci/shared';

import {
  companySizeLabel,
  fundingStageLabel,
  ownershipTypeLabel,
} from '../shared/company-facts/company-fact-labels';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { AecIcon } from '../shared/icon/icon';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

interface FactRow {
  readonly key: string;
  readonly label: string;
  /** `null` while AECi has the fact under review (AECI-1238): the marker takes the slot. */
  readonly value: string | null;
  readonly note: string;
  readonly url: string | null;
}

/**
 * The company fields the facts panel renders a row for, in its order. A hidden one keeps
 * its row with the "Under review" marker in it, so the vendor page counts these
 * (AECI-1666).
 */
export const COMPANY_FACT_FIELDS = [
  'headquarters',
  'founded_year',
  'company_size',
  'ownership_type',
  'parent_company',
  'funding_stage',
] as const;
export type CompanyFactField = (typeof COMPANY_FACT_FIELDS)[number];

/**
 * `CompanyFacts` (AECI-1310, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.23): the Company facts
 * cell of the vendor page's facts card (AECI-1797). The API has already applied the
 * display rule, so a null fact is simply
 * not a row. With no facts at all the panel renders nothing: blank is a normal state,
 * never "Unknown".
 *
 * Each row is label and value side by side. Who set each fact, its date and its source
 * link sit in a "Sources" pop-out behind the "i" beside the heading. It is the browser's
 * own popover (`popovertarget`), not Spartan's: the sources stay in the server HTML for
 * crawlers and no-JS readers, and the button opens them with no script. Click, Enter or
 * Space opens it, Escape or a click outside closes it, Tab moves from the "i" into it,
 * and closing returns focus to the "i".
 *
 * AECI-1238 (§11d.7): a fact AECi hid while it checks it arrives `null` and is named in
 * `underReview`. Its row stays, with the under-review marker in the value's slot, and the
 * pop-out leaves it out: who set a hidden value is not shown either.
 */
@Component({
  selector: 'aec-company-facts',
  imports: [AecIcon, NewTabIcon, UnderReviewMarker],
  host: { '[class]': "rows().length > 0 ? 'block' : 'hidden'" },
  // The Sources panel is a native [popover]: the browser draws it in the top layer, so no
  // card edge clips it. With CSS anchor positioning it opens under the "i", above it when
  // the room below runs out, and stays inside the screen edges. Without it (Firefox today) it
  // stays centred, as a small dialog. Either way it scrolls inside itself on a short screen.
  styles: `
    .aec-facts-sources {
      width: min(90vw, 22rem);
      max-height: min(80dvh, 32rem);
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    @supports (position-anchor: --a) {
      .aec-facts-sources-trigger {
        anchor-name: --vendor-facts-sources;
      }
      .aec-facts-sources {
        position-anchor: --vendor-facts-sources;
        inset: auto;
        /* The area under the "i", the full screen wide. Its height is the room left below,
           so max-height caps the panel there and it scrolls inside itself. The UA's
           popover height (fit-content) would not shrink to that room. */
        position-area: block-end span-all;
        height: auto;
        max-height: min(calc(100% - 1.125rem), 32rem);
        /* Under 96px of room, the panel no longer fits, so flip-block moves it above. */
        min-height: 6rem;
        margin: 6px 0 0;
        /* Starts under the "i", and slides back in rather than run off a narrow screen. */
        left: clamp(0.75rem, anchor(left), calc(100% - min(90vw, 22rem) - 0.75rem));
        position-try-fallbacks: flip-block;
      }
    }
  `,
  template: `
    @if (rows().length > 0) {
      <section aria-labelledby="vendor-facts-title" class="space-y-3">
        <!-- The heading line stays 20px: the 44px trigger takes negative block margins. -->
        <div class="flex items-center gap-1">
          <h2
            id="vendor-facts-title"
            class="aec-overline text-(--text-secondary)"
            i18n="@@vendors.detail.metadata.companyFacts"
          >
            Company facts
          </h2>
          @if (sourced().length > 0) {
            <!-- The browser's own popover (DESIGN.md "Open by default"): the
                 sources ship in the server HTML and the button opens them with no script. -->
            <button
              type="button"
              popovertarget="vendor-facts-sources"
              data-testid="company-facts-sources-trigger"
              class="aec-facts-sources-trigger -my-3 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full
                text-(--text-secondary) transition-colors duration-fast ease-standard
                hover:bg-(--surface-sunken) hover:text-(--text-primary) focus-visible:outline-3
                focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
              i18n-aria-label="@@vendors.detail.companyFacts.sources.aria"
              aria-label="Sources for these company facts"
            >
              <aec-icon name="info" decorative [size]="4" />
            </button>

            <div
              id="vendor-facts-sources"
              popover
              role="dialog"
              aria-labelledby="vendor-facts-sources-title"
              data-testid="company-facts-sources"
              class="aec-popover aec-facts-sources space-y-3 p-4"
            >
              <h3
                id="vendor-facts-sources-title"
                class="aec-overline text-(--text-secondary)"
                i18n="@@vendors.detail.companyFacts.sources.title"
              >
                Sources
              </h3>
              <dl class="space-y-3">
                @for (row of sourced(); track row.key) {
                  <div>
                    <dt class="text-t-14 font-semibold text-(--text-primary)">{{ row.label }}</dt>
                    <!-- "Source" and its icon wrap as one, so the fallback font cannot
                         leave the icon alone on a second line. -->
                    <dd class="mt-0.5 text-xs leading-5 text-(--text-secondary)">
                      {{ row.note }}
                      @if (row.url; as url) {
                        <a
                          [href]="url"
                          target="_blank"
                          rel="noopener nofollow"
                          class="whitespace-nowrap rounded-mark text-xs font-semibold text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) [&_svg]:inline"
                        >
                          <span i18n="@@vendors.detail.companyFacts.source">Source</span>
                          <span class="sr-only">: {{ row.label }}</span>
                          <aec-new-tab-icon />
                        </a>
                      }
                    </dd>
                  </div>
                }
              </dl>
            </div>
          }
        </div>
        <!-- Label and value side by side: one shared label column (subgrid), so every
             value starts on the same line. Every line is 20px high, so the web font swap
             does not resize a row. -->
        <dl
          data-testid="company-facts-list"
          class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2"
        >
          @for (row of rows(); track row.key) {
            <div class="col-span-2 grid grid-cols-subgrid items-baseline">
              <dt class="text-t-14 leading-5 text-(--text-secondary)">{{ row.label }}</dt>
              @if (row.value === null) {
                <dd [attr.data-testid]="'company-fact-under-review-' + row.key">
                  <aec-under-review />
                </dd>
              } @else {
                <dd class="break-words text-t-14 leading-5 font-semibold text-(--text-primary)">
                  {{ row.value }}
                </dd>
              }
            </div>
          }
        </dl>
      </section>
    }
  `,
})
export class CompanyFacts {
  readonly facts = input.required<CompanyFactsData>();
  /** AECI-1238: the company fields AECi hid while it checks them (`under_review`). */
  readonly underReview = input<readonly string[]>([]);

  private readonly locale = inject(LOCALE_ID);

  protected readonly rows = computed<readonly FactRow[]>(() => {
    const f = this.facts();
    const hidden = this.underReview();
    const rows: FactRow[] = [];
    const add = (
      key: string,
      label: string,
      fact: { source: CompanyFactSource } | null,
      value: string | undefined,
      field: CompanyFactField,
    ): void => {
      if (hidden.includes(field)) {
        rows.push({ key, label, value: null, note: '', url: null });
        return;
      }
      if (fact && value !== undefined) {
        rows.push({ key, label, value, note: this.note(fact.source), url: fact.source.url });
      }
    };
    add(
      'headquarters',
      $localize`:@@vendors.detail.companyFacts.headquarters:Headquarters`,
      f.headquarters,
      f.headquarters?.value,
      'headquarters',
    );
    add(
      'founded',
      $localize`:@@vendors.detail.companyFacts.founded:Founded`,
      f.founded_year,
      f.founded_year ? String(f.founded_year.value) : undefined,
      'founded_year',
    );
    add(
      'size',
      $localize`:@@vendors.detail.companyFacts.size:Employees`,
      f.company_size,
      f.company_size ? companySizeLabel(f.company_size.value) : undefined,
      'company_size',
    );
    add(
      'ownership',
      $localize`:@@vendors.detail.companyFacts.ownership:Ownership`,
      f.ownership_type,
      f.ownership_type ? ownershipTypeLabel(f.ownership_type.value) : undefined,
      'ownership_type',
    );
    add(
      'parent',
      $localize`:@@vendors.detail.companyFacts.parent:Parent company`,
      f.parent_company,
      f.parent_company?.value,
      'parent_company',
    );
    add(
      'funding',
      $localize`:@@vendors.detail.companyFacts.funding:Funding stage`,
      f.funding_stage,
      f.funding_stage ? fundingStageLabel(f.funding_stage.value) : undefined,
      'funding_stage',
    );
    return rows;
  });

  /** The rows the Sources pop-out lists: a hidden fact names no setter (AECI-1238). */
  protected readonly sourced = computed(() => this.rows().filter((r) => r.value !== null));

  private note(source: CompanyFactSource): string {
    const date = source.date ? formatDate(source.date, 'MMM d, y', this.locale, 'UTC') : null;
    if (source.set_by === 'vendor') {
      return date
        ? $localize`:@@vendors.detail.companyFacts.setByVendorOn:Set by the vendor on ${date}:DATE:`
        : $localize`:@@vendors.detail.companyFacts.setByVendor:Set by the vendor`;
    }
    return date
      ? $localize`:@@vendors.detail.companyFacts.setByAeciOn:Set by AEC Integrations on ${date}:DATE:`
      : $localize`:@@vendors.detail.companyFacts.setByAeci:Set by AEC Integrations`;
  }
}
