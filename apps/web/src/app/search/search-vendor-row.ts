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
    // `border-b`: the hairline under each row, as on `tr[aec-product-card]`. The
    // colour is the `@layer base` default, `--border-default`.
    class:
      'border-b text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-within:bg-(--surface-muted)',
  },
  template: `
    <td class="px-4 py-3 align-middle font-semibold">
      <span class="flex min-w-0 items-center gap-3">
        <aec-logo-or-initial
          [claimStatus]="'server-filtered'"
          [src]="record().logo_url"
          [name]="record().company_name"
          size="sm"
        />
        <span class="flex min-w-0 flex-col">
          <a
            [routerLink]="['/vendors', record().slug]"
            class="inline-block min-h-6 rounded-mark leading-6 text-(--text-primary) transition-colors hover:text-(--accent-primary) hover:underline hover:underline-offset-3 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
            >{{ record().company_name }}</a
          >
          <!-- Below md the Headquarters cell is hidden, so the value sits here,
               13px secondary like the product row's stacked vendor. Secondary
               holds AA on the white row and on the muted hover fill alike. -->
          @if (record().headquarters; as hq) {
            <span
              class="truncate text-t-13 leading-6 font-normal text-(--text-secondary) md:hidden"
              >{{ hq }}</span
            >
          }
        </span>
      </span>
    </td>
    <td class="hidden px-4 py-3 align-middle text-(--text-secondary) md:table-cell">
      @if (record().headquarters; as hq) {
        {{ hq }}
      } @else {
        <!-- The dash is for the eye. The words are for a screen reader: an
             aria-label on a plain span is not reliably read (rating-summary.ts). -->
        <span aria-hidden="true" i18n="@@search.vendorRow.hq.none">–</span>
        <span class="sr-only" i18n="@@search.vendorRow.hq.noneLabel">No headquarters listed</span>
      }
    </td>
    <td class="px-4 py-3 text-end align-middle">
      <aec-integration-stat [count]="record().integration_count" variant="inline" />
    </td>
  `,
})
export class SearchVendorRow {
  readonly record = input.required<AlgoliaVendorRecord>();
}
