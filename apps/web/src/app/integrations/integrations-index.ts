import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
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
import { combineLatest, firstValueFrom, of } from 'rxjs';
import { catchError, switchMap, tap } from 'rxjs/operators';

import type { IntegrationsListResponse } from '@aeci/shared';

import { MetaService } from '../core/meta.service';
import { IndexLayout } from '../layouts/index-layout';
import { Paginator } from '../products/paginator';
import { SortableColumnHeader } from '../products/sortable-column-header';

import { IntegrationCard } from './integration-card';

type SortKey = 'name' | 'created';

const DEFAULT_PER_PAGE = 24;
// Phase 2 Spec §7.4: integrations default to `name ASC` (names render as
// "Source → Target", so alphabetical groups by source product). This differs
// from products/vendors, which default to `created DESC`.
const DEFAULT_SORT: SortKey = 'name';
const VALID_SORTS: ReadonlySet<SortKey> = new Set(['name', 'created']);

/** RFC-4122 UUID shape. Used to decide whether a filter value is already an ID. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parsePage(raw: string | null): number {
  const parsed = raw === null ? 1 : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function parseSort(raw: string | null): SortKey {
  if (raw && (VALID_SORTS as Set<string>).has(raw)) return raw as SortKey;
  return DEFAULT_SORT;
}

/**
 * Phase 2.14 (AECI-60) — paginated integration index. Renders the directory as
 * a sortable table inside `IndexLayout`, fetches from the private API via the
 * service-binding-proxied `/api/integrations` path, and updates the URL
 * (`?page=`, `?sort=`, `?sourceProductId=`, `?targetProductId=`) on every
 * interaction so deep links and browser back/forward work without extra state.
 *
 * Default sort: `name ASC` per Phase 2 Spec §7.4 (the server resolves direction
 * from the key; this page only sends a key). `perPage` is fixed at 24 and is
 * hard-clamped at 100 server-side.
 *
 * Filter (Phase 2): two text inputs for source / target product. Each accepts
 * either a raw product UUID or a product slug (hybrid). On submit, a slug is
 * resolved to its product ID via `GET /api/products/:slug`; a value already
 * shaped like a UUID is used directly. The resolved **ID** is what lands in the
 * URL (`?sourceProductId=`/`?targetProductId=`) and what the integrations API
 * consumes. A slug that doesn't resolve shows an inline "no match" message and
 * that filter is dropped. Richer autocomplete is deferred to Phase 3.
 *
 * SSR: cached for 5 minutes at the edge with `Cache-Tag: route:index,
 * index:integrations` (set by the SSR Worker via `cacheTagInputsForPath`). The
 * `withHttpTransferCacheOptions` in `app.config.ts` serializes the
 * `/api/integrations` response into the rendered HTML so the client doesn't
 * re-fetch on hydration.
 *
 * MetaService: `entity: 'index'` produces the title `Integrations — AEC
 * Integrations` and `og:type=website`.
 */
