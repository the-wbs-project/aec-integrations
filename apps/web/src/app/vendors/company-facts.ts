import { formatDate } from '@angular/common';
import { Component, LOCALE_ID, computed, inject, input } from '@angular/core';

import type { CompanyFactSource, CompanyFacts as CompanyFactsData } from '@aeci/shared';

import {
  companySizeLabel,
  fundingStageLabel,
  ownershipTypeLabel,
} from '../shared/company-facts/company-fact-labels';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
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
 * AECI-1238 (§11d.7): a fact AECi hid while it checks it arrives `null` and is named in
 * `underReview`. Its row stays, with the under-review marker in the value's slot and no
 * source line: who set a hidden value is not shown either.
 */
@Component({
  selector: 'aec-company-facts',
  imports: [NewTabIcon, UnderReviewMarker],
  host: { '[class]': "rows().length > 0 ? 'block' : 'hidden'" },
  template: `
    @if (rows().length > 0) {
      <section aria-labelledby="vendor-facts-title" class="space-y-3">
        <h2
          id="vendor-facts-title"
          class="aec-overline text-(--text-secondary)"
          i18n="@@vendors.detail.metadata.companyFacts"
        >
          Company facts
        </h2>
        <!-- Two columns where the facts card gives the cell its width (mock-up 11). Every
             line is 20px high, so the web font swap does not resize a row. -->
        <dl class="grid gap-4 xl:grid-cols-2 xl:gap-x-8">
          @for (row of rows(); track row.key) {
            <div>
              <dt class="text-xs leading-5 text-(--text-secondary)">{{ row.label }}</dt>
              @if (row.value === null) {
                <dd class="mt-0.5" [attr.data-testid]="'company-fact-under-review-' + row.key">
                  <aec-under-review />
                </dd>
              } @else {
                <dd
                  class="mt-0.5 break-words text-sm leading-5 font-semibold text-(--text-primary)"
                >
                  {{ row.value }}
                </dd>
                <!-- "Source" and its icon wrap as one, so the fallback font cannot leave the
                     icon alone on a second line that the web font then removes. -->
                <dd class="mt-0.5 text-xs leading-5 text-(--text-secondary)">
                  {{ row.note }}
                  @if (row.url; as url) {
                    <a
                      [href]="url"
                      target="_blank"
                      rel="noopener nofollow"
                      class="whitespace-nowrap rounded-(--radius-sm) text-xs font-semibold text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) [&_svg]:inline"
                    >
                      <span i18n="@@vendors.detail.companyFacts.source">Source</span>
                      <span class="sr-only">: {{ row.label }}</span>
                      <aec-new-tab-icon />
                    </a>
                  }
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
