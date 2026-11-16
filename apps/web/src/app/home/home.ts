import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import { isPublishedTrade, type HomeStatsResponse, type TaxonomyResponse } from '@aeci/shared';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { TOP_N, byDisplayOrder, topByCount } from '../core/taxonomy/taxonomy-rank';

import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { BoneBand } from '../shared/bone-band/bone-band';

import { HomeBrowseBlock } from './home-browse-block';
import { HomeClosingCta } from './home-closing-cta';
import { HomeCredibilityStrip } from './home-credibility-strip';
import { HomeHero } from './home-hero';
import { HomeWhy } from './home-why';

/**
 * Home page (`/`). Directory first, then the argument. Four bands, top to bottom,
 * built on mock-up 9 (AECI-1789, AECI-1792):
 *
 *   1. Hero band: the page's one Bone band (`aec-bone-band`). The hero (search,
 *      the "Most viewed" row, the pair finder card), then the credibility row as
 *      the band's last row.
 *   2. Browse (white): `HomeBrowseBlock`, one section with four chip rows
 *      (category, trade, project phase, audience). Each row states its order.
 *   3. The argument (white): `HomeWhy`. The problem, three cited figures, and
 *      "What we do instead" as the page's one Forest feature card.
 *   4. Closing CTA (white): `HomeClosingCta`, one card with two panes.
 *
 * The footer lives in the app shell.
 *
 * **Grounds.** One Bone band, the hero (DESIGN.md §2, clash 2). Every other band
 * is white, and two white bands are split by a hairline `border-t`. Every band's
 * content sits on the 1328px page wrap (`BAND_WRAP_CLASS`). White bands take
 * 96px above and below, 64px below `md`. The section components are bare
 * `<section>`s. This file owns the band wrappers.
 *
 * Two parallel resolvers feed the page (both SSR-resolved via the service
 * binding, hydrated from TransferState):
 *   - `browse` (`homeBrowseResolver`): the live aggregate taxonomy
 *     (`GET /api/taxonomy`) for the browse block, ranked by `product_count`. Its
 *     top five categories are also the hero's "Largest categories" fallback.
 *   - `stats` (`homeStatsResolver`): the nightly `stats_cache` snapshot
 *     (`GET /api/stats/home`) for the credibility row and the hero's "Most
 *     viewed" row (`popular_products`, most viewed over 30 days).
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
 * needs no extra purge handle; the 900s edge TTL bounds staleness. Both hero
 * rows come from resolver data, so the row is in the cached HTML and the
 * `taxonomy` tag purges the category fallback with the browse block.
 */
@Component({
  selector: 'app-home',
  imports: [BoneBand, HomeHero, HomeCredibilityStrip, HomeBrowseBlock, HomeWhy, HomeClosingCta],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1. Hero band: the page's one Bone band, closed by the credibility row. -->
      <aec-bone-band flushEnd>
        <aec-home-hero
          [popularProducts]="popularProducts()"
          [largestCategories]="largestCategories()"
        />
        <aec-home-credibility-strip
          [totalProducts]="totalProducts()"
          [totalVendors]="totalVendors()"
          [totalIntegrations]="totalIntegrations()"
          [totalReviews]="totalReviews()"
          [totalContributingFirms]="totalContributingFirms()"
          [integrationsAdded30d]="integrationsAdded30d()"
        />
      </aec-bone-band>

      <!-- 2. Browse (white): one block, four chip rows. -->
      <div class="py-16 md:py-24">
        <div [class]="wrap">
          <aec-home-browse-block
            [categories]="topCategories()"
            [trades]="topTrades()"
            [phases]="allPhases()"
            [audiences]="audienceTerms()"
          />
        </div>
      </div>

      <!-- 3. The argument (white): figures, then the Forest feature card. -->
      <div class="border-t py-16 md:py-24">
        <div [class]="wrap">
          <aec-home-why />
        </div>
      </div>

      <!-- 4. Closing CTA (white), directly above the app-shell footer. -->
      <div class="border-t py-16 md:py-24">
        <div [class]="wrap">
          <aec-home-closing-cta />
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

  protected readonly wrap = BAND_WRAP_CLASS;

  protected readonly topCategories = computed(() => topByCount(this.browse()?.categories, TOP_N));
  /**
   * The hero's fallback row: the five largest categories, the head of the same
   * ranked list the browse block shows. Resolver data, so it is in the SSR HTML.
   */
  protected readonly largestCategories = computed(() => this.topCategories().slice(0, 5));
  /**
   * Trades are the one facet with a publication floor (`TRADES_VOCABULARY.md`
   * §6): a trade below it has no `/trades/:slug` page worth linking, so drop it
   * before ranking. At the floor of 1 this also hides every zero-count trade.
   */
  protected readonly topTrades = computed(() =>
    topByCount(this.browse()?.trades?.filter(isPublishedTrade), TOP_N),
  );
  /** Phases is a small facet: show every term in project-lifecycle order (`display_order`). */
  protected readonly allPhases = computed(() => byDisplayOrder(this.browse()?.phases));
  /**
   * The full live audience vocabulary. The browse block shows a curated role list
   * and looks up each role's `product_count` here.
   */
  protected readonly audienceTerms = computed(() => this.browse()?.audiences ?? []);

  // Stats inputs. A null resolver result (a render mode without REQUEST_CONTEXT,
  // or a failed client fetch) collapses to each section's empty state (`0`
  // suppresses a credibility figure, `[]` sends the hero's "Most viewed" row to its category fallback).
  protected readonly totalIntegrations = computed(() => this.stats()?.total_integrations ?? 0);
  protected readonly totalProducts = computed(() => this.stats()?.total_products ?? 0);
  protected readonly totalVendors = computed(() => this.stats()?.total_vendors ?? 0);
  protected readonly totalReviews = computed(() => this.stats()?.total_reviews ?? 0);
  protected readonly totalContributingFirms = computed(
    () => this.stats()?.total_contributing_firms ?? 0,
  );
  protected readonly integrationsAdded30d = computed(
    () => this.stats()?.integrations_added_30d ?? 0,
  );
  protected readonly popularProducts = computed(() => this.stats()?.popular_products ?? []);

  constructor() {
    // Static home meta + WebSite/Organization JSON-LD + canonical. Set from the
    // constructor (like `setSearchMeta`) so it ships in the SSR HTML head AND
    // refreshes on an in-app navigation onto `/`.
    this.meta.setHomeMeta({ canonical: canonicalUrl('/') });
  }
}
