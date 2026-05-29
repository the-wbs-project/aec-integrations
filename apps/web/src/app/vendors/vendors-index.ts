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

import type { VendorsListResponse } from '@aeci/shared';

import { MetaService } from '../core/meta.service';
import { IndexLayout } from '../layouts/index-layout';
import { Paginator } from '../products/paginator';
import { SortableColumnHeader } from '../products/sortable-column-header';

import { VendorCard } from './vendor-card';

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
 * Phase 2.13 (AECI-59) — paginated vendor index. Renders the directory as a
 * sortable table inside `IndexLayout`, fetches data from the private API
 * via the service-binding-proxied `/api/vendors` path, and updates the URL
 * (`?page=`, `?sort=`) on every interaction so deep links and the browser
 * back/forward buttons work without extra state.
 *
 * Default sort: `created DESC` per Phase 2 Spec §7.4. The server resolves
 * the direction from the key; this page only sends a key. `perPage` is
 * fixed at 24 (Spec §7.1 example) and is hard-clamped at 100 server-side.
 *
 * SSR: cached for 5 minutes at the edge with `Cache-Tag: route:index,
 * index:vendors` (set by the SSR Worker via `cacheTagInputsForPath`). The
 * `withHttpTransferCacheOptions` in `app.config.ts` serializes the
 * `/api/vendors` response into the rendered HTML so the client doesn't
 * re-fetch on hydration.
 *
 * MetaService: `entity: 'index'` produces the title `Vendors — AEC
 * Integrations` and `og:type=website`.
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
        @if (data(); as response) {
          <p class="text-(--text-secondary)" i18n="@@vendors.index.lede">
            Every AEC software vendor indexed on AEC Integrations — {{ response.total }} in total.
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
            [currentSort]="sort()"
            label="Name"
            i18n-label="@@vendors.index.col.name"
            (sortChange)="onSortChange($event)"
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
        @if (data(); as response) {
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
        } @else if (error()) {
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
export class VendorsIndex implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly meta = inject(MetaService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly data = signal<VendorsListResponse | null>(null);
  protected readonly error = signal<unknown>(null);

  private readonly pageSig = signal(1);
  private readonly sortSig = signal<SortKey>(DEFAULT_SORT);

  /** Current sort key (for the column header active state). */
  protected readonly sort = computed(() => this.sortSig());

  ngOnInit(): void {
    this.meta.setEntityMeta({
      entity: 'index',
      name: $localize`:@@vendors.index.metaName:Vendors`,
      description: $localize`:@@vendors.index.metaDescription:The directory of every AEC software vendor on AEC Integrations — sortable by name, recency, and last update.`,
      canonical: 'https://aecintegrations.com/vendors',
    });

    // Drive the fetch from the URL: any time `?page=` or `?sort=` changes,
    // re-fetch. Hydration: the SSR transfer cache (configured in
    // `app.config.ts`) serves the initial response without a second hop.
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
          return this.http.get<VendorsListResponse>('/api/vendors', { params: httpParams }).pipe(
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
