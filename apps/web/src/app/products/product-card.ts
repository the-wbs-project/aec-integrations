import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductListItem } from '@aeci/shared';

import { RatingSummary } from '../reviews/rating-summary';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

import { IntegrationStat } from './integration-stat';

/**
 * The fields the row reads. A `ProductListItem` satisfies it, and so does a
 * `/search` Algolia record mapped by `searchProductRow`, which is how the
 * `/search` table view renders the very same row.
 */
export type ProductRow = Pick<
  ProductListItem,
  'slug' | 'name' | 'logo_url' | 'integration_count' | 'review_count' | 'rating_overall_avg'
> & { readonly vendor: { readonly name: string; readonly slug: string } | null };

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
 * Renders four cells: product (monogram via `LogoOrInitial` + name link),
 * vendor (linked when present, otherwise an en-dash empty state — `vendor` is
 * nullable per AECI-115), the overall rating as a `RatingSummary`
 * (`variant="cell"` — gold star + average + review count, or an en-dash below
 * the §5.5 ≥5-review gate), and the integration count as an `IntegrationStat`
 * (graceful "Not yet connected" at zero). AECI-190 folded the monogram / stat
 * treatment in here so the `/products` table view and the taxonomy browse-page
 * tables share one upgraded row. The row carries no category: a product can sit
 * in several categories, and no one of them is its "main" one.
 *
 * Responsive: the vendor and rating cells collapse below `md` — the same
 * breakpoint at which `BrowseLayout`'s filter sidebar collapses into its mobile
 * "Filters" disclosure (`facet-sidebar.ts`). So the columns and the sidebar
 * appear/vanish together: at `md+` the sidebar sits beside a 4-column table;
 * below `md` the table is full-width with two columns (product, integrations)
 * and the vendor surfaces as a muted link under the product name. (A container
 * query against the *table's* width is wrong here — below `md` the full-width
 * table is wide enough that the vendor column would reappear, out of step with
 * the collapsed sidebar.)
 */
@Component({
  // Attribute selector is required so the rendered DOM is a literal `<tr>` —
  // a custom element directly inside `<tbody>` is foster-parented out by the
  // HTML tree builder. The selector still carries the `aec-` prefix so it
  // satisfies the namespacing intent of the rule below. Same pattern Angular
  // CDK uses for `tr[cdk-row]` / `tr[mat-row]`.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-product-card]',
  imports: [RouterLink, LogoOrInitial, IntegrationStat, RatingSummary],
  host: {
    // `border-b`: the hairline under each row (AECI-1793). The colour is the
    // `@layer base` default, `--border-default`.
    class:
      'border-b text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <td class="px-4 py-3 align-middle font-semibold">
      <span class="flex min-w-0 items-center gap-3">
        <aec-logo-or-initial
          [claimStatus]="'server-filtered'"
          [src]="product().logo_url"
          [name]="product().name"
          size="sm"
        />
        <span class="flex min-w-0 flex-col">
          <a
            [routerLink]="['/products', product().slug]"
            class="inline-block min-h-6 rounded-mark leading-6 text-(--text-primary) transition-colors hover:text-(--accent-primary) hover:underline hover:underline-offset-3 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
            >{{ product().name }}</a
          >
          <!-- Below the md breakpoint the Vendor <td> is hidden (md:hidden here,
               hidden md:table-cell on the <td>), so the vendor surfaces here as a
               muted link under the product name. The breakpoint is the md viewport
               breakpoint (the same one the filter sidebar collapses at), not a
               container query (see the class doc above for why). Omitted when the
               product has no vendor (AECI-115); cleaner than a stray dash. -->
          @if (vendor(); as v) {
            <!-- Text secondary at 13px (mock-up 10), which holds AA on the white
                 row and on the muted hover fill alike. A 24px line box, like the
                 name link above it, so the two stacked targets each meet the
                 24px minimum (WCAG 2.5.8). -->
            <a
              [routerLink]="['/vendors', v.slug]"
              class="min-h-6 w-fit truncate rounded-mark text-t-13 leading-6 font-normal text-(--text-secondary) transition-colors hover:text-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary) md:hidden"
              >{{ v.name }}</a
            >
          }
        </span>
      </span>
    </td>
    <td class="hidden px-4 py-3 align-middle text-(--text-secondary) md:table-cell">
      @if (vendor(); as v) {
        <a
          [routerLink]="['/vendors', v.slug]"
          class="rounded-mark text-(--text-secondary) transition-colors hover:text-(--accent-primary) hover:underline hover:underline-offset-3 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
          >{{ v.name }}</a
        >
      } @else {
        <span aria-hidden="true" i18n="@@products.card.vendor.none">–</span>
        <span class="sr-only" i18n="@@products.detail.vendor.none">No vendor listed</span>
      }
    </td>
    <!-- Rating column collapses below md alongside the Vendor column (same
         breakpoint as BrowseLayout's filter sidebar); the card-grid view carries
         the rating on small screens. The cell variant keeps the cell populated
         with an en-dash when the §5.5 gate withholds the average. -->
    <td class="hidden px-4 py-3 text-end align-middle md:table-cell">
      <aec-rating-summary
        variant="cell"
        [ratingOverall]="product().rating_overall_avg"
        [reviewCount]="product().review_count"
      />
    </td>
    <td class="px-4 py-3 text-end align-middle">
      <aec-integration-stat [count]="product().integration_count" variant="inline" />
    </td>
  `,
})
export class ProductCard {
  readonly product = input.required<ProductRow>();

  protected readonly vendor = computed(() => this.product().vendor);
}
