import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductListItem } from '@aeci/shared';

import { IntegrationStat } from '../products/integration-stat';
import { RatingSummary } from '../reviews/rating-summary';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * Row representation of one of a vendor's products, slotted into the products
 * `<table>` on the vendor-detail page (`vendor-detail.ts`). Mirrors the
 * integrations `<table>` on the product-detail page
 * (`product-integration-row.ts`): replaces the former stack of near-identical
 * product cards with a real, column-aligned table row so a vendor's portfolio
 * scans like an editorial table instead of a wall of cards.
 *
 * Uses an attribute selector on `<tr>` so the rendered markup is a valid `<tr>`
 * child of `<tbody>` — a custom element directly inside `<tbody>` is
 * foster-parented out by the browser's HTML tree builder (same pattern as
 * `ProductCard` / `ProductIntegrationRow` / Angular CDK's `tr[cdk-row]`).
 *
 * Columns (+ a trailing affordance) reuse the same leaf primitives as the
 * `/products` browse table (`ProductCard`) so the treatments stay in sync:
 *   1. **Product** — monogram (`LogoOrInitial`) + name. Always visible. Below
 *      `md` the Category / Rating columns collapse and the primary category
 *      surfaces here as a muted sublabel (mirrors `ProductCard`'s vendor
 *      sublabel + the integrations row's mechanism sublabel at the same
 *      breakpoint).
 *   2. **Category** — the primary category as a linked `TaxonomyBadge`
 *      (`/categories/:slug`). Hidden below `md`. `–` when absent.
 *   3. **Rating** — `RatingSummary` (`variant="cell"`): a single gold star +
 *      average + review count, or an en-dash below the §5.5 ≥5-review gate.
 *      Hidden below `md`.
 *   4. **Integrations** — `IntegrationStat` (`variant="inline"`): the directory's
 *      headline metric, with a graceful "Not yet connected" at zero. Always
 *      visible.
 *
 * Row click → the product page `/products/:slug`. To keep the whole row
 * clickable *and* still expose a distinct link to the category without nesting
 * `<a>`s, it uses the accessible stretched-link pattern (same as
 * `ProductIntegrationRow`): an `absolute inset-0` overlay against the `relative`
 * `<tr>` host carries the product link, and the category badge sits on top
 * (`relative z-10`) so its own activation wins. Two sibling links, zero nesting.
 */
@Component({
  // Attribute selector so the rendered DOM is a literal `<tr>` (see class doc).
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-vendor-product-row]',
  imports: [RouterLink, LogoOrInitial, TaxonomyBadge, RatingSummary, IntegrationStat],
  host: {
    // `relative` anchors the stretched product-page overlay to the whole row.
    // `group` lets the below-`md` category sublabel step tertiary→secondary
    // when the row fill goes muted on hover / focus-within.
    class:
      'group relative text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <!-- No "relative" on this cell: the product overlay below must anchor to the
         relative <tr> host (see class doc), not this cell, so it spans the whole
         row. A relative <td> would intercept inset-0 (as the nearest positioned
         ancestor) and shrink the click target to this cell alone. -->
    <td class="px-4 py-3 font-medium">
      <span class="flex items-center gap-3">
        <aec-logo-or-initial [src]="product().logo_url" [name]="product().name" size="sm" />
        <span class="flex min-w-0 flex-col">
          <span class="break-words">{{ product().name }}</span>
          <!-- Below md the Category <td> is hidden, so the primary category
               surfaces here as a muted sublabel. Tertiary at rest (4.83:1 on
               white); group-hover / group-focus-within step it to secondary once
               the row fill goes muted (DESIGN.md §"Tertiary": never on muted). -->
          @if (primaryCategory(); as cat) {
            <span
              class="mt-0.5 text-xs text-(--text-tertiary) transition-colors group-hover:text-(--text-secondary) group-focus-within:text-(--text-secondary) md:hidden"
              >{{ cat.name }}</span
            >
          }
        </span>
      </span>
      <!-- Stretched overlay: the whole row navigates to the product page.
           Absolute against the relative tr host, so it covers every cell;
           kept below the category badge (which is z-10) so that link stays live. -->
      <a
        [routerLink]="['/products', product().slug]"
        [attr.aria-label]="rowAriaLabel()"
        class="absolute inset-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
      ></a>
    </td>
    <td class="hidden px-4 py-3 text-(--text-secondary) md:table-cell">
      @if (primaryCategory(); as cat) {
        <!-- relative z-10 lifts the category link above the stretched row overlay
             so its own click (→ /categories/:slug) wins. -->
        <span class="relative z-10 inline-flex">
          <aec-taxonomy-badge kind="category" [slug]="cat.slug" [name]="cat.name" />
        </span>
      } @else {
        <span
          class="text-(--text-secondary)"
          i18n="@@vendors.detail.products.category.none"
          i18n-aria-label="@@vendors.detail.products.category.none.aria"
          aria-label="No primary category"
          >–</span
        >
      }
    </td>
    <!-- Rating column collapses below md alongside the Category column; the cell
         variant keeps the cell populated with an en-dash when the §5.5 gate
         withholds the average. -->
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
    <td class="px-4 py-3 text-end align-middle">
      <span class="text-(--text-tertiary) inline-block rtl:-scale-x-100" aria-hidden="true">→</span>
    </td>
  `,
})
export class VendorProductRow {
  /** The product to render as a row. */
  readonly product = input.required<ProductListItem>();

  protected readonly primaryCategory = computed(() => this.product().primary_category);

  // Built in TS (not an interpolated i18n-aria-label, which emits no attribute)
  // so the stretched overlay link has a real accessible name naming the product.
  protected readonly rowAriaLabel = computed(
    () => $localize`:@@vendors.detail.products.row.aria:View ${this.product().name}:PRODUCT:`,
  );
}
