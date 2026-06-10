/**
 * `/search` — the faceted, tabbed search experience (AECI-142 / Phase 3.9).
 *
 * Search runs BROWSER-SIDE against Algolia with the search-only key (the API
 * Worker is not in the read path, §7.5). The SSR shell paints meta (noindex) +
 * the search box (seeded from `?q=`) + the entity tablist + an initial state;
 * after hydration, `afterNextRender` reads the injected public config
 * (`window.__AECI_ALGOLIA__`), dynamically loads the search SDK, and starts
 * `SearchController`, which maps InstantSearch connector render state into
 * signals this template binds. Switching tabs is pure show/hide of
 * already-materialized signal slices — it never re-queries.
 *
 * Graceful degradation: when the public config is absent (local dev without
 * Algolia secrets, or any env where search isn't provisioned) the page renders
 * the shell + a "temporarily unavailable" notice and never constructs the
 * controller. This is also the path CI/local-bound e2e exercises (no provisioned
 * key).
 *
 * Caching: `/search` is non-cacheable (`private, no-store`) — it is NOT in
 * `server-runtime.ts`'s `ROUTE_CACHE_PATTERNS`, so it hits the fail-closed
 * default — and `MetaService.setSearchMeta` adds `robots: noindex` (§4.6: search
 * results aren't canonical content).
 *
 * The deliberate §7.5 deviation (`angular-instantsearch` → `instantsearch.js` +
 * connectors → signals) and the deferred per-tab sort dropdown are documented in
 * `search-controller.ts` and ADR 0014.
 */
import { NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  type ElementRef,
  inject,
  type OnDestroy,
  signal,
  viewChildren,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';

import { readAlgoliaConfig } from './algolia-config';
import { SEARCH_ENGINE_FACTORY } from './search-controller.factory';
import { SearchController } from './search-controller';
import { SearchIntegrationCard } from './search-integration-card';
import { SearchProductCard } from './search-product-card';
import { SearchVendorCard } from './search-vendor-card';
import { SearchNumericMenu } from './widgets/search-numeric-menu';
import { SearchPaginator } from './widgets/search-paginator';
import { SearchRangeInput } from './widgets/search-range-input';
import { SearchRefinementList } from './widgets/search-refinement-list';

type EntityTab = 'products' | 'vendors' | 'integrations';

const TABS: readonly EntityTab[] = ['products', 'vendors', 'integrations'];

/** Debounce for mirroring `?q=` into the URL (separate from the search debounce). */
const URL_SYNC_DEBOUNCE_MS = 350;

@Component({
  selector: 'app-search-page',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    SearchProductCard,
    SearchVendorCard,
    SearchIntegrationCard,
    SearchRefinementList,
    SearchNumericMenu,
    SearchRangeInput,
    SearchPaginator,
  ],
  template: `
    <section class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
        <header class="border-b border-(--border-default) pb-6">
          <h1
            class="font-display text-3xl font-semibold tracking-tight md:text-4xl"
            i18n="@@search.title"
          >
            Search
          </h1>
          <form
            class="mt-5 max-w-2xl"
            role="search"
            action="/search"
            method="get"
            (submit)="onSubmit($event)"
          >
            <label class="sr-only" for="search-input" i18n="@@search.input.label"
              >Search the directory</label
            >
            <input
              id="search-input"
              name="q"
              type="search"
              autocomplete="off"
              [value]="inputValue()"
              (input)="onQueryInput($event)"
              i18n-placeholder="@@search.input.placeholder"
              placeholder="Search products, vendors, and integrations"
              class="h-12 w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-4 text-base text-(--text-primary) placeholder:text-(--text-secondary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
          </form>
        </header>

        @if (degraded()) {
          <div
            class="mt-10 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) px-6 py-10 text-center"
            role="status"
          >
            <p
              class="text-base font-medium text-(--text-primary)"
              i18n="@@search.unavailable.title"
            >
              Search is temporarily unavailable.
            </p>
            <p class="mt-2 text-sm text-(--text-secondary)" i18n="@@search.unavailable.body">
              Please try again later, or browse the directory by category.
            </p>
          </div>
        } @else {
          <div
            role="tablist"
            class="mt-8 flex gap-1 border-b border-(--border-default)"
            aria-label="Search results by type"
            i18n-aria-label="@@search.tablist.aria"
          >
            @for (tab of tabs; track tab) {
              <button
                #tabBtn
                type="button"
                role="tab"
                [id]="tabId(tab)"
                [attr.aria-selected]="activeTab() === tab"
                [attr.aria-controls]="panelId"
                [tabindex]="activeTab() === tab ? 0 : -1"
                (click)="selectTab(tab)"
                (keydown)="onTabKeydown($event)"
                class="-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                [class.border-transparent]="activeTab() !== tab"
                [class.text-(--text-secondary)]="activeTab() !== tab"
                [class.border-(--accent-primary)]="activeTab() === tab"
                [class.text-(--text-primary)]="activeTab() === tab"
              >
                {{ tabLabel(tab) }}
                @if (countFor(tab); as count) {
                  <span class="ms-1.5 tabular-nums text-(--text-secondary)">{{ count }}</span>
                }
              </button>
            }
          </div>

          <div
            role="tabpanel"
            [id]="panelId"
            [attr.aria-labelledby]="tabId(activeTab())"
            tabindex="0"
            class="mt-6 focus-visible:outline-none"
          >
            <div class="grid gap-8 md:grid-cols-[16rem_1fr]">
              <aside i18n-aria-label="@@search.filters.aria" aria-label="Filters" class="space-y-6">
                @if (currentFacets(); as facets) {
                  @for (rl of facets.refinementLists; track rl.attribute) {
                    <aec-search-refinement-list
                      [label]="facetLabel(rl.attribute)"
                      [items]="rl.items()"
                      [booleanLabels]="booleanLabelsFor(rl.attribute)"
                      (refine)="rl.refine($event)"
                    />
                  }
                  @for (nm of facets.numericMenus; track nm.attribute) {
                    <aec-search-numeric-menu
                      [label]="facetLabel(nm.attribute)"
                      [name]="activeTab() + ':' + nm.attribute"
                      [allLabel]="allLabel"
                      [items]="nm.items()"
                      (refine)="nm.refine($event)"
                    />
                  }
                  @for (rg of facets.ranges; track rg.attribute) {
                    <aec-search-range-input
                      [label]="facetLabel(rg.attribute)"
                      [name]="activeTab() + ':' + rg.attribute"
                      [bounds]="rg.bounds()"
                      [start]="rg.start()"
                      (refine)="rg.refine($event)"
                    />
                  }
                }
              </aside>

              <div>
                @if (controller(); as ctrl) {
                  <p class="sr-only" role="status" aria-live="polite">
                    {{ resultsStatus() }}
                  </p>
                  @switch (activeTab()) {
                    @case ('products') {
                      @if (ctrl.products.hits(); as hits) {
                        @if (hits.length) {
                          <ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            @for (hit of hits; track hit.objectID) {
                              <li><aec-search-product-card [record]="hit" /></li>
                            }
                          </ul>
                          <aec-search-paginator
                            [page]="ctrl.products.page()"
                            [nbPages]="ctrl.products.nbPages()"
                            (pageChange)="ctrl.products.refinePage($event)"
                          />
                        } @else {
                          <ng-container [ngTemplateOutlet]="emptyState" />
                        }
                      }
                    }
                    @case ('vendors') {
                      @if (ctrl.vendors.hits(); as hits) {
                        @if (hits.length) {
                          <ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            @for (hit of hits; track hit.objectID) {
                              <li><aec-search-vendor-card [record]="hit" /></li>
                            }
                          </ul>
                          <aec-search-paginator
                            [page]="ctrl.vendors.page()"
                            [nbPages]="ctrl.vendors.nbPages()"
                            (pageChange)="ctrl.vendors.refinePage($event)"
                          />
                        } @else {
                          <ng-container [ngTemplateOutlet]="emptyState" />
                        }
                      }
                    }
                    @case ('integrations') {
                      @if (ctrl.integrations.hits(); as hits) {
                        @if (hits.length) {
                          <ul class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            @for (hit of hits; track hit.objectID) {
                              <li><aec-search-integration-card [record]="hit" /></li>
                            }
                          </ul>
                          <aec-search-paginator
                            [page]="ctrl.integrations.page()"
                            [nbPages]="ctrl.integrations.nbPages()"
                            (pageChange)="ctrl.integrations.refinePage($event)"
                          />
                        } @else {
                          <ng-container [ngTemplateOutlet]="emptyState" />
                        }
                      }
                    }
                  }
                } @else {
                  <p
                    class="px-4 py-12 text-center text-sm text-(--text-secondary)"
                    aria-busy="true"
                    i18n="@@search.loading"
                  >
                    Loading search…
                  </p>
                }
              </div>
            </div>
          </div>
        }
      </div>
    </section>

    <ng-template #emptyState>
      <div class="px-4 py-12 text-center">
        <p class="text-sm text-(--text-secondary)" i18n="@@search.empty">
          No results. Try a broader search or
          <a
            routerLink="/categories"
            class="font-medium text-(--accent-primary) underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >browse by category</a
          >.
        </p>
      </div>
    </ng-template>
  `,
})
export class SearchPage implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly meta = inject(MetaService);
  private readonly engineFactory = inject(SEARCH_ENGINE_FACTORY);

  protected readonly tabs = TABS;
  protected readonly panelId = 'search-tabpanel';
  /** Localized "all / no filter" label shared by every numeric menu. */
  protected readonly allLabel = $localize`:@@search.facet.all:All`;

  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabBtn');

  /** Seeded once from `?q=` for the SSR `[value]` and the controller's first query. */
  private readonly initialQuery = this.route.snapshot.queryParamMap.get('q')?.trim() ?? '';

  protected readonly controller = signal<SearchController | null>(null);
  /** True once we know the public Algolia config is absent (browser-only). */
  protected readonly degraded = signal(false);
  protected readonly activeTab = signal<EntityTab>(this.initialTab());

  private urlSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  /** Input value: the controller's live query once started, else the seed. */
  protected readonly inputValue = computed(() => this.controller()?.query() ?? this.initialQuery);

  /** The active tab's facet views (same shape across entities). */
  protected readonly currentFacets = computed(() => {
    const ctrl = this.controller();
    return ctrl ? ctrl[this.activeTab()] : null;
  });

  protected readonly resultsStatus = computed(() => {
    const ctrl = this.controller();
    if (!ctrl) return '';
    const count = ctrl[this.activeTab()].nbHits();
    return $localize`:@@search.results.status:${count}:COUNT: results`;
  });

  constructor() {
    // SSR + client: set the noindex/title/canonical so it ships in the initial
    // HTML head and is refreshed on an in-app nav onto /search.
    this.meta.setSearchMeta({ canonical: canonicalUrl('/search') });

    // Browser-only: read the injected public config, load the SDK, start search.
    afterNextRender(() => {
      const config = readAlgoliaConfig();
      if (!config) {
        this.degraded.set(true);
        return;
      }
      void this.engineFactory(config)
        .then(({ lib, searchClient }) => {
          if (this.destroyed) return;
          const controller = new SearchController(lib, searchClient, config, this.initialQuery);
          controller.start();
          this.controller.set(controller);
        })
        .catch((error: unknown) => {
          // Search must never break the page — degrade to the unavailable notice.
          console.warn('Search failed to initialise', error);
          this.degraded.set(true);
        });
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.urlSyncTimer) clearTimeout(this.urlSyncTimer);
    this.controller()?.dispose();
  }

  protected onQueryInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.controller()?.setQuery(value);
    this.scheduleUrlSync(value);
  }

  /** Native form submit (no-JS fallback navigates to `/search?q=`). */
  protected onSubmit(event: Event): void {
    event.preventDefault();
  }

  protected selectTab(tab: EntityTab): void {
    if (this.activeTab() === tab) return;
    this.activeTab.set(tab);
    // Default tab (products) drops `?tab=`; others set it. Immediate, replaceUrl.
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'products' ? null : tab },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  /** APG tabs: ←/→ move + activate, Home/End jump to the ends. */
  protected onTabKeydown(event: KeyboardEvent): void {
    const current = this.tabs.indexOf(this.activeTab());
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (current + 1) % this.tabs.length;
        break;
      case 'ArrowLeft':
        next = (current - 1 + this.tabs.length) % this.tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = this.tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.selectTab(this.tabs[next]);
    this.tabButtons()[next]?.nativeElement.focus();
  }

  protected countFor(tab: EntityTab): number | null {
    const ctrl = this.controller();
    return ctrl ? ctrl[tab].nbHits() : null;
  }

  protected tabId(tab: EntityTab): string {
    return `search-tab-${tab}`;
  }

  protected tabLabel(tab: EntityTab): string {
    switch (tab) {
      case 'products':
        return $localize`:@@search.tab.products:Products`;
      case 'vendors':
        return $localize`:@@search.tab.vendors:Vendors`;
      case 'integrations':
        return $localize`:@@search.tab.integrations:Integrations`;
    }
  }

  /** Localized facet heading for a faceting attribute (§7.2). */
  protected facetLabel(attribute: string): string {
    switch (attribute) {
      case 'categories':
        return $localize`:@@search.facet.categories:Categories`;
      case 'audiences':
        return $localize`:@@search.facet.audiences:Audiences`;
      case 'phases':
        return $localize`:@@search.facet.phases:Phases`;
      case 'vendor_name':
        return $localize`:@@search.facet.vendor:Vendor`;
      case 'has_api_docs':
        return $localize`:@@search.facet.apiDocs:API documentation`;
      case 'headquarters':
        return $localize`:@@search.facet.headquarters:Headquarters`;
      case 'founded_year':
        return $localize`:@@search.facet.founded:Founded`;
      case 'product_count':
        return $localize`:@@search.facet.products:Products`;
      case 'integration_count':
        return $localize`:@@search.facet.integrations:Integrations`;
      case 'mechanism_kind':
        return $localize`:@@search.facet.mechanism:Mechanism`;
      case 'direction':
        return $localize`:@@search.facet.direction:Direction`;
      case 'source_product_name':
        return $localize`:@@search.facet.sourceProduct:Source product`;
      case 'target_product_name':
        return $localize`:@@search.facet.targetProduct:Target product`;
      default:
        return attribute;
    }
  }

  /** Localized yes/no labels for the boolean `has_api_docs` facet. */
  protected booleanLabelsFor(attribute: string): readonly [string, string] | null {
    if (attribute !== 'has_api_docs') return null;
    return [$localize`:@@search.facet.yes:Yes`, $localize`:@@search.facet.no:No`];
  }

  private initialTab(): EntityTab {
    const raw = this.route.snapshot.queryParamMap.get('tab');
    return raw === 'vendors' || raw === 'integrations' ? raw : 'products';
  }

  private scheduleUrlSync(value: string): void {
    if (this.urlSyncTimer) clearTimeout(this.urlSyncTimer);
    this.urlSyncTimer = setTimeout(() => {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { q: value || null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    }, URL_SYNC_DEBOUNCE_MS);
  }
}
