import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

import type { ProductFacetsResponse } from '@aeci/shared';

import { SearchRefinementList } from '../../search/widgets/search-refinement-list';
import type { TaxonomyKind } from '../taxonomy-badge/taxonomy-badge';

import type { RefinementItem } from './refinement-item';

/**
 * AECI-143 — API-backed faceted filter sidebar for `/products` and the taxonomy
 * browse pages. Fills the `BrowseLayout` filter-slot placeholder. Decision 1:
 * driven by the existing `/api/*` filter params (NOT Algolia), so the host pages
 * stay edge-cacheable.
 *
 * Data: fetches scoped facet counts from `GET /api/products/facets` via
 * `httpResource` — runs during SSR (captured in the HTTP transfer cache, same
 * mechanism as the index/browse grids) and re-fetches on every filter change.
 * The request mirrors the active URL filters plus the page's locked
 * `{kind}_id`, so each group's counts reflect the *other* active filters
 * (disjunctive faceting, computed server-side).
 *
 * Interaction (§9.2 — facets in the URL, not Algolia history): single-select per
 * dimension because the API takes one `{kind}_id` per dimension. Clicking the
 * active term clears it; clicking another replaces it; `page` resets to 1.
 *
 * Browse pages pass `lockedKind` + `lockedId` to scope to (and hide) their own
 * taxonomy; `/products` passes neither and shows all three groups.
 */
@Component({
  selector: 'aec-facet-sidebar',
  imports: [SearchRefinementList],
  template: `
    <div class="space-y-6">
      <h2
        class="text-xs font-semibold tracking-[0.08em] text-(--text-primary) uppercase"
        i18n="@@listing.filters.title"
      >
        Filters
      </h2>

      @for (group of groups(); track group.kind) {
        <aec-search-refinement-list
          [label]="group.label"
          [items]="group.items"
          (refine)="onRefine(group.kind, $event)"
        />
      }

      @if (hasActiveFilters()) {
        <button
          type="button"
          class="rounded-(--radius-sm) text-sm text-(--accent-primary) underline-offset-2 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          (click)="clearFilters()"
          i18n="@@listing.filters.clear"
        >
          Clear filters
        </button>
      }
    </div>
  `,
})
export class FacetSidebar {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** Browse pages lock (and hide) their own dimension; `/products` passes none. */
  readonly lockedKind = input<TaxonomyKind>();
  /** The locked term's UUID, sent as `{lockedKind}_id`. Required when `lockedKind` is set. */
  readonly lockedId = input<string>();

  /** Active query params as a signal (router seeds the current value synchronously). */
  private readonly queryParamMap = toSignal(this.route.queryParamMap, { requireSync: true });

  /**
   * The request params for the facets fetch: the active taxonomy filters + the
   * locked `{kind}_id`. `null` until the locked id is available (so a browse page
   * never fires an unlocked whole-catalog count query). Custom shallow equality
   * so this only re-emits when a *taxonomy filter* (or the lock) changes — NOT
   * on `page`/`sort` navigation, which can't change facet counts. That keeps the
   * fetch (and the SSR transfer-cache entry) stable across pagination/sorting.
   */
  private readonly facetParams = computed<Record<string, string> | null>(
    () => {
      const locked = this.lockedKind();
      const lockedId = this.lockedId();
      if (locked !== undefined && !lockedId) return null;

      const qp = this.queryParamMap();
      const params: Record<string, string> = {};
      for (const { param } of DIMENSIONS) {
        const value = qp.get(param);
        if (value) params[param] = value;
      }
      // The lock is authoritative for its own dimension (rides here, not the URL).
      if (locked && lockedId) params[`${locked}_id`] = lockedId;
      return params;
    },
    { equal: shallowEqualParams },
  );

  /**
   * Scoped facet counts from `GET /api/products/facets`. Runs during SSR
   * (transfer-cache captured) and re-fetches only when `facetParams` changes.
   */
  private readonly facets = httpResource<ProductFacetsResponse>(() => {
    const params = this.facetParams();
    if (params === null) return undefined;
    return { url: '/api/products/facets', params };
  });

  /**
   * Retains the last resolved facet counts so the sidebar keeps rendering its
   * terms while a filter change refetches them — without this the list blanks to
   * `[]` mid-flight (the sidebar half of the "flash"). The clicked checkbox still
   * toggles instantly because `isRefined` reads the URL, which updates
   * synchronously on navigation; only the counts lag, then swap in.
   */
  private readonly retainedFacets = linkedSignal<
    ProductFacetsResponse | undefined,
    ProductFacetsResponse | null
  >({
    source: () => (this.facets.hasValue() ? this.facets.value() : undefined),
    computation: (current, previous) => current ?? previous?.value ?? null,
  });

  /** One render group per non-locked dimension, terms mapped to refinement items. */
  protected readonly groups = computed<
    { kind: TaxonomyKind; label: string; items: RefinementItem[] }[]
  >(() => {
    const facets = this.retainedFacets();
    if (!facets) return [];
    const locked = this.lockedKind();
    const qp = this.queryParamMap();

    return DIMENSIONS.filter((d) => d.kind !== locked).map((d) => {
      const activeId = qp.get(d.param);
      const items: RefinementItem[] = facets[d.responseKey]
        .map((term) => ({
          value: term.id,
          label: term.name,
          count: term.product_count,
          isRefined: term.id === activeId,
        }))
        // Hide terms with no matches under the current filters (mirrors
        // Algolia's count>0 default on `/search`), but always keep the active
        // term so it can be toggled off.
        .filter((item) => item.count > 0 || item.isRefined);
      return { kind: d.kind, label: this.groupLabel(d.kind), items };
    });
  });

  /** True when any non-locked dimension filter is active in the URL. */
  protected readonly hasActiveFilters = computed(() => {
    const locked = this.lockedKind();
    const qp = this.queryParamMap();
    return DIMENSIONS.some((d) => d.kind !== locked && !!qp.get(d.param));
  });

  /** Single-select toggle: clear if already active, else replace. Resets to page 1. */
  protected onRefine(kind: TaxonomyKind, value: string): void {
    const param = `${kind}_id`;
    const current = this.queryParamMap().get(param);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [param]: current === value ? null : value, page: 1 },
      queryParamsHandling: 'merge',
    });
  }

  /** Clear every non-locked dimension filter (keeps the locked scope + sort). */
  protected clearFilters(): void {
    const locked = this.lockedKind();
    const queryParams: Record<string, string | number | null> = { page: 1 };
    for (const d of DIMENSIONS) {
      if (d.kind !== locked) queryParams[d.param] = null;
    }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: 'merge',
    });
  }

  protected groupLabel(kind: TaxonomyKind): string {
    switch (kind) {
      case 'category':
        return $localize`:@@listing.filters.categories:Categories`;
      case 'audience':
        return $localize`:@@listing.filters.audiences:Audiences`;
      case 'phase':
        return $localize`:@@listing.filters.phases:Phases`;
    }
  }
}

/** Shallow record equality — lets `facetParams` ignore `page`/`sort`-only navs. */
function shallowEqualParams(
  a: Record<string, string> | null,
  b: Record<string, string> | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/** The three taxonomy dimensions, mapping kind → response key → URL/API param. */
const DIMENSIONS: readonly {
  kind: TaxonomyKind;
  responseKey: keyof ProductFacetsResponse;
  param: string;
}[] = [
  { kind: 'category', responseKey: 'categories', param: 'category_id' },
  { kind: 'audience', responseKey: 'audiences', param: 'audience_id' },
  { kind: 'phase', responseKey: 'phases', param: 'phase_id' },
];
