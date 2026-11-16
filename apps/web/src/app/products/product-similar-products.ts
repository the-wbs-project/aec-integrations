import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ProductListItem } from '@aeci/shared';

import { ProductCardGrid, type ProductCardGridColumns } from './product-card-grid';

/**
 * AECI-1785: "Similar products", the last section of the product page body
 * (mock-up 6, `PLAN.md` §5.2 row 10). It renders `related_products` as it comes
 * from the API: up to six products that share a category with this one, A to Z by
 * name with id breaking a tie (ruling R1 on AECI-1732; the order lives in
 * `relatedProductsQuery`, `apps/api/src/routes/products.ts`). The section adds no
 * sort, filter or cut of its own. The on-page ordering firewall holds it to that
 * (`[surface:product-page-similar-products]`).
 *
 * Cards are the `/products` card grid with no lead card: every card is the same
 * size and none is featured. Logos are server-filtered, so an unclaimed product
 * shows its initial tile.
 *
 * Layout by count, so a short list does not leave a blank right half where the grid
 * can avoid it. One card sits beside the heading from `md`. Two or four cards take
 * two columns at `lg`, so the rows are full. Three, five and six keep the grid's
 * three columns. Every row is the same height, so every card is the same size.
 *
 * Attribute selector on the page's `<section id="similar">`, like the extensions
 * section, so the anchor and the labelled region stay on the element the section nav
 * links to. The page mounts it only when the list is non-empty.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'section[aec-product-similar-products]',
  imports: [ProductCardGrid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class]': 'layoutClass()',
    '[attr.data-count]': 'products().length',
  },
  template: `
    <div class="space-y-2">
      <h2
        id="similar-title"
        class="font-display text-2xl font-semibold text-(--text-primary)"
        i18n="@@products.detail.similar.heading"
      >
        Similar products
      </h2>
      <p class="max-w-prose text-(--text-secondary)" i18n="@@products.detail.similar.intro">
        Products that share a category with {{ productName() }}.
      </p>
      <p
        class="text-sm text-(--text-secondary)"
        data-testid="similar-products-order"
        i18n="@@products.detail.similar.order"
      >
        A to Z by name.
      </p>
    </div>
    <aec-product-card-grid
      data-testid="similar-products"
      [products]="products()"
      [featuredLead]="false"
      [columns]="columns()"
    />
  `,
})
export class ProductSimilarProducts {
  readonly productName = input.required<string>();
  readonly products = input.required<readonly ProductListItem[]>();

  protected readonly columns = computed<ProductCardGridColumns>(() => {
    const n = this.products().length;
    if (n === 1) return 1;
    if (n === 2 || n === 4) return 2;
    return 3;
  });

  protected readonly layoutClass = computed(() =>
    this.products().length === 1
      ? 'grid scroll-mt-20 gap-6 md:grid-cols-2 md:items-start md:gap-12'
      : 'grid scroll-mt-20 gap-6',
  );
}
