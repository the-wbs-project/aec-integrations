import { Component, input } from '@angular/core';

import { ProductCard, type ProductRow } from './product-card';

/**
 * A header cell at the Label role. Exported so the `/search` Vendors table draws
 * the same header (AECI-1796).
 */
export const TABLE_HEADER_CELL_CLASS =
  'px-4 py-3 text-t-13 font-semibold tracking-[0.01em] whitespace-nowrap text-(--text-secondary)';

const TH_CLASS = TABLE_HEADER_CELL_CLASS;

/**
 * The table view of a product list: `/products`, the four taxonomy term pages
 * and the `/search` products tab (AECI-1793, mock-up 10). One table, so the
 * three cannot drift: before this each page carried its own copy of the header.
 *
 * Hairlines and no shadow or radius. A rule above the header, one under it and
 * one under each row (`tr[aec-product-card]`). The header cells are at the
 * Label role, 13px at 600, sentence case.
 *
 * The rating column is headed "Overall" (ruling 4 of 2026-11-16). It is the one
 * score lists carry, `rating_overall_avg`, and the product page names it the
 * same way. Below five reviews the cell is a dash (`aec-rating-summary`).
 *
 * The vendor and rating columns collapse below the `md` viewport breakpoint,
 * where the filter rail also collapses; the row explains why that is the
 * viewport and not a container query (`product-card.ts`).
 */
@Component({
  selector: 'aec-product-table',
  imports: [ProductCard],
  host: { class: 'block overflow-x-auto border-t' },
  template: `
    <table
      class="w-full border-collapse text-start text-t-14 md:min-w-[36rem]"
      i18n-aria-label="@@products.index.table.aria"
      aria-label="Products"
    >
      <thead>
        <tr class="border-b">
          <th scope="col" [class]="thStart" i18n="@@products.index.col.name">Name</th>
          <th
            scope="col"
            [class]="thStart + ' hidden md:table-cell'"
            i18n="@@products.index.col.vendor"
          >
            Vendor
          </th>
          <th
            scope="col"
            [class]="thEnd + ' hidden md:table-cell'"
            i18n="@@products.detail.reviews.item.overall"
          >
            Overall
          </th>
          <th scope="col" [class]="thEnd" i18n="@@products.index.col.integrations">Integrations</th>
        </tr>
      </thead>
      <tbody>
        @for (row of rows(); track row.slug) {
          <tr aec-product-card [product]="row"></tr>
        }
      </tbody>
    </table>
  `,
})
export class ProductTable {
  /** The rows, in the order the host already sorted them. */
  readonly rows = input.required<readonly ProductRow[]>();

  protected readonly thStart = `${TH_CLASS} text-start`;
  protected readonly thEnd = `${TH_CLASS} text-end`;
}
