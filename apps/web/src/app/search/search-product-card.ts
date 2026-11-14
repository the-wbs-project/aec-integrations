import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecCard } from '../shared/card/card';

import type { AlgoliaProductRecord } from '@aeci/shared/algolia-records';

import { IntegrationStat } from '../products/integration-stat';
import { RoleBadge } from '../products/role-badge';
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
 * The connector / hybrid role chip is the grid tile's too: the record has carried
 * `product_role` since AECI-1086. A record indexed before then has no role and
 * shows no chip until the sync rewrites it.
 */
@Component({
  selector: 'aec-search-product-card',
  imports: [RouterLink, AecCard, IntegrationStat, LogoOrInitial, RatingSummary, RoleBadge],
  host: { class: 'block h-full' },
  template: `
    <a
      aecCard
      interactive
      [routerLink]="['/products', record().slug]"
      [attr.aria-label]="record().name"
      class="group flex h-full flex-col gap-4 p-6 no-underline focus-visible:outline-(--accent-primary)"
    >
      <div class="flex items-start justify-between gap-3">
        <aec-logo-or-initial [src]="record().logo_url" [name]="record().name" size="sm" />
        <aec-integration-stat [count]="record().integration_count" variant="badge" />
      </div>
      <div class="min-w-0 flex-1">
        <p
          class="truncate font-display text-t-20 leading-tight font-semibold text-(--text-primary) transition-colors group-hover:text-(--accent-primary)"
        >
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
      <!-- Role chip row, as the /products tile: connector / hybrid only. The row
           itself is gated so an application's card carries no empty flex gap.
           A record indexed before AECI-1086 has no role, so it is gated on the
           field being present too. -->
      @if (record().product_role; as role) {
        @if (role !== 'application') {
          <div class="flex flex-wrap items-center gap-2">
            <aec-role-badge [role]="role" />
          </div>
        }
      }
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
