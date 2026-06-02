import { HttpClient, HttpParams } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { combineLatest, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';

import type { ProductsListResponse } from '@aeci/shared';

import { MetaService } from '../core/meta.service';
import { IndexLayout } from '../layouts/index-layout';

import { Paginator } from './paginator';
import { ProductCard } from './product-card';
import { SortableColumnHeader } from './sortable-column-header';

type SortKey = 'created' | 'name' | 'updated';

const DEFAULT_PER_PAGE = 24;
const DEFAULT_SORT: SortKey = 'created';
const VALID_SORTS: ReadonlySet<SortKey> = new Set(['created', 'name', 'updated']);

function parsePage(raw: string | null): number {
  const parsed = raw === null ? 1 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function parseSort(raw: string | null): SortKey {
  if (raw && (VALID_SORTS as Set<string>).has(raw)) return raw as SortKey;
  return DEFAULT_SORT;
}

/**
 * Phase 2.12 (AECI-58) — paginated product index. Renders the catalog as a
 * sortable table inside `IndexLayout`, fetches data from the private API via
 * the service-binding-proxied `/api/products` path, and updates the URL
 * (`?page=`, `?sort=`) on every interaction so deep links and the
 * browser back/forward buttons work without extra state.
 *
 * Default sort: `created DESC` per Phase 2 Spec §7.4. The server resolves the
 * direction from the key; this page only sends a key. `perPage` is fixed at
 * 24 (Spec §7.1 example) and is hard-clamped at 100 server-side regardless.
 *
 * SSR: cached for 5 minutes at the edge with `Cache-Tag: route:index,
 * index:products` (set by the SSR Worker via `cacheTagInputsForPath`). The
 * `withHttpTransferCacheOptions` in `app.config.ts` serializes the
 * `/api/products` response into the rendered HTML so the client doesn't
 * re-fetch on hydration.
 *
 * MetaService: `entity: 'index'` (added in AECI-58) produces the title
 * `Products — AEC Integrations` and `og:type=website`.
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
        @if (data(); as response) {
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
            [currentSort]="sort()"
            label="Name"
            i18n-label="@@products.index.col.name"
            (sortChange)="onSortChange($event)"
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
        @if (data(); as response) {
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
        } @else if (error()) {
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
        @if (data(); as response) {
          <aec-paginator
            [page]="response.page"
            [perPage]="response.perPage"
            [total]="response.total"
            (pageChange)="onPageChange($event)"
          />
        }
      </ng-container>
    </aec-index-layout>
  `,
})
export class ProductsIndex implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly meta = inject(MetaService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly data = signal<ProductsListResponse | null>(null);
  protected readonly error = signal<unknown>(null);

  private readonly pageSig = signal(1);
  private readonly sortSig = signal<SortKey>(DEFAULT_SORT);

  /** Current sort key (for the column header active state). */
  protected readonly sort = computed(() => this.sortSig());

  ngOnInit(): void {
    this.meta.setEntityMeta({
      entity: 'index',
      name: $localize`:@@products.index.metaName:Products`,
      description: $localize`:@@products.index.metaDescription:The directory of every AEC software product on AEC Integrations. Sortable by name, recency, and last update.`,
      canonical: 'https://aecintegrations.com/products',
    });

    // Drive the fetch from the URL: any time `?page=` or `?sort=` changes,
    // re-fetch. Hydration: the SSR transfer cache (configured in
    // `app.config.ts:25`) serves the initial response without a second hop.
    combineLatest([this.route.queryParamMap])
      .pipe(
        tap(([params]) => {
          this.pageSig.set(parsePage(params.get('page')));
          this.sortSig.set(parseSort(params.get('sort')));
          this.error.set(null);
          this.data.set(null);
        }),
        switchMap(([params]) => {
          const httpParams = new HttpParams()
            .set('page', String(parsePage(params.get('page'))))
            .set('perPage', String(DEFAULT_PER_PAGE))
            .set('sort', parseSort(params.get('sort')));
          return this.http.get<ProductsListResponse>('/api/products', { params: httpParams }).pipe(
            catchError((err: unknown) => {
              this.error.set(err);
              return of(null);
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((response) => {
        if (response) this.data.set(response);
      });
  }

  protected onSortChange(key: string): void {
    if (!(VALID_SORTS as Set<string>).has(key)) return;
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { sort: key, page: 1 },
      queryParamsHandling: 'merge',
    });
  }

  protected onPageChange(page: number): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { page },
      queryParamsHandling: 'merge',
    });
  }
}
