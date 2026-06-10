import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductListItem } from '@aeci/shared';

import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

import { CategoryChip } from './category-chip';
import { IntegrationStat } from './integration-stat';
import { RoleBadge } from './role-badge';

/**
 * Card-grid view of the product index (Phase 2 §11.2 — `ProductCard` is scoped
 * to "index and browse pages"; this is the card-grid variant that comment
 * anticipated). Anchor: Faire (DESIGN.md Anchor-Site Rule).
 *
 * Each tile is a self-contained pitch — monogram, name, vendor, category + role
 * chips, and the integration count as a Faire-"Bestseller"-style trust badge.
 * To dodge the "identical 3×3 SaaS grid" anti-reference (DESIGN.md), the grid is
 * broken: the lead product gets a wide featured card on a warm Bone band. The
 * host only enables `featuredLead` on page 1 at the newest sort, so the
 * "Recently added" claim stays truthful.
 *
 * The whole card is one link, so category/role render as non-link chips
 * (`CategoryChip` / `RoleBadge`, not the `<a>`-based `TaxonomyBadge`) to avoid
 * nested anchors. Both themes via tokens (§11.4).
 */
@Component({
  selector: 'aec-product-card-grid',
  imports: [RouterLink, LogoOrInitial, CategoryChip, RoleBadge, IntegrationStat],
  template: `
    <ul role="list" class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      @if (featured(); as product) {
        <li class="sm:col-span-2 lg:col-span-2">
          <a
            [routerLink]="['/products', product.slug]"
            class="flex h-full flex-col gap-4 rounded-(--radius-lg) border border-(--border-default)
              bg-(--accent-warm) p-6 no-underline transition-colors hover:border-(--border-strong)
              focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)
              md:p-8"
          >
            <div class="flex items-start justify-between gap-4">
              <aec-logo-or-initial [src]="product.logo_url" [name]="product.name" size="lg" />
              @switch (featuredEyebrow()) {
                @case ('trending') {
                  <span
                    class="text-xs tracking-wide text-(--text-secondary)"
                    i18n="@@products.grid.featured.trending"
                    >Most viewed this week</span
                  >
                }
                @default {
                  <span
                    class="text-xs tracking-wide text-(--text-secondary)"
                    i18n="@@products.grid.featured"
                    >Recently added</span
                  >
                }
              }
            </div>
            <div class="min-w-0 flex-1">
              <p class="font-display text-2xl font-semibold text-(--text-primary) md:text-3xl">
                {{ product.name }}
              </p>
              <p class="mt-1 text-sm text-(--text-secondary)">
                @if (product.vendor; as v) {
                  {{ v.name }}
                } @else {
                  <span i18n="@@products.grid.vendor.none">Independent</span>
                }
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              @if (product.primary_category; as cat) {
                <aec-category-chip [name]="cat.name" />
              }
              <aec-role-badge [role]="product.product_role" />
            </div>
            <aec-integration-stat [count]="product.integration_count" variant="headline" />
          </a>
        </li>
      }

      @for (product of rest(); track product.id) {
        <li>
          <a
            [routerLink]="['/products', product.slug]"
            class="flex h-full flex-col gap-3 rounded-(--radius-lg) border border-(--border-default)
              bg-(--surface-raised) p-5 no-underline transition-colors hover:border-(--border-strong)
              focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          >
            <div class="flex items-start justify-between gap-3">
              <aec-logo-or-initial [src]="product.logo_url" [name]="product.name" size="sm" />
              <aec-integration-stat [count]="product.integration_count" variant="badge" />
            </div>
            <div class="min-w-0 flex-1">
              <p class="truncate font-display text-lg font-semibold text-(--text-primary)">
                {{ product.name }}
              </p>
              <p class="mt-0.5 truncate text-sm text-(--text-secondary)">
                @if (product.vendor; as v) {
                  {{ v.name }}
                } @else {
                  <span i18n="@@products.grid.vendor.none">Independent</span>
                }
              </p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              @if (product.primary_category; as cat) {
                <aec-category-chip [name]="cat.name" />
              }
              <aec-role-badge [role]="product.product_role" />
            </div>
          </a>
        </li>
      }
    </ul>
  `,
})
export class ProductCardGrid {
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

  protected readonly featured = computed<ProductListItem | null>(() =>
    this.featuredLead() ? (this.products()[0] ?? null) : null,
  );
  protected readonly rest = computed<readonly ProductListItem[]>(() =>
    this.featuredLead() ? this.products().slice(1) : this.products(),
  );
}
