import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AlgoliaProductRecord } from '@aeci/shared/algolia-records';

import { IntegrationStat } from '../products/integration-stat';
import { RatingSummary } from '../reviews/rating-summary';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * Grid hit card for a `products` search result (AECI-142), bound to the
 * denormalized §7.1 Algolia record (no follow-up fetch).
 *
 * It is the `/products` card-grid tile (`products/product-card-grid.ts`) field
 * for field: logo or initial with the integration badge, then the name and
 * vendor, then the overall rating. The whole card is one link. A search result
 * should look like the same product does on `/products`; the earlier tile added
 * a description and taxonomy chips, which made the two pages read differently.
 * The one gap is the connector / hybrid role chip, because the Algolia record
 * carries no `product_role`.
 */
@Component({
  selector: 'aec-search-product-card',
  imports: [RouterLink, IntegrationStat, LogoOrInitial, RatingSummary],
  host: { class: 'block h-full' },
  template: `
    <a
      [routerLink]="['/products', record().slug]"
      class="flex h-full flex-col gap-3 rounded-(--radius-lg) border border-(--border-default)
        bg-(--surface-raised) p-5 no-underline transition-colors hover:border-(--border-strong)
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
    >
      <div class="flex items-start justify-between gap-3">
        <aec-logo-or-initial [src]="record().logo_url" [name]="record().name" size="sm" />
        <aec-integration-stat [count]="record().integration_count" variant="badge" />
      </div>
      <div class="min-w-0 flex-1">
        <p class="truncate font-display text-lg font-semibold text-(--text-primary)">
          {{ record().name }}
        </p>
        <p class="mt-0.5 truncate text-sm text-(--text-secondary)">
          @if (record().vendor_name; as vendorName) {
            {{ vendorName }}
          } @else {
            <span i18n="@@products.grid.vendor.none">Independent</span>
          }
        </p>
      </div>
      <!-- Overall rating, omitted below the §5.5 ≥5-review gate. -->
      <aec-rating-summary
        variant="inline"
        [ratingOverall]="record().rating_overall_avg"
        [reviewCount]="record().review_count"
      />
    </a>
  `,
})
export class SearchProductCard {
  readonly record = input.required<AlgoliaProductRecord>();
}
