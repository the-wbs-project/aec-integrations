import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductListItem } from '@aeci/shared';

import { RatingSummary } from '../reviews/rating-summary';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

import { IntegrationStat } from './integration-stat';

/**
 * Row representation of a `ProductListItem` — the **table view** of the
 * catalog, projected into the `<tbody>` of the `/products` table and of the
 * taxonomy browse-page tables. Uses an attribute selector on `<tr>` so the
 * rendered markup is a valid `<tr>` child of `<tbody>` (per HTML parsing rules
 * a custom element directly inside `<tbody>` would be moved out by the
 * browser's tree builder).
 *
 * Phase 2 Spec §11.2 calls this primitive `ProductCard`. The card-grid variant
 * the name anticipated shipped separately as `ProductCardGrid` (AECI-190)
 * rather than as a `variant` input here, so the two views stay independently
 * styleable; this component is the row half of that split. Its two sibling
 * primitives, `VendorCard` and `IntegrationCard`, were deleted once AECI-165
 * removed the `/vendors` and `/integrations` index pages that consumed them.
 *
 * Renders five cells: product (monogram via `LogoOrInitial` + name link),
 * vendor (linked when present, otherwise an en-dash empty state — `vendor` is
 * nullable per AECI-115), primary category (a `TaxonomyBadge` chip linking to
 * `/categories/:slug`, otherwise an en-dash), the overall rating as a
 * `RatingSummary` (`variant="cell"` — gold star + average + review count, or an
 * en-dash below the §5.5 ≥5-review gate), and the integration count as an
 * `IntegrationStat` (graceful "Not yet connected" at zero). AECI-190 folded the
 * monogram / chip / stat treatment in here so the `/products` table view and the
 * taxonomy browse-page tables share one upgraded row.
 *
 * Responsive: the vendor cell collapses below `md` — the same breakpoint at
 * which `BrowseLayout`'s filter sidebar collapses into its mobile "Filters"
 * disclosure (`facet-sidebar.ts`). So the column and the sidebar appear/vanish
 * together: at `md+` the sidebar sits beside a 4-column table; below `md` the
 * table is full-width single-column and the vendor surfaces as a muted link
 * under the product name. (A container query against the *table's* width is
 * wrong here — below `md` the full-width table is wide enough that the vendor
 * column would reappear, out of step with the collapsed sidebar.)
 */
@Component({
  // Attribute selector is required so the rendered DOM is a literal `<tr>` —
  // a custom element directly inside `<tbody>` is foster-parented out by the
  // HTML tree builder. The selector still carries the `aec-` prefix so it
  // satisfies the namespacing intent of the rule below. Same pattern Angular
  // CDK uses for `tr[cdk-row]` / `tr[mat-row]`.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-product-card]',
  imports: [RouterLink, LogoOrInitial, TaxonomyBadge, IntegrationStat, RatingSummary],
  host: {
    // `group` so the stacked-vendor sublabel can react to the row's hover /
    // focus-within state (it steps tertiary→secondary when the row fill goes
    // muted — see the vendor link below).
    class:
      'group text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <td class="px-4 py-3 font-medium">
      <span class="flex items-center gap-3">
        <aec-logo-or-initial [src]="product().logo_url" [name]="product().name" size="sm" />
        <span class="flex min-w-0 flex-col">
          <a
            [routerLink]="['/products', product().slug]"
            class="rounded-sm transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >{{ product().name }}</a
          >
          <!-- Below the md breakpoint the Vendor <td> is hidden (md:hidden here,
               hidden md:table-cell on the <td>), so the vendor surfaces here as a
               muted link under the product name. The breakpoint is the md viewport
               breakpoint (the same one the filter sidebar collapses at), not a
               container query (see the class doc above for why). Omitted when the
               product has no vendor (AECI-115); cleaner than a stray dash. -->
          @if (vendor(); as v) {
            <!-- Muted via text-tertiary AT REST (4.83:1 on the white row). The
                 row fill flips to surface-muted on hover/focus-within, where
                 tertiary would drop to 4.40:1 (below AA). DESIGN.md §"Tertiary"
                 says never on sunken/muted surfaces; step up to text secondary.
                 So group-hover / group-focus-within raise it to secondary (7:1
                 on muted). Direct link hover/focus keeps the accent. -->
            <a
              [routerLink]="['/vendors', v.slug]"
              class="mt-0.5 truncate rounded-sm text-xs text-(--text-tertiary) transition-colors group-hover:text-(--text-secondary) group-focus-within:text-(--text-secondary) hover:text-(--accent-primary) focus-visible:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) md:hidden"
              >{{ v.name }}</a
            >
          }
        </span>
      </span>
    </td>
    <td class="hidden px-4 py-3 text-(--text-secondary) md:table-cell">
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
    <!-- Rating column collapses below md alongside the Vendor column (same
         breakpoint as BrowseLayout's filter sidebar); the card-grid view carries
         the rating on small screens. The cell variant keeps the cell populated
         with an en-dash when the §5.5 gate withholds the average. -->
    <td class="hidden px-4 py-3 text-end md:table-cell">
      <aec-rating-summary
        variant="cell"
        [ratingOverall]="product().rating_overall_avg"
        [reviewCount]="product().review_count"
      />
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
