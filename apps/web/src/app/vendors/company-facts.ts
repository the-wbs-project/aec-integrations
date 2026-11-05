import { formatDate } from '@angular/common';
import { Component, LOCALE_ID, computed, inject, input } from '@angular/core';

import type { CompanyFactSource, CompanyFacts as CompanyFactsData } from '@aeci/shared';

import {
  companySizeLabel,
  fundingStageLabel,
  ownershipTypeLabel,
} from '../shared/company-facts/company-fact-labels';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

interface FactRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly url: string | null;
}

/**
 * `CompanyFacts` (AECI-1310, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.23): the vendor page's
 * facts panel. The API has already applied the display rule, so a null fact is simply
 * not a row. With no facts at all the panel renders nothing: blank is a normal state,
 * never "Unknown".
 */
@Component({
  selector: 'aec-company-facts',
  imports: [NewTabIcon],
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
        <dl class="space-y-3">
          @for (row of rows(); track row.key) {
            <div>
              <dt class="text-xs text-(--text-secondary)">{{ row.label }}</dt>
              <dd class="mt-0.5 break-words text-sm font-medium text-(--text-primary)">
                {{ row.value }}
              </dd>
              <dd class="mt-0.5 text-xs text-(--text-secondary)">
                {{ row.note }}
                @if (row.url; as url) {
                  <a
                    [href]="url"
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    class="rounded-(--radius-sm) text-xs font-medium text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) [&_svg]:inline"
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
      </section>
    }
  `,
})
export class CompanyFacts {
  readonly facts = input.required<CompanyFactsData>();

  private readonly locale = inject(LOCALE_ID);

  protected readonly rows = computed<readonly FactRow[]>(() => {
    const f = this.facts();
    const rows: FactRow[] = [];
    const add = (
      key: string,
      label: string,
      fact: { source: CompanyFactSource } | null,
      value: string | undefined,
    ): void => {
      if (fact && value !== undefined) {
        rows.push({ key, label, value, note: this.note(fact.source), url: fact.source.url });
      }
    };
    add(
      'headquarters',
      $localize`:@@vendors.detail.companyFacts.headquarters:Headquarters`,
      f.headquarters,
      f.headquarters?.value,
    );
    add(
      'founded',
      $localize`:@@vendors.detail.companyFacts.founded:Founded`,
      f.founded_year,
      f.founded_year ? String(f.founded_year.value) : undefined,
    );
    add(
      'size',
      $localize`:@@vendors.detail.companyFacts.size:Employees`,
      f.company_size,
      f.company_size ? companySizeLabel(f.company_size.value) : undefined,
    );
    add(
      'ownership',
      $localize`:@@vendors.detail.companyFacts.ownership:Ownership`,
      f.ownership_type,
      f.ownership_type ? ownershipTypeLabel(f.ownership_type.value) : undefined,
    );
    add(
      'parent',
      $localize`:@@vendors.detail.companyFacts.parent:Parent company`,
      f.parent_company,
      f.parent_company?.value,
    );
    add(
      'funding',
      $localize`:@@vendors.detail.companyFacts.funding:Funding stage`,
      f.funding_stage,
      f.funding_stage ? fundingStageLabel(f.funding_stage.value) : undefined,
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
