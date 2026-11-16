import { isPlatformBrowser } from '@angular/common';
import { HttpParams, httpResource } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  inject,
  input,
  linkedSignal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationStart, Router } from '@angular/router';
import { filter } from 'rxjs';

import type { ProductFacetsResponse } from '@aeci/shared';

import { SearchRefinementList } from '../../search/widgets/search-refinement-list';
import {
  FacetHistoryStore,
  HistoryTraversal,
  listingHistoryKey,
  listingPath,
} from '../paginated-index/listing-history-store';
import type { TaxonomyKind } from '../taxonomy-badge/taxonomy-badge';

import { FacetPanel } from './facet-panel';
import { FILTER_LINK_CLASS } from './filter-row';
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
 * taxonomy; `/products` passes neither and shows all four groups.
 *
 * Responsive (AECI — mobile facet disclosure): on `< md` the host `aside`
 * stacks *above* the results grid (`BrowseLayout`'s single-column collapse), so
 * a fully-expanded rail forces the reader to scroll past every checkbox to reach
 * the list. Below `md` the groups therefore live behind a "Filters" disclosure
 * (collapsed by default, with an active-filter count badge); at `md+` the
 * trigger is removed and the panel is always shown — the desktop two-column rail
 * is unchanged. Default-collapsed keeps the SSR/edge-cached HTML
 * visitor-state-neutral (the panel's `hidden`/`md:flex` is pure CSS the client
 * never has to reconcile). The disclosure lives in the shared `aec-facet-panel`
 * so `/search` renders the identical chrome.
 */
@Component({
  selector: 'aec-facet-sidebar',
  imports: [FacetPanel, SearchRefinementList],
  template: `
    <aec-facet-panel [activeCount]="activeFilterCount()" [orderNote]="orderNote()">
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
          [class]="clearClass"
          (click)="clearFilters()"
          i18n="@@listing.filters.clear"
        >
          Clear filters
        </button>
      }
    </aec-facet-panel>
  `,
})
export class FacetSidebar {
  private readonly route = inject(ActivatedRoute);

  protected readonly clearClass = FILTER_LINK_CLASS;

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

  /** The counts request line, `null` while there is no request. Part of the store key. */
  private readonly facetLine = computed<string | null>(() => {
    const params = this.facetParams();
    return params === null ? null : facetRequestLine(params);
  });

  // AECI-1900: on Back or Forward, the counts this panel showed when the reader
  // left. Browser only: the server has no history and never touches the store.
  private readonly history = isPlatformBrowser(inject(PLATFORM_ID))
    ? inject(FacetHistoryStore)
    : null;
  private readonly traversal = this.history ? inject(HistoryTraversal) : null;

  /**
   * The stored counts on a Back or Forward, so the panel renders at full height
   * in its first frame and the router's restore can reach the saved position.
   * Read for the first counts request (the inputs that lock a term page are set
   * by then) and for each later change of filters, because a Back or Forward
   * between two filter states on one page keeps this panel. A filter click is
   * not a Back, finds nothing, and the resource fetches.
   */
  private readonly restored = linkedSignal<
    string | null,
    { line: string; body: ProductFacetsResponse } | null
  >({
    source: this.facetLine,
    computation: (line) => {
      const traversal = this.traversal;
      if (line === null || !this.history || !traversal?.isTraversal()) return null;
      const body = untracked(() =>
        this.history?.read<ProductFacetsResponse>(
          this.historyKey(line),
          traversal.restoredEntryId(),
        ),
      );
      return body ? { line, body } : null;
    },
  });

  /**
   * Scoped facet counts from `GET /api/products/facets`. Runs during SSR
   * (transfer-cache captured) and re-fetches only when `facetParams` changes.
   * Asks for nothing while restored counts stand in for the request.
   */
  private readonly facets = httpResource<ProductFacetsResponse>(() => {
    const params = this.facetParams();
    if (params === null || this.restored() !== null) return undefined;
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
    source: () => (this.facets.hasValue() ? this.facets.value() : this.restored()?.body),
    computation: (current, previous) => current ?? previous?.value ?? null,
  });

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // Keep the counts on screen for a later Back or Forward to this history
    // entry: as the reader leaves it (a filter click keeps this panel, so that
    // is a `NavigationStart`), and at teardown.
    if (this.history) {
      this.router.events
        .pipe(
          filter((e) => e instanceof NavigationStart),
          takeUntilDestroyed(this.destroyRef),
        )
        .subscribe(() => this.saveForHistory());
      this.destroyRef.onDestroy(() => this.saveForHistory());
    }
  }

  private historyKey(line: string): string {
    return listingHistoryKey(listingPath(this.route.snapshot), line);
  }

  private saveForHistory(): void {
    const line = this.facetLine();
    const counts = this.retainedFacets();
    if (!this.history || line === null || counts === null) return;
    this.history.write(this.historyKey(line), this.traversal?.currentEntryId() ?? null, counts);
  }

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
        //
        // Trades are NOT additionally gated on `TRADE_PUBLISH_MIN_PRODUCTS`
        // here, unlike the `/trades` index and the nav: these counts are
        // *scoped* (disjunctive — see `facetParams`), so a published trade's
        // count legitimately drops below the floor under an active filter and
        // gating would hide it. A sub-floor trade offered here still leads to a
        // real, non-empty result set, and the sidebar is a control surface, not
        // indexable content — the floor exists to keep thin *pages* out of the
        // index. Recorded in TRADES_VOCABULARY.md §6.
        .filter((item) => item.count > 0 || item.isRefined);
      return { kind: d.kind, label: this.groupLabel(d.kind), items };
    });
  });

  /**
   * How the terms are ordered, stated under the panel (rulings 5 and 6 of
   * 2026-11-16). True of `GET /api/products/facets`: phases by `display_order`
   * (project order), categories and trades by `display_order`, which is A to Z
   * (held by `apps/api/src/lib/taxonomy-a-to-z.spec.ts`), audiences by name.
   *
   * The caption names only groups the reader can see (AECI-1794). A phase term
   * page locks and hides the Phases group, and a group with no terms left under
   * the active filters renders nothing. With no Phases group on screen, every
   * group shown is A to Z, so the caption says only that. Before the counts
   * load there are no groups, and the caption follows the lock alone. The
   * server renders with the counts, but the first client render runs before
   * `httpResource` hands them back. So on a filtered URL that leaves no phase
   * term, the caption reads the long form for one render after hydration
   * (about 20ms), then the short form again. It is not a live region and does
   * not move the layout.
   */
  protected readonly orderNote = computed(() => {
    const groups = this.groups();
    const phasesShown =
      groups.length === 0
        ? this.lockedKind() !== 'phase'
        : groups.some((g) => g.kind === 'phase' && g.items.length > 0);
    return phasesShown
      ? $localize`:@@listing.filters.order.directory:Phases in project order. Other terms A to Z.`
      : $localize`:@@listing.filters.order.directoryNoPhases:Terms A to Z.`;
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
      // Stay in place: a reader ticks several filters in a row, and a jump to
      // the top after each one loses their place (`DESIGN.md` "The
      // Same-Behavior Rule"; /search behaves the same).
      scroll: 'manual',
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
      scroll: 'manual',
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
      case 'trade':
        return $localize`:@@listing.filters.trades:Trades`;
    }
  }
}

