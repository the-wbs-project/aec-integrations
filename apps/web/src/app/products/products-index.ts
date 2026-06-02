import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductsListResponse } from '@aeci/shared';

import { IndexLayout } from '../layouts/index-layout';
import { createPaginatedIndex } from '../shared/paginated-index/paginated-index-controller';

import { Paginator } from './paginator';
import { ProductCard } from './product-card';
import { SortableColumnHeader } from './sortable-column-header';

/**
 * Phase 2.12 (AECI-58) paginated product index. Renders the catalog as a
 * sortable table inside `IndexLayout`. The fetch/sort/pagination/error pipeline
 * lives in the shared `createPaginatedIndex` controller (AECI-107); this
 * component supplies only the API path, response type, sort config, SEO meta,
 * and the per-entity template (column headers, row card, and `@@products.*`
 * i18n ids).
 *
 * Default sort: `created DESC` per Phase 2 Spec section 7.4. `perPage` is fixed
 * at 24 (Spec section 7.1) and hard-clamped at 100 server-side.
 *
 * SSR: cached for 5 minutes at the edge with `Cache-Tag: route:index,
 * index:products` (set by the SSR Worker via `cacheTagInputsForPath`). The
 * `withHttpTransferCacheOptions` in `app.config.ts` serializes the
 * `/api/products` response into the rendered HTML so the client doesn't
 * re-fetch on hydration.
 */
@Component({
  selector: 'app-products-index',
  imports: [IndexLayout, ProductCard, SortableColumnHeader, Paginator, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aec-index-layout>
      <div slot="header" class="space-y-3">
        <nav i18n-aria-label="@@products.index.breadcrumbs.aria" aria-label="Breadcrumb">
          <ol
            class="flex items-center gap-2 text-xs tracking-wide uppercase text-(--text-secondary)"
          >
            <li>
              <a
                routerLink="/"
                class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@products.index.breadcrumbs.home"
                >Home</a
              >
            </li>
            <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
            <li
              class="text-(--text-primary)"
              aria-current="page"
              i18n="@@products.index.breadcrumbs.current"
            >
              Products
            </li>
          </ol>
        </nav>
        <h1
          class="font-display text-4xl font-semibold tracking-tight md:text-5xl"
          i18n="@@products.index.title"
        >
          Products
        </h1>
        @if (idx.data(); as response) {
          <p class="text-(--text-secondary)" i18n="@@products.index.lede">
            Every AEC software product indexed on AEC Integrations ({{ response.total }} in total).
          </p>
        } @else {
          <p class="text-(--text-secondary)" i18n="@@products.index.lede.loading">
            Every AEC software product indexed on AEC Integrations.
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
            i18n-label="@@products.index.col.name"
            (sortChange)="idx.onSortChange($event)"
          />
          <th
            scope="col"
            class="px-4 py-3 text-xs font-medium tracking-wide uppercase text-(--text-secondary)"
            i18n="@@products.index.col.vendor"
          >
            Vendor
          </th>
          <th
            scope="col"
            class="px-4 py-3 text-xs font-medium tracking-wide uppercase text-(--text-secondary)"
            i18n="@@products.index.col.category"
          >
            Primary category
          </th>
          <th
            scope="col"
            class="px-4 py-3 text-right text-xs font-medium tracking-wide uppercase text-(--text-secondary)"
            i18n="@@products.index.col.integrations"
          >
            Integrations
          </th>
        </tr>
      </ng-container>

      <ng-container slot="table-body">
        @if (idx.data(); as response) {
          @for (product of response.data; track product.id) {
            <tr aec-product-card [product]="product"></tr>
          } @empty {
            <tr>
              <td
                colspan="4"
                class="px-4 py-12 text-center text-(--text-secondary)"
                i18n="@@products.index.empty"
              >
                No products yet. Check back soon.
              </td>
            </tr>
          }
        } @else if (idx.error()) {
          <tr>
            <td
              colspan="4"
              class="px-4 py-12 text-center text-(--text-secondary)"
              i18n="@@products.index.error"
            >
              Couldn't load products. Refresh to try again.
            </td>
          </tr>
        } @else {
          <tr aria-busy="true">
            <td
              colspan="4"
              class="px-4 py-12 text-center text-(--text-tertiary)"
              i18n="@@products.index.loading"
            >
              Loading products…
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
export class ProductsIndex {
  protected readonly idx = createPaginatedIndex<ProductsListResponse>({
    apiPath: '/api/products',
    validSorts: new Set(['created', 'name', 'updated']),
    defaultSort: 'created',
    meta: {
      entity: 'index',
      name: $localize`:@@products.index.metaName:Products`,
      description: $localize`:@@products.index.metaDescription:The directory of every AEC software product on AEC Integrations. Sortable by name, recency, and last update.`,
      canonical: 'https://aecintegrations.com/products',
    },
  });
}
