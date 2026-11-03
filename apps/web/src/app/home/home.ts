import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

import { isPublishedTrade, type HomeStatsResponse, type TaxonomyResponse } from '@aeci/shared';

import { canonicalUrl } from '../core/canonical';
import { MetaService } from '../core/meta.service';
import { TOP_N, byDisplayOrder, topByCount } from '../core/taxonomy/taxonomy-rank';

import { HomeBrowseBlock } from './home-browse-block';
import { HomeClosingCta } from './home-closing-cta';
import { HomeCredibilityStrip } from './home-credibility-strip';
import { HomeHero } from './home-hero';
import { HomeWhy } from './home-why';

/**
 * Home page (`/`). Directory first, then the argument. Four bands, top to bottom:
 *
 *   1. Hero band (Bone): the hero (search, the "Popular:" product row, the pair
 *      finder), then the credibility row as the last row inside the same Bone
 *      ground.
 *   2. Browse (white): `HomeBrowseBlock`, one section with four chip rows
 *      (category, trade, project phase, audience).
 *   3. The argument (white): one evidence band (`HomeWhy`): the problem, three
 *      cited figures, and what we do instead.
 *   4. Closing CTA (Bone): the vendor call to action and suggest-a-tool.
 *
 * The footer lives in the app shell.
 *
 * **Grounds.** Two only. Bone (`--accent-warm`) frames the page: the hero band
 * and the closing CTA. Everything between them is white (`--surface-base`), and
 * white bands are separated by a hairline `border-t` plus their own spacing and
 * headings. Cards on the home use one recipe: white fill, a 1px
 * `--border-default` border, `--radius-lg`. The section components are
 * background-agnostic bare `<section>`s; the band wrapper (ground, `max-w-7xl`, vertical rhythm) lives here.
 *
 * Two parallel resolvers feed the page (both SSR-resolved via the service
 * binding, hydrated from TransferState):
 *   - `browse` (`homeBrowseResolver`): the live aggregate taxonomy
 *     (`GET /api/taxonomy`) for the browse block, ranked by `product_count`.
 *   - `stats` (`homeStatsResolver`): the nightly `stats_cache` snapshot
 *     (`GET /api/stats/home`) for the credibility row and the hero's "Popular:"
 *     row (`popular_products`, most viewed over 30 days).
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
  imports: [HomeHero, HomeCredibilityStrip, HomeBrowseBlock, HomeWhy, HomeClosingCta],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <!-- 1. Hero band (Bone): the hero, closed by the credibility row. -->
      <div class="border-b border-(--border-default) bg-(--accent-warm)">
        <aec-home-hero [popularProducts]="popularProducts()" />
        <aec-home-credibility-strip
          [totalProducts]="totalProducts()"
          [totalVendors]="totalVendors()"
          [totalIntegrations]="totalIntegrations()"
          [totalReviews]="totalReviews()"
          [totalContributingFirms]="totalContributingFirms()"
          [integrationsAdded30d]="integrationsAdded30d()"
        />
      </div>

      <!-- 2. Browse (white): one block, four chip rows. -->
      <div class="bg-(--surface-base)">
        <div class="mx-auto w-full max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <aec-home-browse-block
            [categories]="topCategories()"
            [trades]="topTrades()"
            [phases]="allPhases()"
            [audiences]="audienceTerms()"
          />
        </div>
      </div>

      <!-- 3. The argument (white): one evidence band. -->
      <div class="border-t border-(--border-default) bg-(--surface-base)">
        <div class="mx-auto w-full max-w-7xl px-6 py-16 md:px-8 md:py-20">
          <aec-home-why />
        </div>
      </div>

      <!-- 4. Closing CTA (Bone), directly above the app-shell footer. -->
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
  // suppresses a credibility figure, `[]` sends the hero's "Popular:" row to its category fallback).
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
