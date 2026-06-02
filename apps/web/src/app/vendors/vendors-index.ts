import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { VendorsListResponse } from '@aeci/shared';

import { IndexLayout } from '../layouts/index-layout';
import { Paginator } from '../products/paginator';
import { SortableColumnHeader } from '../products/sortable-column-header';
import { createPaginatedIndex } from '../shared/paginated-index/paginated-index-controller';

import { VendorCard } from './vendor-card';

/**
 * Phase 2.13 (AECI-59) paginated vendor index. Renders the directory as a
 * sortable table inside `IndexLayout`. The fetch/sort/pagination/error pipeline
 * lives in the shared `createPaginatedIndex` controller (AECI-107); this
 * component supplies only the API path, response type, sort config, SEO meta,
 * and the per-entity template (column headers, row card, and `@@vendors.*`
 * i18n ids).
 *
 * Default sort: `created DESC` per Phase 2 Spec section 7.4. `perPage` is fixed
 * at 24 (Spec section 7.1) and hard-clamped at 100 server-side.
 *
 * SSR: cached for 5 minutes at the edge with `Cache-Tag: route:index,
 * index:vendors` (set by the SSR Worker via `cacheTagInputsForPath`). The
 * `withHttpTransferCacheOptions` in `app.config.ts` serializes the
 * `/api/vendors` response into the rendered HTML so the client doesn't
 * re-fetch on hydration.
 */
@Component({
  selector: 'app-vendors-index',
  imports: [IndexLayout, VendorCard, SortableColumnHeader, Paginator, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aec-index-layout>
      <div slot="header" class="space-y-3">
        <nav i18n-aria-label="@@vendors.index.breadcrumbs.aria" aria-label="Breadcrumb">
          <ol
            class="flex items-center gap-2 text-xs tracking-wide uppercase text-(--text-secondary)"
          >
            <li>
              <a
                routerLink="/"
                class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@vendors.index.breadcrumbs.home"
                >Home</a
              >
            </li>
            <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
            <li
              class="text-(--text-primary)"
              aria-current="page"
              i18n="@@vendors.index.breadcrumbs.current"
            >
              Vendors
            </li>
          </ol>
        </nav>
        <h1
          class="font-display text-4xl font-semibold tracking-tight md:text-5xl"
          i18n="@@vendors.index.title"
        >
          Vendors
        </h1>
        @if (idx.data(); as response) {
          <p class="text-(--text-secondary)" i18n="@@vendors.index.lede">
            Every AEC software vendor indexed on AEC Integrations ({{ response.total }} in total).
          </p>
        } @else {
          <p class="text-(--text-secondary)" i18n="@@vendors.index.lede.loading">
            Every AEC software vendor indexed on AEC Integrations.
          </p>
        }
      </div>

      <ng-container slot="table-header">
        <tr>
          <aec-sortable-column-header
            key="name"
            direction="ascending"
            [currentSort]="idx.sort()"
            label="Name"
            i18n-label="@@vendors.index.col.name"
            (sortChange)="idx.onSortChange($event)"
          />
          <th
            scope="col"
            class="px-4 py-3 text-xs font-medium tracking-wide uppercase text-(--text-secondary)"
            i18n="@@vendors.index.col.hq"
          >
            HQ
          </th>
          <th
            scope="col"
            class="px-4 py-3 text-xs font-medium tracking-wide uppercase text-(--text-secondary)"
            i18n="@@vendors.index.col.founded"
          >
            Founded
          </th>
          <th
            scope="col"
            class="px-4 py-3 text-right text-xs font-medium tracking-wide uppercase text-(--text-secondary)"
            i18n="@@vendors.index.col.products"
          >
            Products
          </th>
        </tr>
      </ng-container>

      <ng-container slot="table-body">
        @if (idx.data(); as response) {
          @for (vendor of response.data; track vendor.id) {
            <tr aec-vendor-card [vendor]="vendor"></tr>
          } @empty {
            <tr>
              <td
                colspan="4"
                class="px-4 py-12 text-center text-(--text-secondary)"
                i18n="@@vendors.index.empty"
              >
                No vendors yet. Check back soon.
              </td>
            </tr>
          }
        } @else if (idx.error()) {
          <tr>
            <td
              colspan="4"
              class="px-4 py-12 text-center text-(--text-secondary)"
              i18n="@@vendors.index.error"
            >
              Couldn't load vendors. Refresh to try again.
            </td>
          </tr>
        } @else {
          <tr aria-busy="true">
            <td
              colspan="4"
              class="px-4 py-12 text-center text-(--text-tertiary)"
              i18n="@@vendors.index.loading"
            >
              Loading vendors…
            </td>
          </tr>
        }
      </ng-container>

      <ng-container slot="pagination">
        @if (idx.data(); as response) {
          <aec-paginator
            [page]="response.page"
            [perPage]="response.perPage"
            [total]="response.total"
            (pageChange)="idx.onPageChange($event)"
          />
        }
      </ng-container>
    </aec-index-layout>
  `,
})
export class VendorsIndex {
  protected readonly idx = createPaginatedIndex<VendorsListResponse>({
    apiPath: '/api/vendors',
    validSorts: new Set(['created', 'name', 'updated']),
    defaultSort: 'created',
    meta: {
      entity: 'index',
      name: $localize`:@@vendors.index.metaName:Vendors`,
      description: $localize`:@@vendors.index.metaDescription:The directory of every AEC software vendor on AEC Integrations. Sortable by name, recency, and last update.`,
      canonical: 'https://aecintegrations.com/vendors',
    },
  });
}
