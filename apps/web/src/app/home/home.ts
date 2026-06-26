import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import type { HomeStatsResponse, TaxonomyResponse } from '@aeci/shared';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { TOP_N, byDisplayOrder, topByCount } from '../core/taxonomy/taxonomy-rank';

import { BrowseGrid } from './browse-grid';
import { HomeCredibilityStrip } from './home-credibility-strip';
import { HomeDifferentiation } from './home-differentiation';
import { HomeHero } from './home-hero';
import { HomeHowItWorks } from './home-how-it-works';
import { HomeStatsCards } from './home-stats-cards';
import { RecentIntegrationsSection } from './recent-integrations-section';
import { TrendingProductsSection } from './trending-products-section';

/**
 * Home page (`/`). Phase 4.11 (AECI-186) is the final assembly, kept in the §4.1
 * order (as revised by AECI-270) — hero → credibility strip (AECI-271) → what's
 * different (`home-differentiation`, AECI-273) → how it works (`home-how-it-works`,
 * AECI-273) → three stats cards → "Browse by" grids → recently-added integrations →
 * trending products (the footer lives in the app shell) — and owns the home SEO
 * (meta + OG/Twitter + `WebSite`/`Organization` JSON-LD + canonical, set in the
 * constructor since the copy is static). §4.1 section 3 (why / the problem) is the
 * remaining unbuilt AECI-269 child; it slots between the credibility strip and the
 * what's-different band. (The standalone "Trust is the product" band —
 * `home-trust-pillars` — is now only on `/about`; the home folds that promise into
 * the differentiation band's closing line.)
 *
 * Two parallel resolvers feed the page (both SSR-resolved via the service
 * binding, hydrated from TransferState):
 *   - `browse` (`homeBrowseResolver`) — the **live** aggregate taxonomy
 *     (`GET /api/taxonomy`) for the "Browse by" grids, ranked by `product_count`.
 *   - `stats` (`homeStatsResolver`) — the daily `stats_cache` snapshot
 *     (`GET /api/stats/home`) for the stats cards + recently-added + trending.
 *
 * Both are null-safe: a null resolver result collapses each section to its
 * first-class empty state (`?? 0` / `?? null` / `?? []`), so the page renders
 * cleanly against a sparse pre-launch cache. The hero owns the page `<h1>`; every
 * section below renders an `<h2>`, so the heading order stays valid and axe-clean.
 *
 * Caching is unchanged from 4.9: the route is cacheable + visitor-state-neutral
 * (no cookie/theme read) and carries `Cache-Tag: route:index,taxonomy` with the
 * §4 home TTL (`s-maxage=900`) from `cacheTagInputsForPath('/')`. The daily
 * snapshot needs no extra purge handle — the 900s edge TTL bounds staleness.
 */
@Component({
  selector: 'app-home',
  imports: [
    HomeHero,
    HomeCredibilityStrip,
    HomeDifferentiation,
    HomeHowItWorks,
    HomeStatsCards,
    BrowseGrid,
    RecentIntegrationsSection,
    TrendingProductsSection,
  ],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <aec-home-hero />

      <!-- Credibility strip (§4.1 section 2): slim full-bleed proof bar, coverage
           counts + the "independent · no pay-for-placement" promise (AECI-271). -->
      <aec-home-credibility-strip
        [totalProducts]="totalProducts()"
        [totalVendors]="totalVendors()"
        [totalIntegrations]="totalIntegrations()"
        [totalReviews]="totalReviews()"
      />

      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
        <div class="flex flex-col gap-10 md:gap-12">
          <!-- §4.1 section 3 (why / the problem) slots here when its child ships. -->

          <!-- §4.1 section 4 (what's different): the reconciled three ideas plus
               the absorbed trust line (AECI-273). -->
          <aec-home-differentiation />

          <!-- §4.1 section 5 (how it works): the operating model (AECI-273). -->
          <aec-home-how-it-works />

          <aec-home-stats-cards
            [totalIntegrations]="totalIntegrations()"
            [integrationsAdded30d]="integrationsAdded30d()"
            [mostIntegratedProduct]="mostIntegratedProduct()"
            [mostActiveCategory]="mostActiveCategory()"
          />

          <app-browse-grid kind="category" [terms]="topCategories()" />
          <app-browse-grid kind="audience" [terms]="topAudiences()" />
          <app-browse-grid kind="phase" [terms]="allPhases()" />

          <aec-recent-integrations-section [integrations]="recentIntegrations()" />
          <aec-trending-products-section
            [products]="trendingProducts()"
            [recentlyAdded]="recentlyAddedProducts()"
          />
        </div>
      </div>
    </div>
  `,
})
export class Home {
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(MetaService);

  private readonly browse = toSignal<TaxonomyResponse | null, TaxonomyResponse | null>(
    this.route.data.pipe(map((d) => (d['browse'] ?? null) as TaxonomyResponse | null)),
    { initialValue: (this.route.snapshot.data['browse'] ?? null) as TaxonomyResponse | null },
  );

  private readonly stats = toSignal<HomeStatsResponse | null, HomeStatsResponse | null>(
    this.route.data.pipe(map((d) => (d['stats'] ?? null) as HomeStatsResponse | null)),
    { initialValue: (this.route.snapshot.data['stats'] ?? null) as HomeStatsResponse | null },
  );

  protected readonly topCategories = computed(() => topByCount(this.browse()?.categories, TOP_N));
  protected readonly topAudiences = computed(() => topByCount(this.browse()?.audiences, TOP_N));
  /** Phases is a small facet — show every term in project-lifecycle order (`display_order`). */
  protected readonly allPhases = computed(() => byDisplayOrder(this.browse()?.phases));

  // Stats-section inputs. A null resolver result (a render mode without
  // REQUEST_CONTEXT, or a failed client fetch) collapses to each section's
  // empty state (`0` suppresses the figure / delta, `null` renders the non-link
  // card, `[]` renders the bordered empty note or the trending→recently-added
  // fallback).
  protected readonly totalIntegrations = computed(() => this.stats()?.total_integrations ?? 0);
  protected readonly integrationsAdded30d = computed(
    () => this.stats()?.integrations_added_30d ?? 0,
  );
  // Credibility-strip coverage counts (AECI-271). Null-safe like the rest: a
  // sparse cache / null resolver collapses each to `0`, which the strip suppresses.
  protected readonly totalProducts = computed(() => this.stats()?.total_products ?? 0);
  protected readonly totalVendors = computed(() => this.stats()?.total_vendors ?? 0);
  protected readonly totalReviews = computed(() => this.stats()?.total_reviews ?? 0);
  protected readonly mostIntegratedProduct = computed(
    () => this.stats()?.most_integrated_product ?? null,
  );
  protected readonly mostActiveCategory = computed(
    () => this.stats()?.most_active_category ?? null,
  );
  protected readonly recentIntegrations = computed(() => this.stats()?.recent_integrations ?? []);
  protected readonly trendingProducts = computed(() => this.stats()?.trending_products ?? []);
  protected readonly recentlyAddedProducts = computed(
    () => this.stats()?.recently_added_products ?? [],
  );

  constructor() {
    // Static home meta + WebSite/Organization JSON-LD + canonical. Set from the
    // constructor (like `setSearchMeta`) so it ships in the SSR HTML head AND
    // refreshes on an in-app navigation onto `/`.
    this.meta.setHomeMeta({ canonical: canonicalUrl('/') });
  }
}
