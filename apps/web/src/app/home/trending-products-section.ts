import { Component, computed, input } from '@angular/core';

import type { ProductListItem } from '@aeci/shared';

import { ProductCardGrid } from '../products/product-card-grid';

type TrendingMode = 'trending' | 'recently-added' | 'empty';

/**
 * AECI-185 (Phase 4.10) — the home "Trending products this week" module: the top
 * 5 by `page_views` (`trending_products` from `HomeStatsResponse`), rendered on
 * the shipped `ProductCardGrid` broken grid (the home's single reuse of the
 * catalog's signature grid, per `docs/design/home-direction.md`). Presentational
 * only — the 4.11 assembly issue (AECI-186) wires the resolver.
 *
 * Trending is `page_views`-based in Stage 1 (PostHog deferred to Phase 7), so
 * pre-launch it is expected-empty. Rather than show a dead module, an empty
 * `trending_products` **falls back to `recently_added_products`** (Chris's call on
 * AECI-185) with a truthful "Recently added products" heading + the grid's default
 * "Recently added" eyebrow — we never label recently-added products "trending".
 * Only when *both* lists are empty do we render the bordered note. The fallback is
 * capped at 5 to match the trending slot's footprint.
 *
 * `featuredLead` is gated to `> 1` item so a single product never renders as a
 * lone wide card on the Bone band. Both themes via tokens; no explicit OnPush
 * (Angular v22 default, AECI-125).
 */
@Component({
  selector: 'aec-trending-products-section',
  imports: [ProductCardGrid],
  template: `
    <section>
      <h2 class="font-display text-2xl font-semibold tracking-tight text-(--text-primary)">
        @switch (mode()) {
          @case ('recently-added') {
            <ng-container i18n="@@home.trending.fallbackHeading"
              >Recently added products</ng-container
            >
          }
          @default {
            <ng-container i18n="@@home.trending.heading">Trending products this week</ng-container>
          }
        }
      </h2>

      @switch (mode()) {
        @case ('empty') {
          <p
            class="mt-4 rounded-(--radius-lg) border border-dashed border-(--border-default)
              bg-(--surface-sunken) p-6 text-center text-sm text-(--text-secondary)"
            i18n="@@home.trending.empty"
          >
            Trending lands once we have product view data.
          </p>
        }
        @default {
          <aec-product-card-grid
            class="mt-4 block"
            [products]="display()"
            [featuredLead]="display().length > 1"
            [featuredEyebrow]="mode() === 'trending' ? 'trending' : 'recently-added'"
          />
        }
      }
    </section>
  `,
})
export class TrendingProductsSection {
  /** Top 5 by `page_views` (already ≤5 from the cache). */
  readonly products = input.required<readonly ProductListItem[]>();
  /** Fallback when trending is empty: last products added (≤10 from the cache). */
  readonly recentlyAdded = input<readonly ProductListItem[]>([]);

  protected readonly mode = computed<TrendingMode>(() =>
    this.products().length ? 'trending' : this.recentlyAdded().length ? 'recently-added' : 'empty',
  );

  /** The list actually rendered: trending as-is, or the fallback capped at 5. */
  protected readonly display = computed<readonly ProductListItem[]>(() =>
    this.mode() === 'trending' ? this.products() : this.recentlyAdded().slice(0, 5),
  );
}
