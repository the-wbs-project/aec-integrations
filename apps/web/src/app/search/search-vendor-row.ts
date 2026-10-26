import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AlgoliaVendorRecord } from '@aeci/shared/algolia-records';

import { IntegrationStat } from '../products/integration-stat';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * Table-view row for a `vendors` search result, the vendor counterpart of the
 * `/products` table row (`tr[aec-product-card]`). Same cell rhythm, hover fill
 * and `md` collapse: the vendor (logo or initial + linked name), headquarters,
 * then the integration count. Below `md` the headquarters cell hides and the
 * value moves under the name, as the product row does with its vendor.
 *
 * Attribute selector on `<tr>`, for the reason given on `ProductCard`: a custom
 * element directly inside `<tbody>` is moved out by the HTML tree builder.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'tr[aec-search-vendor-row]',
  imports: [RouterLink, IntegrationStat, LogoOrInitial],
  host: {
    class:
      'group text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <td class="px-4 py-3 font-medium">
      <span class="flex items-center gap-3">
        <aec-logo-or-initial [src]="record().logo_url" [name]="record().company_name" size="sm" />
        <span class="flex min-w-0 flex-col">
          <a
            [routerLink]="['/vendors', record().slug]"
            class="rounded-sm transition-colors hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >{{ record().company_name }}</a
          >
          <!-- Below md the Headquarters cell is hidden, so the value sits here.
               Tertiary at rest, secondary on the muted hover fill (AA), as on
               the product row's stacked vendor. -->
          @if (record().headquarters; as hq) {
            <span
              class="mt-0.5 truncate text-xs text-(--text-tertiary) group-hover:text-(--text-secondary) group-focus-within:text-(--text-secondary) md:hidden"
              >{{ hq }}</span
            >
          }
        </span>
      </span>
    </td>
    <td class="hidden px-4 py-3 text-(--text-secondary) md:table-cell">
      @if (record().headquarters; as hq) {
        {{ hq }}
      } @else {
        <span i18n="@@search.vendorRow.hq.none" aria-label="No headquarters listed">–</span>
      }
    </td>
    <td class="px-4 py-3 text-end">
      <aec-integration-stat [count]="record().integration_count" variant="inline" />
    </td>
  `,
})
export class SearchVendorRow {
  readonly record = input.required<AlgoliaVendorRecord>();
}
