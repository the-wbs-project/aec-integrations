import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductListItem } from '@aeci/shared';

import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

import { IntegrationStat } from './integration-stat';

/**
 * Row representation of a `ProductListItem`, slotted into `IndexLayout`'s
 * `table-body` slot. Uses an attribute selector on `<tr>` so the rendered
 * markup is a valid `<tr>` child of `<tbody>` (per HTML parsing rules a
 * custom element directly inside `<tbody>` would be moved out by the
 * browser's tree builder).
 *
 * Phase 2 Spec §11.2 calls this primitive `ProductCard` — the "card"
 * vocabulary is shared with the eventual card-grid variant that browse
 * pages (AECI-59+) will need; for now the only consumer is `/products`
 * (a table). When the first card-grid consumer lands, either add a
 * `variant: 'row' | 'card'` input or split into `ProductRow` +
 * `ProductCardTile`. Keeping it local to `apps/web/src/app/products/`
 * until then per CLAUDE.md "Three similar lines is better than a
 * premature abstraction."
 *
 * Renders four cells: product (monogram via `LogoOrInitial` + name link),
 * vendor (linked when present, otherwise an en-dash empty state — `vendor` is
 * nullable per AECI-115), primary category (a `TaxonomyBadge` chip linking to
 * `/categories/:slug`, otherwise an en-dash), and the integration count as an
 * `IntegrationStat` (graceful "Not yet connected" at zero). AECI-190 folded the
 * monogram / chip / stat treatment in here so the `/products` table view and the
 * taxonomy browse-page tables share one upgraded row.
 */
@Component({
  // Attribute selector is required so the rendered DOM is a literal `<tr>` —
  // a custom element directly inside `<tbody>` is foster-parented out by the
  // HTML tree builder. The selector still carries the `aec-` prefix so it
  // satisfies the namespacing intent of the rule below. Same pattern Angular
  // CDK uses for `tr[cdk-row]` / `tr[mat-row]`.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-product-card]',
  imports: [RouterLink, LogoOrInitial, TaxonomyBadge, IntegrationStat],
  host: {
    class:
      'text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <td class="px-4 py-3 font-medium">
      <span class="flex items-center gap-3">
        <aec-logo-or-initial [src]="product().logo_url" [name]="product().name" size="sm" />
        <a
          [routerLink]="['/products', product().slug]"
          class="rounded-sm transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          >{{ product().name }}</a
        >
      </span>
    </td>
    <td class="px-4 py-3 text-(--text-secondary)">
      @if (vendor(); as v) {
        <a
          [routerLink]="['/vendors', v.slug]"
          class="rounded-sm transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          >{{ v.name }}</a
        >
      } @else {
        <span
          class="text-(--text-secondary)"
          i18n="@@products.card.vendor.none"
          aria-label="No vendor listed"
          >–</span
        >
      }
    </td>
    <td class="px-4 py-3 text-(--text-secondary)">
      @if (primaryCategory(); as cat) {
        <aec-taxonomy-badge kind="category" [slug]="cat.slug" [name]="cat.name" />
      } @else {
        <span
          class="text-(--text-secondary)"
          i18n="@@products.card.category.none"
          aria-label="No primary category"
          >–</span
        >
      }
    </td>
    <td class="px-4 py-3 text-end">
      <aec-integration-stat [count]="product().integration_count" variant="inline" />
    </td>
  `,
})
export class ProductCard {
  readonly product = input.required<ProductListItem>();

  protected readonly vendor = computed(() => this.product().vendor);
  protected readonly primaryCategory = computed(() => this.product().primary_category);
}