@Component({
  selector: 'app-integrations-index',
  imports: [IndexLayout, IntegrationCard, SortableColumnHeader, Paginator, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aec-index-layout>
      <div slot="header" class="space-y-5">
        <div class="space-y-3">
          <nav i18n-aria-label="@@integrations.index.breadcrumbs.aria" aria-label="Breadcrumb">
            <ol
              class="flex items-center gap-2 text-xs tracking-wide uppercase text-(--text-secondary)"
            >
              <li>
                <a
                  routerLink="/"
                  class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@integrations.index.breadcrumbs.home"
                  >Home</a
                >
              </li>
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              <li
                class="text-(--text-primary)"
                aria-current="page"
                i18n="@@integrations.index.breadcrumbs.current"
              >
                Integrations
              </li>
            </ol>
          </nav>
          <h1
            class="font-display text-4xl font-semibold tracking-tight md:text-5xl"
            i18n="@@integrations.index.title"
          >
            Integrations
          </h1>
          @if (data(); as response) {
            <p class="text-(--text-secondary)" i18n="@@integrations.index.lede">
              Every integration between AEC software products indexed on AEC Integrations —
              {{ response.total }} in total.
            </p>
          } @else {
            <p class="text-(--text-secondary)" i18n="@@integrations.index.lede.loading">
              Every integration between AEC software products indexed on AEC Integrations.
            </p>
          }
        </div>

        <form
          (submit)="onSubmit($event, sourceEl.value, targetEl.value)"
          class="flex flex-col gap-3 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-4 sm:flex-row sm:items-end"
        >
          <div class="flex-1 space-y-1.5">
            <label
              for="filter-source"
              class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-tertiary)"
              i18n="@@integrations.index.filter.source.label"
            >
              Source product
            </label>
            <input
              #sourceEl
              id="filter-source"
              type="text"
              [value]="initialSource()"
              i18n-placeholder="@@integrations.index.filter.source.placeholder"
              placeholder="Product slug or ID"
              [attr.aria-describedby]="filterErrors().source ? 'filter-source-error' : null"
              class="w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
            @if (filterErrors().source; as bad) {
              <p
                id="filter-source-error"
                class="text-xs font-medium text-(--text-primary)"
                role="alert"
                i18n="@@integrations.index.filter.noMatch"
              >
                No product matches “{{ bad }}”.
              </p>
            }
          </div>
          <div class="flex-1 space-y-1.5">
            <label
              for="filter-target"
              class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-tertiary)"
              i18n="@@integrations.index.filter.target.label"
            >
              Target product
            </label>
            <input
              #targetEl
              id="filter-target"
              type="text"
              [value]="initialTarget()"
              i18n-placeholder="@@integrations.index.filter.target.placeholder"
              placeholder="Product slug or ID"
              [attr.aria-describedby]="filterErrors().target ? 'filter-target-error' : null"
              class="w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
            @if (filterErrors().target; as bad) {
              <p
                id="filter-target-error"
                class="text-xs font-medium text-(--text-primary)"
                role="alert"
                i18n="@@integrations.index.filter.noMatch2"
              >
                No product matches “{{ bad }}”.
              </p>
            }
          </div>
          <div class="flex gap-2">
            <button
              type="submit"
              class="inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@integrations.index.filter.apply"
            >
              Apply
            </button>
            @if (hasActiveFilter()) {
              <button
                type="button"
                (click)="clearFilters(sourceEl, targetEl)"
                class="inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-4 py-2 text-sm font-bold text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@integrations.index.filter.clear"
              >
                Clear
              </button>
            }
          </div>
        </form>
      </div>

      <ng-container slot="table-header">
        <tr>
          <aec-sortable-column-header
            key="name"
            direction="ascending"
            [currentSort]="sort()"
            label="Integration"
            i18n-label="@@integrations.index.col.name"
            (sortChange)="onSortChange($event)"
          />
          <th
            scope="col"
            class="px-4 py-3 text-xs font-medium tracking-wide uppercase text-(--text-secondary)"
            i18n="@@integrations.index.col.mechanism"
          >
            Mechanism
          </th>
          <th
            scope="col"
            class="px-4 py-3 text-xs font-medium tracking-wide uppercase text-(--text-secondary)"
            i18n="@@integrations.index.col.direction"
          >
            Direction
          </th>
        </tr>
      </ng-container>

      <ng-container slot="table-body">
        @if (data(); as response) {
          @for (integration of response.data; track integration.id) {
            <tr aec-integration-card [integration]="integration"></tr>
          } @empty {
            <tr>
              <td
                colspan="3"
                class="px-4 py-12 text-center text-(--text-secondary)"
                i18n="@@integrations.index.empty"
              >
                No integrations match these filters.
              </td>
            </tr>
          }
        } @else if (error()) {
          <tr>
            <td
              colspan="3"
              class="px-4 py-12 text-center text-(--text-secondary)"
              i18n="@@integrations.index.error"
            >
              Couldn't load integrations. Refresh to try again.
            </td>
          </tr>
        } @else {
          <tr aria-busy="true">
            <td
              colspan="3"
              class="px-4 py-12 text-center text-(--text-tertiary)"
              i18n="@@integrations.index.loading"
            >
              Loading integrations…
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
export class IntegrationsIndex implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly meta = inject(MetaService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly data = signal<IntegrationsListResponse | null>(null);
  protected readonly error = signal<unknown>(null);

  private readonly sortSig = signal<SortKey>(DEFAULT_SORT);
  /** Current sort key (for the column header active state). */
  protected readonly sort = computed(() => this.sortSig());

  /** Bad slug values keyed by field, for inline "no match" messages. */
  protected readonly filterErrors = signal<{ source?: string; target?: string }>({});

  /** Whether any product filter is currently applied (drives the Clear button). */
  protected readonly hasActiveFilter = signal(false);

  /**
   * Initial filter-input values, read once from the active query params so the
   * current filter state is visible and round-trips (the inputs accept the raw
   * UUID just as happily as a slug). One-way `[value]` bindings — later
   * navigations don't clobber in-progress typing.
   */
  protected readonly initialSource = signal('');
  protected readonly initialTarget = signal('');

  ngOnInit(): void {
    this.meta.setEntityMeta({
      entity: 'index',
      name: $localize`:@@integrations.index.metaName:Integrations`,
      description: $localize`:@@integrations.index.metaDescription:The directory of every integration between AEC software products on AEC Integrations — filterable by source and target product.`,
      canonical: 'https://aecintegrations.com/integrations',
    });

    // Prefill the filter inputs from the active query params once (snapshot).
    const snap = this.route.snapshot.queryParamMap;
    this.initialSource.set(snap.get('sourceProductId') ?? '');
    this.initialTarget.set(snap.get('targetProductId') ?? '');

    // Drive the fetch from the URL: any time a query param changes, re-fetch.
    // Hydration: the SSR transfer cache (app.config.ts) serves the initial
    // response without a second hop.
    combineLatest([this.route.queryParamMap])
      .pipe(
        tap(([params]) => {
          this.sortSig.set(parseSort(params.get('sort')));
          this.hasActiveFilter.set(
            !!(params.get('sourceProductId') || params.get('targetProductId')),
          );
          this.error.set(null);
          this.data.set(null);
        }),
        switchMap(([params]) => {
          let httpParams = new HttpParams()
            .set('page', String(parsePage(params.get('page'))))
            .set('perPage', String(DEFAULT_PER_PAGE))
            .set('sort', parseSort(params.get('sort')));
          const sourceProductId = params.get('sourceProductId');
          const targetProductId = params.get('targetProductId');
          if (sourceProductId) httpParams = httpParams.set('sourceProductId', sourceProductId);
          if (targetProductId) httpParams = httpParams.set('targetProductId', targetProductId);
          return this.http
            .get<IntegrationsListResponse>('/api/integrations', { params: httpParams })
            .pipe(
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

  /**
   * Resolve a filter field to a product ID. A value already shaped like a UUID
   * is used as-is; otherwise it's treated as a slug and resolved via
   * `GET /api/products/:slug`. Returns the bad value on a miss so the caller
   * can surface an inline message.
   */
  private async resolveToId(value: string): Promise<{ id: string } | { error: string }> {
    const v = value.trim();
    if (UUID_RE.test(v)) return { id: v };
    try {
      const product = await firstValueFrom(
        this.http.get<{ id: string }>(`/api/products/${encodeURIComponent(v)}`),
      );
      return { id: product.id };
    } catch (err: unknown) {
      if (err instanceof HttpErrorResponse && err.status === 404) return { error: v };
      throw err;
    }
  }

  protected onSubmit(event: Event, sourceValue: string, targetValue: string): void {
    event.preventDefault();
    void this.applyFilters(sourceValue, targetValue);
  }

  protected async applyFilters(sourceValue: string, targetValue: string): Promise<void> {
    const sourceRaw = sourceValue.trim();
    const targetRaw = targetValue.trim();

    const errors: { source?: string; target?: string } = {};
    let sourceProductId: string | null = null;
    let targetProductId: string | null = null;

    try {
      if (sourceRaw) {
        const r = await this.resolveToId(sourceRaw);
        if ('id' in r) sourceProductId = r.id;
        else errors.source = r.error;
      }
      if (targetRaw) {
        const r = await this.resolveToId(targetRaw);
        if ('id' in r) targetProductId = r.id;
        else errors.target = r.error;
      }
    } catch (err: unknown) {
      this.data.set(null);
      this.error.set(err);
      return;
    }

    this.filterErrors.set(errors);

    // Setting a param to null removes it from the URL. Resolvable fields apply;
    // unresolvable ones are dropped (with the inline error shown). Reset to
    // page 1 since the result set changes.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { sourceProductId, targetProductId, page: 1 },
      queryParamsHandling: 'merge',
    });
  }

  protected clearFilters(sourceEl: HTMLInputElement, targetEl: HTMLInputElement): void {
    sourceEl.value = '';
    targetEl.value = '';
    this.filterErrors.set({});
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { sourceProductId: null, targetProductId: null, page: 1 },
      queryParamsHandling: 'merge',
    });
  }
}