/** Decode a (possibly null) `{kind}_id` CSV param into its set of selected ids. */
function parseIds(raw: string | null): Set<string> {
  return new Set((raw ?? '').split(',').filter((id) => id.length > 0));
}

/**
 * The counts request line, as `HttpRequest.urlWithParams` builds it for the
 * resource: every filter and the locked term, in `facetParams` order.
 */
function facetRequestLine(params: Record<string, string>): string {
  const query = new HttpParams({ fromObject: params }).toString();
  return query.length === 0 ? '/api/products/facets' : `/api/products/facets?${query}`;
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

/**
 * The four taxonomy dimensions, mapping kind → response key → URL/API param.
 * Array order is render order: Categories → Audiences → Trades → Phases, which
 * runs widest-to-narrowest on *what the tool is* before ending on *when it is
 * used*. Trades (AECI-544) sit next to Audiences because both answer "who is
 * this for"; the `/search` refinement rail mirrors this order.
 */
const DIMENSIONS: readonly {
  kind: TaxonomyKind;
  responseKey: keyof ProductFacetsResponse;
  param: string;
}[] = [
  { kind: 'category', responseKey: 'categories', param: 'category_id' },
  { kind: 'audience', responseKey: 'audiences', param: 'audience_id' },
  { kind: 'trade', responseKey: 'trades', param: 'trade_id' },
  { kind: 'phase', responseKey: 'phases', param: 'phase_id' },
];
