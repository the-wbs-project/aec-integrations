import { Component, ElementRef, computed, input, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductListItem } from '@aeci/shared';

import { IntegrationStat } from '../products/integration-stat';
import { RatingSummary } from '../reviews/rating-summary';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { forwardRowClick } from '../shared/row-link/row-link-click';

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
 *   1. **Product** — monogram (`LogoOrInitial`) + name. Always visible.
 *   2. **Rating** — `RatingSummary` (`variant="cell"`): a single gold star +
 *      average + review count, or an en-dash below the §5.5 ≥5-review gate.
 *      Hidden below `md`.
 *   3. **Integrations** — `IntegrationStat` (`variant="inline"`): the directory's
 *      headline metric, with a graceful "Not yet connected" at zero. Always
 *      visible.
 *
 * The row carries no category: a product can sit in several categories, and no
 * one of them is its "main" one.
 *
 * Row click → the product page `/products/:slug`. The product link is the
 * trailing arrow (a real `<a>` with its own accessible name), and a click
 * anywhere else on the row is forwarded to it by `forwardRowClick` (same as
 * `ProductIntegrationRow`). This is not a stretched overlay link, because Safari
 * before 27 cannot anchor one to a `<tr>` (see `shared/row-link/row-link-click.ts`).
 */
@Component({
  // Attribute selector so the rendered DOM is a literal `<tr>` (see class doc).
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-vendor-product-row]',
  imports: [RouterLink, LogoOrInitial, RatingSummary, IntegrationStat],
  host: {
    // No `relative`: a <tr> cannot anchor positioned children in Safari < 27
    // (see class doc). The row click is forwarded to the trailing link instead.
    class:
      'cursor-pointer text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
    '(click)': 'onRowClick($event)',
  },
  template: `
    <td class="px-4 py-3 font-medium">
      <span class="flex items-center gap-3">
        <aec-logo-or-initial [src]="product().logo_url" [name]="product().name" size="sm" />
        <span class="min-w-0 break-words">{{ product().name }}</span>
      </span>
    </td>
    <!-- Rating column collapses below md; the cell variant keeps the cell
         populated with an en-dash when the §5.5 gate withholds the average. -->
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
      <!-- The row's product link. The <a> carries the accessible name, so the
           glyph is aria-hidden. size-6 keeps the target at 24px (WCAG 2.2
           SC 2.5.8). A click anywhere else on the row is forwarded here. -->
      <a
        #rowLink
        [routerLink]="['/products', product().slug]"
        [attr.aria-label]="rowAriaLabel()"
        class="inline-flex size-6 items-center justify-center rounded-sm align-middle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      >
        <span class="text-(--text-tertiary) inline-block rtl:-scale-x-100" aria-hidden="true"
          >→</span
        >
      </a>
    </td>
  `,
})
export class VendorProductRow {
  /** The product to render as a row. */
  readonly product = input.required<ProductListItem>();

  /** The product link in the trailing cell; row clicks are forwarded to it. */
  private readonly rowLink = viewChild<ElementRef<HTMLAnchorElement>>('rowLink');

  protected onRowClick(event: MouseEvent): void {
    forwardRowClick(event, this.rowLink()?.nativeElement);
  }

  // Built in TS (not an interpolated i18n-aria-label, which emits no attribute)
  // so the row link has a real accessible name naming the product.
  protected readonly rowAriaLabel = computed(
    () => $localize`:@@vendors.detail.products.row.aria:View ${this.product().name}:PRODUCT:`,
  );
}
