import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecCard, CARD_GRID_CLASS } from '../shared/card/card';

import type { ProductListItem } from '@aeci/shared';

import { RatingSummary } from '../reviews/rating-summary';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

import { IntegrationStat } from './integration-stat';
import { RoleBadge } from './role-badge';

/**
 * Card-grid view of the product index (Phase 2 §11.2 — `ProductCard` is scoped
 * to "index and browse pages"; this is the card-grid variant that comment
 * anticipated). Anchor: Faire (DESIGN.md Anchor-Site Rule).
 *
 * Each tile is a self-contained pitch — monogram, name, vendor, a role chip
 * (connector / hybrid only), and the integration count as a
 * Faire-"Bestseller"-style trust badge. To dodge the "identical 3×3 SaaS grid"
 * anti-reference (DESIGN.md), the grid is broken: the lead product gets a wide
 * featured card on a warm Bone band. The host only enables `featuredLead` on
 * page 1 at the newest sort, so the "Recently added" claim stays truthful.
 * Ruling 2 of 2026-11-16 keeps the lead card (mock-up 10, AECI-1793): 32px
 * padding, the name at 24px, and the count on one line like the table's.
 * Below five reviews no card carries a rating line (ruling 4).
 *
 * The whole card is one link, so the role renders as a non-link chip
 * (`RoleBadge`) to avoid nested anchors. The tile carries no category: a
 * product can sit in several categories, and no one of them is its "main" one.
 * Both themes via tokens (§11.4).
 */
/** A set column count (AECI-1785). See `ProductCardGrid.columns`. */
export type ProductCardGridColumns = 1 | 2 | 3;

@Component({
  selector: 'aec-product-card-grid',
  imports: [RouterLink, AecCard, LogoOrInitial, RoleBadge, IntegrationStat, RatingSummary],
  template: `
    <ul role="list" [class]="gridClass" [attr.data-columns]="columns()">
      @if (featured(); as product) {
        <li class="group/card md:col-span-2">
          <div aecCard interactive tone="warm" class="flex h-full w-full flex-col gap-4 p-8">
            <div class="flex items-start justify-between gap-4">
              <aec-logo-or-initial
                [claimStatus]="'server-filtered'"
                [src]="product.logo_url"
                [name]="product.name"
                size="lg"
              />
              @switch (featuredEyebrow()) {
                @case ('trending') {
                  <span
                    class="text-t-13 text-(--text-secondary)"
                    i18n="@@products.grid.featured.trending"
                    >Most viewed this week</span
                  >
                }
                @default {
                  <span class="text-t-13 text-(--text-secondary)" i18n="@@products.grid.featured"
                    >Recently added</span
                  >
                }
              }
            </div>
            <div class="min-w-0 flex-1">
              <p class="font-display text-t-24 leading-tight font-semibold">
                <a
                  [routerLink]="['/products', product.slug]"
                  class="text-(--text-primary) no-underline transition-colors after:absolute after:inset-0 after:rounded-card group-hover/card:text-(--accent-primary) focus-visible:outline-0"
                  >{{ product.name }}</a
                >
              </p>
              <p class="mt-1 text-sm text-(--text-secondary)">
                @if (product.vendor; as v) {
                  {{ v.name }}
                } @else {
                  <span i18n="@@products.grid.vendor.none">Independent</span>
                }
              </p>
            </div>
            <!-- Role chip row: rendered only for connector / hybrid. RoleBadge
                 renders nothing for an application, and an empty row would still
                 take a flex gap, so the row itself is gated. -->
            @if (product.product_role !== 'application') {
              <div class="flex flex-wrap items-center gap-2">
                <aec-role-badge [role]="product.product_role" [kind]="product.connector_kind" />
              </div>
            }
            <!-- Editorial rating: omitted entirely below the §5.5 ≥5-review gate
                 (the card reflows). -->
            <aec-rating-summary
              variant="inline"
              [ratingOverall]="product.rating_overall_avg"
              [reviewCount]="product.review_count"
            />
            <aec-integration-stat
              [count]="product.integration_count"
              [role]="product.product_role"
              [kind]="product.connector_kind"
              variant="inline"
            />
          </div>
        </li>
      }

      @for (product of rest(); track product.id) {
        <li class="group/card">
          <div aecCard interactive class="flex h-full w-full flex-col gap-4 p-6">
            <div class="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
              <aec-logo-or-initial
                [claimStatus]="'server-filtered'"
                [src]="product.logo_url"
                [name]="product.name"
                size="sm"
              />
              <aec-integration-stat
                [count]="product.integration_count"
                [role]="product.product_role"
                [kind]="product.connector_kind"
                variant="badge"
              />
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate font-display text-t-20 leading-tight font-semibold">
                <a
                  [routerLink]="['/products', product.slug]"
                  class="text-(--text-primary) no-underline transition-colors after:absolute after:inset-0 after:rounded-card group-hover/card:text-(--accent-primary) focus-visible:outline-0"
                  >{{ product.name }}</a
                >
              </p>
              <p class="mt-1 truncate text-sm text-(--text-secondary)">
                @if (product.vendor; as v) {
                  {{ v.name }}
                } @else {
                  <span i18n="@@products.grid.vendor.none">Independent</span>
                }
              </p>
            </div>
            <!-- Role chip row: connector / hybrid only (see the featured card). -->
            @if (product.product_role !== 'application') {
              <div class="flex flex-wrap items-center gap-2">
                <aec-role-badge [role]="product.product_role" [kind]="product.connector_kind" />
              </div>
            }
            <!-- Editorial rating: omitted entirely below the §5.5 ≥5-review gate. -->
            <aec-rating-summary
              variant="inline"
              [ratingOverall]="product.rating_overall_avg"
              [reviewCount]="product.review_count"
            />
          </div>
        </li>
      }
    </ul>
  `,
})
export class ProductCardGrid {
  protected readonly gridClass = CARD_GRID_CLASS;

  readonly products = input.required<readonly ProductListItem[]>();
  /**
   * When true, the first product is promoted to the wide "broken-grid" lead
   * card. The host only enables this on page 1 at the newest sort, so the
   * "Recently added" claim stays truthful; on later pages / other sorts it's
   * false and the grid renders uniform.
   */
  readonly featuredLead = input<boolean>(true);
  /**
   * Label for the featured lead's eyebrow. Defaults to the catalog's "Recently
   * added" (the original, unchanged string + id) so the `/products` caller is
   * untouched. The home "Trending products" section (AECI-185) passes `'trending'`
   * to render "Most viewed this week" on the same broken grid.
   */
  readonly featuredEyebrow = input<'recently-added' | 'trending'>('recently-added');
  /**
   * A set column count (AECI-1785, the product page's similar products). Any value
   * makes every row the same height. `1` keeps one column at every width, `2` keeps
   * two at `lg`, and `3` keeps the shared steps. Null, the default, sets nothing, so
   * `/products` and the term pages are unchanged. The rules live beside
   * `.aec-card-grid` in `styles.css`, because an unlayered grid rule beats a utility.
   */
  readonly columns = input<ProductCardGridColumns | null>(null);

  protected readonly featured = computed<ProductListItem | null>(() =>
    this.featuredLead() ? (this.products()[0] ?? null) : null,
  );
  protected readonly rest = computed<readonly ProductListItem[]>(() =>
    this.featuredLead() ? this.products().slice(1) : this.products(),
  );
}
