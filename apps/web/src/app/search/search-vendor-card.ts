import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

import { IntegrationStat } from '../products/integration-stat';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * Grid hit card for a `vendors` search result (AECI-142), bound to the
 * denormalized §7.1 vendor record.
 *
 * Built on the `/products` card-grid tile so the two tabs read the same: logo or
 * initial with the integration badge, then the company name and headquarters
 * where the product tile has its vendor. The whole card is one link. No
 * description, product count or founded year: the product tile carries none of
 * its equivalents. No account-status label either: AECI-1131 limited it to the
 * vendor detail hero and AECI-1264 removed it there too (2026-10-09).
 */
@Component({
  selector: 'aec-search-vendor-card',
  imports: [RouterLink, IntegrationStat, LogoOrInitial],
  host: { class: 'block h-full' },
  template: `
    <a
      [routerLink]="['/vendors', record().slug]"
      class="flex h-full flex-col gap-3 rounded-(--radius-lg) border border-(--border-default)
        bg-(--surface-raised) p-5 no-underline transition-colors hover:border-(--border-strong)
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
    >
      <div class="flex items-start justify-between gap-3">
        <aec-logo-or-initial [src]="record().logo_url" [name]="record().company_name" size="sm" />
        <aec-integration-stat [count]="record().integration_count" variant="badge" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate font-display text-lg font-semibold text-(--text-primary)">
          {{ record().company_name }}
        </p>
        @if (record().headquarters; as hq) {
          <p class="mt-0.5 truncate text-sm text-(--text-secondary)">{{ hq }}</p>
        }
      </div>
    </a>
  `,
})
export class SearchVendorCard {
  readonly record = input.required<AlgoliaVendorRecord>();
}
