import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import {
  type CategoriesListResponse,
  type TaxonomyTermWithCount,
  isPublishedTrade,
  taxonomyIntegrationCount,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import { BROWSE_HEADER_CLASS } from '../layouts/browse-header';
import { BrowseLayout } from '../layouts/browse-layout';
import { AecCard, CARD_GRID_CLASS } from '../shared/card/card';
import { EmptyState } from '../shared/empty-state/empty-state';
import {
  ListingSortSelect,
  type ListingSortOption,
} from '../shared/listing-toolbar/listing-sort-select';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';
import { AecBreadcrumb, homeCrumb, type BreadcrumbItem } from '../shared/breadcrumb/breadcrumb';

/**
 * How the term grid is ordered.
 *
 * `sequence` is the API's own order (`display_order ASC, name ASC`; audiences
 * ship A to Z by name instead, AECI-1243) and is
 * offered on **`/phases` only**, where the vocabulary genuinely *is* a sequence:
 * Concept & Planning → Design → Pre-Construction → Construction → Closeout &
 * Operations. Sorting those alphabetically as the default would scramble meaning
 * the terms carry, so there it is both an option and the default.
 *
 * The other three facets do **not** expose it. Their `display_order` is an
 * editorial convenience rather than information the reader needs, and a term
 * grid answers "is my thing in here?" — a question A→Z answers better than any
 * curated sequence. For categories and trades, `display_order` still sets the
 * API's list order that other surfaces render (the facet sidebar, the vendor
 * facet editor). Audiences never follow it: the API ships them A to Z by name
 * (AECI-1242, AECI-1243). The nav flyouts and home grids rank by product count.
 */
type SortMode = 'sequence' | 'name' | 'products';

/**
 * The modes each facet offers, in display order. The **first entry is that
 * facet's default**, which is what SSR renders — so `/phases` server-renders its
 * curated sequence and the other three server-render A→Z.
 */
const SORT_MODES_BY_KIND: Record<TaxonomyKind, readonly SortMode[]> = {
  phase: ['sequence', 'name', 'products'],
  category: ['name', 'products'],
  audience: ['name', 'products'],
  trade: ['name', 'products'],
};

/**
 * AECI-157 / AECI-544 — shared flat index for `/categories`, `/audiences`,
 * `/phases`, and `/trades`. One component drives all four routes; the facet
 * `kind` arrives via static `route.data` and the resolved list via
 * `route.data['terms']` (populated by the matching `*IndexResolver`).
 * Generalizes the original AECI-61 `/categories` page so the four facets share
 * one template, mirroring `TaxonomyBrowsePage`.
 *
 * Every term renders as a card (`aecCard`, at most three columns) whose title
 * links to its `/{segment}/:slug` browse page (AECI-1795, mock-up 10). Still not
 * a sortable *table* (cf. `/products`) — the taxonomy is small (≈30 terms) and
 * reads better as cards — but the card grid does carry the shared sort control
 * (`SortMode`), on all four facets because all four routes are this component. The option set is per-facet (`SORT_MODES_BY_KIND`): `/phases` gets
 * `sequence / name / products` and defaults to its curated sequence; the other
 * three get `name / products` and default to A→Z.
 * Generic chrome uses shared `@@taxonomy.index.*` ids; the facet-specific copy
 * (title / lede / empty) is a per-kind `$localize` switch, the same pattern
 * `TaxonomyBrowsePage` uses for its breadcrumb labels. Cache discipline:
 * `cacheTagInputsForPath` emits `route:index`, `index:{segment}`, `taxonomy`;
 * nothing here triggers HTTP, and the sort adds none — it reorders data the
 * resolver already delivered (see `sorted()` for why it is not a query param).
 */
@Component({
  selector: 'aec-taxonomy-index',
  imports: [
    AecBreadcrumb,
    AecCard,
    BrowseLayout,
    EmptyState,
    ListingSortSelect,
    MailingListSignup,
    RouterLink,
  ],
  template: `
    <!-- Mock-up 10, the taxonomy index (AECI-1795): the browse shell's white
         header and wrap, with no filter rail. -->
    <aec-browse-layout [filters]="false">
      <div slot="header">
        <aec-breadcrumb [items]="crumbs()" />
        <h1 [class]="headerClass.title">{{ title() }}</h1>
        <p [class]="headerClass.lede">{{ lede() }}</p>
      </div>

      <div slot="grid">
        @if (terms().length > 0) {
          <!-- The shared sort control (ruling 7 of 2026-11-16). Same orders and
               the same default per facet as the buttons it replaced. -->
          <aec-listing-sort-select
            [options]="sortOptions()"
            [value]="sort()"
            (sortChange)="onSortChange($event)"
          />

          <ul role="list" class="mt-6" [class]="gridClass">
            @for (term of terms(); track term.id) {
              <li class="group/card flex min-w-0">
                <div aecCard interactive class="flex w-full flex-col p-6">
                  <!-- One link, on the title, stretched over the card (the card
                       recipe). The size sits on the span, because the unlayered
                       h2 rule beats a size utility on the h2 itself. -->
                  <h2>
                    <a
                      [routerLink]="[basePath(), term.slug]"
                      class="text-(--text-primary) no-underline transition-colors after:absolute after:inset-0 after:rounded-card group-hover/card:text-(--accent-primary) focus-visible:outline-0"
                      ><span class="text-t-20 leading-tight">{{ term.name }}</span></a
                    >
                  </h2>
                  @if (term.description) {
                    <p
                      class="mt-2 line-clamp-3 flex-1 text-t-14 leading-relaxed text-(--text-secondary)"
                    >
                      {{ term.description }}
                    </p>
                  }
                  <!-- Both counts: one of them is a sort key. See the note on
                       integrationCountLabel(). -->
                  <p class="mt-4 text-t-13 text-(--text-secondary) tabular-nums">
                    {{ countLabel(term.product_count) }}
                    @if (term.integration_count !== undefined) {
                      <span aria-hidden="true" class="mx-1.5">·</span>
                      {{ integrationCountLabel(term.integration_count) }}
                    }
                  </p>
                </div>
              </li>
            }
          </ul>
        } @else {
          <aec-empty-state>
            <p>{{ emptyLabel() }}</p>
          </aec-empty-state>
        }
      </div>
    </aec-browse-layout>

    <aec-mailing-list-signup />
  `,
})
export class TaxonomyIndexPage {
  protected readonly crumbs = computed<BreadcrumbItem[]>(() => [
    homeCrumb(),
    { label: this.title() },
  ]);

  private readonly route = inject(ActivatedRoute);

  /** Facet kind for this route — static `data: { kind }` in `app.routes.ts`. */
  protected readonly kind = computed<TaxonomyKind>(
    () => this.route.snapshot.data['kind'] as TaxonomyKind,
  );

  protected readonly basePath = computed(() => `/${KIND_PATH_SEGMENT[this.kind()]}`);

  private readonly response = toSignal<
    CategoriesListResponse | null,
    CategoriesListResponse | null
  >(this.route.data.pipe(map((d) => (d['terms'] ?? null) as CategoriesListResponse | null)), {
    initialValue: (this.route.snapshot.data['terms'] ?? null) as CategoriesListResponse | null,
  });

  /**
   * Terms to render. Trades are the one facet with a **publication floor**
   * (`TRADE_PUBLISH_MIN_PRODUCTS`, TRADES_VOCABULARY.md §6): the vocabulary is a
   * closed 34-term list seeded up front, so without the floor this grid would
   * ship dozens of "0 products" cards as SEO junk. The API returns every term
   * with its real count and each surface applies the floor — omitting sub-floor
   * terms entirely rather than greying them out, since a card that can't be
   * usefully clicked is noise. Their `/trades/:slug` URLs still resolve, so a
   * term crossing the floor becomes listed with no redirect.
   */
  protected readonly terms = computed<ReadonlyArray<TaxonomyTermWithCount>>(() => {
    const all = this.response()?.data ?? [];
    const published = this.kind() === 'trade' ? all.filter(isPublishedTrade) : all;
    return this.sorted(published);
  });

  // ── Sorting ────────────────────────────────────────────────────────────────

  protected readonly sortModes = computed(() => SORT_MODES_BY_KIND[this.kind()]);

  /**
   * The reader's explicit choice, or `null` while they have not made one.
   *
   * Held separately from the resolved `sort()` rather than seeding a signal with
   * the default, because the default depends on `kind()` — which arrives from
   * route data, not from the constructor. Deriving it keeps the two facets'
   * different defaults correct without an `effect` writing a signal.
   */
  private readonly explicitSort = signal<SortMode | null>(null);
  protected readonly sort = computed<SortMode>(
    () => this.explicitSort() ?? (this.sortModes()[0] as SortMode),
  );

  /**
   * The control is the shared listing sort control, `aec-listing-sort-select`
   * (ruling 7 of 2026-11-16, AECI-1795). Until then it was a row of
   * `aria-pressed` buttons labelled "Sequence", "A → Z" and "Products". The
   * modes, their order and each facet's default did not change. Only the
   * control and its labels did. It renders only when there is a grid to
   * reorder: a sort control over an empty list is furniture, not function.
   *
   * The control hands back an option `value`. Anything that is not one of this
   * facet's modes is ignored.
   */
  protected onSortChange(value: string): void {
    const mode = this.sortModes().find((m) => m === value);
    if (mode) this.explicitSort.set(mode);
  }

  /** The control's options, in this facet's mode order, with their labels. */
  protected readonly sortOptions = computed<readonly ListingSortOption[]>(() =>
    this.sortModes().map((mode) => ({ value: mode, label: this.sortOptionLabel(mode) })),
  );

  protected readonly headerClass = BROWSE_HEADER_CLASS;
  /** One column, two from `md`, three from `lg`, never more (clash 18). */
  protected readonly gridClass = CARD_GRID_CLASS;

  /**
   * Reorder a term list for the active mode.
   *
   * **Deliberately client-side, and deliberately not a query parameter.** The
   * whole vocabulary is already resolved in `route.data` (~30 terms, no HTTP),
   * so sorting is free here. Putting the mode in the URL would fork the edge
   * cache key per facet for a preference that is presentational — see the
   * visitor-state-neutral rule in CLAUDE.md. SSR emits each facet's default
   * (`sequence` for phases, `name` for the rest) and `explicitSort` only ever
   * moves on a click, so there is no hydration divergence to have. Both defaults
   * are deterministic on either runtime, which is what makes that safe.
   *
   * Every comparator is a **total order** — each falls through to `name`, and
   * `name` is unique per facet — so a re-sort can never depend on the incoming
   * array order and repeated sorts are idempotent. Ordering goes through the
   * shared `compareText` collator (`@aeci/shared/text-sort`), which pins the
   * locale to `'en'` rather than taking the ambient one: the app is en-US only at
   * launch, and an unpinned collation could order differently under the SSR
   * Worker than in the browser — which for the three A→Z-by-default facets would
   * be a server/client mismatch, not merely a cosmetic difference. That rule
   * started here and is now the whole app's (AECI-825).
   */
  private sorted(
    terms: ReadonlyArray<TaxonomyTermWithCount>,
  ): ReadonlyArray<TaxonomyTermWithCount> {
    const byName = (a: TaxonomyTermWithCount, b: TaxonomyTermWithCount) =>
      compareText(a.name, b.name);

    switch (this.sort()) {
      case 'sequence':
        // The API's order (`display_order ASC, name ASC`) — already sorted, so
        // this returns the list untouched rather than re-deriving it.
        return terms;
      case 'name':
        return [...terms].sort(byName);
      case 'products':
        // Integrations break a product-count tie: among terms carrying the same
        // number of products, the better-integrated one is the more useful page.
        // It is only a tiebreaker, though — integration count is a downstream
        // consequence of the catalog rather than a measure of the term itself,
        // so it does not get to set the primary order.
        return [...terms].sort(
          (a, b) =>
            b.product_count - a.product_count ||
            taxonomyIntegrationCount(b) - taxonomyIntegrationCount(a) ||
            byName(a, b),
        );
    }
  }

  /** Facet-specific page title (also the breadcrumb current label). */
  protected readonly title = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@categories.index.title:Categories`;
      case 'audience':
        return $localize`:@@audiences.index.title:Audiences`;
      case 'phase':
        return $localize`:@@phases.index.title:Phases`;
      case 'trade':
        return $localize`:@@trades.index.title:Trades`;
    }
  });

  protected readonly lede = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@categories.index.lede:Browse AEC software by category. Each links to the products tagged with it.`;
      case 'audience':
        return $localize`:@@audiences.index.lede:Browse AEC software by audience: the disciplines and roles each tool serves.`;
      case 'phase':
        return $localize`:@@phases.index.lede:Browse AEC software by project phase, from design through closeout.`;
      case 'trade':
        return $localize`:@@trades.index.lede:Browse software built for the work your company actually sells. Only tools with trade-specific value are listed; horizontal platforms aren't.`;
    }
  });

  protected readonly emptyLabel = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@categories.index.empty:No categories yet. Check back soon.`;
      case 'audience':
        return $localize`:@@audiences.index.empty:No audiences yet. Check back soon.`;
      case 'phase':
        return $localize`:@@phases.index.empty:No phases yet. Check back soon.`;
      // Sub-floor terms are omitted, so an all-thin catalog renders empty. Say
      // why rather than implying the vocabulary itself is missing.
      case 'trade':
        return $localize`:@@trades.index.empty:No trades have enough tagged products to list yet. Check back soon.`;
    }
  });

  /**
   * Singular and plural as two messages rather than one ICU expression: ICU is a
   * template-compiler feature, and these labels are composed in TS (see
   * `sortOptionLabel` for why the sort labels have to be). The existing plural
   * id keeps its exact text so no shipped translation is orphaned; only the
   * `*One` ids are new. Drive-by fix — the card read "1 products" on every facet
   * before this, and adding a second count to the same line would have doubled
   * the error rather than left it alone.
   */
  protected countLabel(count: number): string {
    return count === 1
      ? $localize`:@@taxonomy.index.card.countOne:1 product`
      : $localize`:@@taxonomy.index.card.count:${count}:INTERPOLATION: products`;
  }

  /**
   * The card carries this beside the product count because it is a **sort key**:
   * an order whose basis the reader cannot see reads as arbitrary. The template
   * renders it only when `integration_count` is actually present, rather than
   * pushing it through `taxonomyIntegrationCount()` and printing a 0 — on a card
   * face, "absent" and "zero integrations" are different claims, and only the
   * sort comparator is entitled to collapse them.
   */
  protected integrationCountLabel(count: number): string {
    return count === 1
      ? $localize`:@@taxonomy.index.card.integrationCountOne:1 integration`
      : $localize`:@@taxonomy.index.card.integrationCount:${count}:INTERPOLATION: integrations`;
  }

  /**
   * The option labels, composed in TS because the control takes localized
   * strings. "Name (A–Z)" reuses the product listings' message, because the
   * order means the same thing. The other two are new with the shared control
   * (mock-up 10, question 7): "Project order" was "Sequence", "Most products"
   * was "Products". The text arrow left with the old labels, because the Arrow
   * Rule keeps it for data-flow direction.
   */
  private sortOptionLabel(mode: SortMode): string {
    switch (mode) {
      case 'sequence':
        return $localize`:@@taxonomy.index.sort.projectOrder:Project order`;
      case 'name':
        return $localize`:@@listing.sort.name:Name (A–Z)`;
      case 'products':
        return $localize`:@@taxonomy.index.sort.mostProducts:Most products`;
    }
  }
}
