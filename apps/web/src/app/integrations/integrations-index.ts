import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { IntegrationsListResponse } from '@aeci/shared';

import { IndexLayout } from '../layouts/index-layout';
import { Paginator } from '../products/paginator';
import { SortableColumnHeader } from '../products/sortable-column-header';
import { createPaginatedIndex } from '../shared/paginated-index/paginated-index-controller';

import { IntegrationCard } from './integration-card';

/** RFC-4122 UUID shape. Used to decide whether a filter value is already an ID. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Phase 2.14 (AECI-60) paginated integration index. Renders the directory as a
 * sortable table inside `IndexLayout`. The fetch/sort/pagination/error pipeline
 * lives in the shared `createPaginatedIndex` controller (AECI-107), configured
 * with the two filter params as `passthroughParams` so they flow from the URL
 * through to the API request. This component keeps only the per-entity template
 * (`@@integrations.*` i18n ids) and the source/target filter form.
 *
 * Default sort: `name ASC` per Phase 2 Spec section 7.4 (names render as
 * "Source to Target", so alphabetical groups by source product). This differs
 * from products/vendors, which default to `created DESC`. `perPage` is fixed at
 * 24 and hard-clamped at 100 server-side.
 *
 * Filter (Phase 2): two text inputs for source / target product. Each accepts
 * either a raw product UUID or a product slug (hybrid). On submit, a slug is
 * resolved to its product ID via `GET /api/products/:slug`; a value already
 * shaped like a UUID is used directly. The resolved ID is what lands in the URL
 * (`?sourceProductId=`/`?targetProductId=`) and what the integrations API
 * consumes. A slug that doesn't resolve shows an inline "no match" message and
 * that filter is dropped; a non-404 lookup failure surfaces the table error row
 * (via `idx.setError`). Richer autocomplete is deferred to Phase 3.
 *
 * SSR: cached for 5 minutes at the edge with `Cache-Tag: route:index,
 * index:integrations` (set by the SSR Worker via `cacheTagInputsForPath`). The
 * `withHttpTransferCacheOptions` in `app.config.ts` serializes the
 * `/api/integrations` response into the rendered HTML so the client doesn't
 * re-fetch on hydration.
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
          @if (idx.data(); as response) {
            <p class="text-(--text-secondary)" i18n="@@integrations.index.lede">
              Every integration between AEC software products indexed on AEC Integrations ({{
                response.total
              }}
              in total).
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
              class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
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
              class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
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
            [currentSort]="idx.sort()"
            label="Integration"
            i18n-label="@@integrations.index.col.name"
            (sortChange)="idx.onSortChange($event)"
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
        @if (idx.data(); as response) {
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
        } @else if (idx.error()) {
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
export class IntegrationsIndex {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);

  protected readonly idx = createPaginatedIndex<IntegrationsListResponse>({
    apiPath: '/api/integrations',
    validSorts: new Set(['name', 'created']),
    defaultSort: 'name',
    passthroughParams: ['sourceProductId', 'targetProductId'],
    meta: {
      entity: 'index',
      name: $localize`:@@integrations.index.metaName:Integrations`,
      description: $localize`:@@integrations.index.metaDescription:The directory of every integration between AEC software products on AEC Integrations. Filterable by source and target product.`,
      canonical: 'https://aecintegrations.com/integrations',
    },
  });

  /** Bad slug values keyed by field, for inline "no match" messages. */
  protected readonly filterErrors = signal<{ source?: string; target?: string }>({});

  /** Whether any product filter is currently applied (drives the Clear button). */
  protected readonly hasActiveFilter = computed(() => {
    const params = this.idx.params();
    return !!(params['sourceProductId'] || params['targetProductId']);
  });

  /**
   * Initial filter-input values, read once from the active query params so the
   * current filter state is visible and round-trips (the inputs accept the raw
   * UUID just as happily as a slug). One-way `[value]` bindings, so later
   * navigations don't clobber in-progress typing.
   */
  protected readonly initialSource = signal(
    this.route.snapshot.queryParamMap.get('sourceProductId') ?? '',
  );
  protected readonly initialTarget = signal(
    this.route.snapshot.queryParamMap.get('targetProductId') ?? '',
  );

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
      this.idx.setError(err);
      return;
    }

    this.filterErrors.set(errors);

    // Setting a param to null removes it from the URL. Resolvable fields apply;
    // unresolvable ones are dropped (with the inline error shown). Reset to
    // page 1 since the result set changes.
    this.idx.navigateWithParams({ sourceProductId, targetProductId, page: 1 });
  }

  protected clearFilters(sourceEl: HTMLInputElement, targetEl: HTMLInputElement): void {
    sourceEl.value = '';
    targetEl.value = '';
    this.filterErrors.set({});
    this.idx.navigateWithParams({ sourceProductId: null, targetProductId: null, page: 1 });
  }
}
