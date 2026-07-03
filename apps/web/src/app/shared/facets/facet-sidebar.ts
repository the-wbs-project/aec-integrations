import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
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
 * Interaction (facets in the URL, not Algolia history): **multi-select** per
 * dimension (AECI-223) — clicking a term toggles it in/out of that dimension's
 * set. The set is encoded as a **sorted** comma-separated `{kind}_id` param
 * (e.g. `category_id=a,b`): the API reads it as an `in (...)` clause (OR within
 * the dimension; AND across dimensions), and the *sorted* order keeps the edge
 * cache key + SSR transfer-cache key stable regardless of click order. `page`
 * resets to 1; emptying the set drops the param.
 *
 * Browse pages pass `lockedKind` + `lockedId` to scope to (and hide) their own
 * taxonomy; `/products` passes neither and shows all three groups.
 *
 * Responsive (AECI — mobile facet disclosure): on `< md` the host `aside`
 * stacks *above* the results grid (`BrowseLayout`'s single-column collapse), so
 * a fully-expanded rail forces the reader to scroll past every checkbox to reach
 * the list. Below `md` the groups therefore live behind a "Filters" disclosure
 * (collapsed by default, with an active-filter count badge); at `md+` the
 * trigger is removed and the panel is always shown — the desktop two-column rail
 * is unchanged. Default-collapsed keeps the SSR/edge-cached HTML
 * visitor-state-neutral (the panel's `hidden`/`md:flex` is pure CSS the client
 * never has to reconcile). Matches the disclosure idiom in `nav-menu.ts`.
 */
@Component({
  selector: 'aec-facet-sidebar',
  imports: [SearchRefinementList],
  template: `
    <div class="flex flex-col gap-4">
      <!--
        Mobile (< md): a "Filters" disclosure so the reader reaches the results
        without scrolling past every checkbox. Hidden at md+, where the panel
        below is always shown (canonical \`hidden\`/\`md:flex\` toggle). Collapsed
        by default → the SSR/edge-cached HTML stays visitor-state-neutral.
      -->
      <button
        type="button"
        class="flex w-full cursor-pointer items-center justify-between rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-4 py-2.5 text-start transition-colors hover:border-(--border-strong) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) md:hidden"
        [attr.aria-expanded]="panelOpen()"
        aria-controls="aec-facet-panel"
        (click)="togglePanel()"
      >
        <span class="aec-overline text-(--text-primary)" i18n="@@listing.filters.title"
          >Filters</span
        >
        <span class="inline-flex items-center gap-2">
          @if (activeFilterCount(); as n) {
            <span
              class="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-(--accent-primary) px-1.5 text-xs font-medium tabular-nums text-(--surface-base)"
              aria-hidden="true"
              >{{ n }}</span
            >
          }
          <svg
            aria-hidden="true"
            class="h-4 w-4 text-(--text-secondary) transition-transform"
            [class.rotate-180]="panelOpen()"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>

      <!--
        Panel: collapsed on mobile unless open; always a flex column at md+.
        flex+gap (not space-y-*): each facet group is a custom element
        (<aec-search-refinement-list>), which defaults to display:inline, and
        space-y's margin-top is ignored on inline boxes (the groups rendered
        flush). As flex items they're blockified and gap-6 spaces them reliably.
      -->
      <div
        id="aec-facet-panel"
        class="flex-col gap-6 md:flex"
        [class.flex]="panelOpen()"
        [class.hidden]="!panelOpen()"
      >
        <h2
          class="aec-overline hidden text-(--text-primary) md:block"
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
  /**
   * Whether a filter change resets `?page=1` in the URL. True for the classic
   * prev/next (replace-mode) browse pages. The append-mode listing (`/products`)
   * passes `false`: it drives paging internally and keeps the page out of the
   * URL, so a filter change must not reintroduce a `?page=` param (the engine
   * resets the buffer to page 1 on its own).
   */
  readonly resetsPage = input<boolean>(true);

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
      const activeIds = parseIds(qp.get(d.param));
      const items: RefinementItem[] = facets[d.responseKey]
        .map((term) => ({
          value: term.id,
          label: term.name,
          count: term.product_count,
          isRefined: activeIds.has(term.id),
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

  /**
   * Count of selected terms across the non-locked dimensions — shown as a badge
   * on the mobile "Filters" trigger so the active-filter state is legible while
   * the panel is collapsed.
   */
  protected readonly activeFilterCount = computed(() => {
    const locked = this.lockedKind();
    const qp = this.queryParamMap();
    let count = 0;
    for (const d of DIMENSIONS) {
      if (d.kind === locked) continue;
      count += parseIds(qp.get(d.param)).size;
    }
    return count;
  });

  /** Mobile-only disclosure state for the facet panel (always shown at md+). */
  private readonly panelOpenSig = signal(false);
  protected readonly panelOpen = this.panelOpenSig.asReadonly();

  protected togglePanel(): void {
    this.panelOpenSig.update((open) => !open);
  }

  /**
   * Multi-select toggle (AECI-223): add the term to (or remove it from) the
   * dimension's set, then re-encode as a **sorted** CSV so click order never
   * forks the cache. An empty set drops the param. Resets to page 1.
   */
  protected onRefine(kind: TaxonomyKind, value: string): void {
    const param = `${kind}_id`;
    const ids = parseIds(this.queryParamMap().get(param));
    if (ids.has(value)) ids.delete(value);
    else ids.add(value);
    const next = [...ids].sort().join(',');
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [param]: next.length > 0 ? next : null, page: this.resetsPage() ? 1 : null },
      queryParamsHandling: 'merge',
    });
  }

  /** Clear every non-locked dimension filter (keeps the locked scope + sort). */
  protected clearFilters(): void {
    const locked = this.lockedKind();
    const queryParams: Record<string, string | number | null> = {
      page: this.resetsPage() ? 1 : null,
    };
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

/** Decode a (possibly null) `{kind}_id` CSV param into its set of selected ids. */
function parseIds(raw: string | null): Set<string> {
  return new Set((raw ?? '').split(',').filter((id) => id.length > 0));
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
