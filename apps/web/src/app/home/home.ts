import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import type { HomeStatsResponse, TaxonomyResponse } from '@aeci/shared';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { TOP_N, byDisplayOrder, topByCount } from '../core/taxonomy/taxonomy-rank';

import { HomeBrowseBlock } from './home-browse-block';
import { HomeClosingCta } from './home-closing-cta';
import { HomeCredibilityStrip } from './home-credibility-strip';
import { HomeDifferentiation } from './home-differentiation';
import { HomeHero } from './home-hero';
import { HomeHowItWorks } from './home-how-it-works';
import { HomeWhy } from './home-why';
import { RecentIntegrationsSection } from './recent-integrations-section';
import { TrendingProductsSection } from './trending-products-section';

/**
 * Home page (`/`). Directory first, then the argument. Five bands, top to bottom:
 *
 *   1. Hero band (Bone): the hero, then the credibility row as the last row
 *      inside the same Bone ground.
 *   2. Browse (white): `HomeBrowseBlock`, one section with three chip rows
 *      (category, project phase, audience).
 *   3. Directory activity (white): recently added integrations, then trending
 *      products.
 *   4. The argument (white): why, what's different, how it works.
 *   5. Closing CTA (Bone): mailing list signup and suggest-a-tool.
 *
 * The footer lives in the app shell.
 *
 * **Grounds.** Two only. Bone (`--accent-warm`) frames the page: the hero band
 * and the closing CTA. Everything between them is white (`--surface-base`), and
 * white bands are separated by a hairline `border-t` plus their own spacing and
 * headings. Cards on the home use one recipe: white fill, a 1px
 * `--border-default` border, `--radius-lg`. The section components are
 * background-agnostic bare `<section>`s; the band wrapper (ground, `max-w-7xl`,
 * vertical rhythm) lives here.
 *
 * Two parallel resolvers feed the page (both SSR-resolved via the service
 * binding, hydrated from TransferState):
 *   - `browse` (`homeBrowseResolver`): the live aggregate taxonomy
 *     (`GET /api/taxonomy`) for the browse block, ranked by `product_count`.
 *   - `stats` (`homeStatsResolver`): the daily `stats_cache` snapshot
 *     (`GET /api/stats/home`) for the credibility row, recently added, and
 *     trending.
 *
 * Both are null-safe: a null resolver result collapses each section to its
 * empty state (`?? 0` / `?? []`), so the page renders cleanly against a sparse
 * cache. The hero owns the page `<h1>`; every section below renders an `<h2>`,
 * so the heading order stays valid.
 *
 * The page owns the home SEO (meta, OG/Twitter, `WebSite`/`Organization` JSON-LD,
 * canonical), set in the constructor since the copy is static.
 *
 * Caching: the route is cacheable and visitor-state-neutral (no cookie or theme
 * read). It carries `Cache-Tag: route:index,index:home,taxonomy` with the home
 * TTL (`s-maxage=900`) from `cacheTagInputsForPath('/')`. The daily snapshot
 * needs no extra purge handle; the 900s edge TTL bounds staleness.
 */
@Component({
  selector: 'app-home',
  imports: [
    HomeHero,
    HomeCredibilityStrip,
    HomeBrowseBlock,
    RecentIntegrationsSection,
    TrendingProductsSection,
    HomeWhy,
    HomeDifferentiation,
    HomeHowItWorks,
    HomeClosingCta,
  ],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1. Hero band (Bone): the hero, closed by the credibility row. -->
      <div class="border-b border-(--border-default) bg-(--accent-warm)">
        <aec-home-hero />
        <aec-home-credibility-strip
          [totalProducts]="totalProducts()"
          [totalVendors]="totalVendors()"
          [totalIntegrations]="totalIntegrations()"
          [totalReviews]="totalReviews()"
          [totalContributingFirms]="totalContributingFirms()"
        />
      </div>

      <!-- 2. Browse (white): one block, three chip rows. -->
      <div class="bg-(--surface-base)">
        <div class="mx-auto w-full max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <aec-home-browse-block
            [categories]="topCategories()"
            [phases]="allPhases()"
            [audiences]="audienceTerms()"
          />
        </div>
      </div>

      <!-- 3. Directory activity (white): recently added, then trending. -->
      <div class="border-t border-(--border-default) bg-(--surface-base)">
        <div class="mx-auto w-full max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <div class="flex flex-col gap-12 md:gap-16">
            <aec-recent-integrations-section [integrations]="recentIntegrations()" />
            <aec-trending-products-section
              [products]="trendingProducts()"
              [recentlyAdded]="recentlyAddedProducts()"
            />
          </div>
        </div>
      </div>

      <!-- 4. The argument (white): why, what's different, how it works. -->
      <div class="border-t border-(--border-default) bg-(--surface-base)">
        <div class="mx-auto w-full max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <div class="flex flex-col gap-12 md:gap-16">
            <aec-home-why />
            <aec-home-differentiation />
            <aec-home-how-it-works />
          </div>
        </div>
      </div>

      <!-- 5. Closing CTA (Bone), directly above the app-shell footer. -->
      <aec-home-closing-cta />
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
  /** Phases is a small facet: show every term in project-lifecycle order (`display_order`). */
  protected readonly allPhases = computed(() => byDisplayOrder(this.browse()?.phases));
  /**
   * The full live audience vocabulary. The browse block shows a curated role list
   * and looks up each role's `product_count` here.
   */
  protected readonly audienceTerms = computed(() => this.browse()?.audiences ?? []);

  // Stats inputs. A null resolver result (a render mode without REQUEST_CONTEXT,
  // or a failed client fetch) collapses to each section's empty state (`0`
  // suppresses a credibility figure, `[]` renders the bordered empty note or the
  // trending to recently-added fallback).
  protected readonly totalIntegrations = computed(() => this.stats()?.total_integrations ?? 0);
  protected readonly totalProducts = computed(() => this.stats()?.total_products ?? 0);
  protected readonly totalVendors = computed(() => this.stats()?.total_vendors ?? 0);
  protected readonly totalReviews = computed(() => this.stats()?.total_reviews ?? 0);
  protected readonly totalContributingFirms = computed(
    () => this.stats()?.total_contributing_firms ?? 0,
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
