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

import { KIND_PATH_SEGMENT } from '../core/api/taxonomy';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * How the term grid is ordered.
 *
 * `sequence` is the API's own order (`display_order ASC, name ASC`) and is
 * offered on **`/phases` only**, where the vocabulary genuinely *is* a sequence:
 * Concept & Planning → Design → Pre-Construction → Construction → Closeout &
 * Operations. Sorting those alphabetically as the default would scramble meaning
 * the terms carry, so there it is both an option and the default.
 *
 * The other three facets do **not** expose it. Their `display_order` is an
 * editorial convenience rather than information the reader needs, and a term
 * grid answers "is my thing in here?" — a question A→Z answers better than any
 * curated sequence. `display_order` still drives those facets everywhere else it
 * matters (the nav flyout, the facet sidebar, the home browse grids); it is only
 * this one surface that stops deferring to it.
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
 * Every term renders as an editorial card linking to its `/{segment}/:slug`
 * browse page. Still not a sortable *table* (cf. `/products`) — the taxonomy is
 * small (≈30 terms) and reads better as cards — but the card grid does carry a
 * sort toggle (`SortMode`), on all four facets because all four routes are this
 * component. The option set is per-facet (`SORT_MODES_BY_KIND`): `/phases` gets
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
  imports: [RouterLink, MailingListSignup],
  template: `
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-7xl px-6 py-8 md:px-8 md:py-12">
        <header class="mb-8 border-b border-(--border-default) pb-6 md:mb-12 md:pb-8">
          <nav i18n-aria-label="@@taxonomy.index.breadcrumbs.aria" aria-label="Breadcrumb">
            <ol
              class="flex items-center gap-2 text-xs tracking-wide uppercase text-(--text-secondary)"
            >
              <li>
                <a
                  routerLink="/"
                  class="rounded-sm transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@taxonomy.index.breadcrumbs.home"
                  >Home</a
                >
              </li>
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              <li class="text-(--text-primary)" aria-current="page">{{ title() }}</li>
            </ol>
          </nav>
          <h1 class="mt-3 font-display text-4xl font-semibold tracking-tight md:text-5xl">
            {{ title() }}
          </h1>
          <p class="mt-3 max-w-prose text-(--text-secondary)">{{ lede() }}</p>
        </header>

        @if (terms().length > 0) {
          <!-- Sort control. See sorted() and sortOptionLabel() for the rules. -->
          <fieldset class="mb-6 flex flex-wrap items-center gap-2">
            <legend class="sr-only" i18n="@@taxonomy.index.sort.legend">Sort terms by</legend>
            <span class="me-1 text-xs font-bold tracking-wide uppercase text-(--text-secondary)">
              {{ sortLabel }}
            </span>
            @for (mode of sortModes(); track mode) {
              <button
                type="button"
                (click)="setSort(mode)"
                [attr.aria-pressed]="sort() === mode"
                class="rounded-(--radius-md) border px-3 py-1.5 text-xs font-bold transition-colors
                  focus-visible:outline-2 focus-visible:outline-offset-2
                  focus-visible:outline-(--accent-primary)"
                [class]="
                  sort() === mode
                    ? 'border-(--accent-primary) bg-(--accent-primary-soft) text-(--text-primary)'
                    : 'border-(--border-default) text-(--text-secondary) hover:text-(--text-primary)'
                "
              >
                {{ sortOptionLabel(mode) }}
              </button>
            }
          </fieldset>

          <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            @for (term of terms(); track term.id) {
              <li>
                <a
                  [routerLink]="[basePath(), term.slug]"
                  class="flex h-full flex-col rounded-(--radius-lg) border border-(--border-default)
                    bg-(--surface-raised) p-5 text-(--text-primary) no-underline transition-colors
                    hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  <span class="font-display text-lg font-semibold tracking-tight">{{
                    term.name
                  }}</span>
                  @if (term.description) {
                    <span
                      class="mt-2 line-clamp-3 text-sm leading-relaxed text-(--text-secondary)"
                      >{{ term.description }}</span
                    >
                  }
                  <!-- Both counts: one of them is a sort key. See the note on
                       integrationCountLabel(). -->
                  <span class="mt-4 text-sm font-bold text-(--text-secondary) tabular-nums">
                    {{ countLabel(term.product_count) }}
                    @if (term.integration_count !== undefined) {
                      <span aria-hidden="true" class="mx-1.5 text-(--text-tertiary)">·</span>
                      {{ integrationCountLabel(term.integration_count) }}
                    }
                  </span>
                </a>
              </li>
            }
          </ul>
        } @else {
          <p
            class="rounded-(--radius-lg) border border-dashed border-(--border-default)
              bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
          >
            {{ emptyLabel() }}
          </p>
        }
      </div>
    </div>

    <aec-mailing-list-signup />
  `,
})
export class TaxonomyIndexPage {
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
   * The control is a `<fieldset>` of `aria-pressed` buttons behind an `sr-only`
   * `<legend>`, mirroring the admin console's range toggles. Angular Aria ships
   * no `radio` (ADR 0010), and a pressed-state toggle group is the honest
   * semantic for something that reorders content already on the page. It renders
   * only when there is a grid to reorder: a sort control over an empty list is
   * furniture, not function.
   */
  protected setSort(mode: SortMode): void {
    this.explicitSort.set(mode);
  }

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
   * array order and repeated sorts are idempotent. `localeCompare` is pinned to
   * `'en'` rather than the ambient locale: the app is en-US only at launch, and
   * an unpinned collation could order differently under the SSR Worker than in
   * the browser — which for the three A→Z-by-default facets would now be a
   * server/client mismatch, not merely a cosmetic difference.
   */
  private sorted(
    terms: ReadonlyArray<TaxonomyTermWithCount>,
  ): ReadonlyArray<TaxonomyTermWithCount> {
    const byName = (a: TaxonomyTermWithCount, b: TaxonomyTermWithCount) =>
      a.name.localeCompare(b.name, 'en');

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

  /** The visible "Sort by" lead-in. The `<legend>` carries the accessible name,
   *  so this span is the sighted-reader half of the same label. */
  protected readonly sortLabel = $localize`:@@taxonomy.index.sort.label:Sort by`;

  /**
   * Composed in TS, not as an `i18n` attribute, because the options come out of
   * a `@for` — and an *interpolated* `i18n-*` attribute emits no attribute at
   * all in this app (AECI-166), so a template-side switch would be one refactor
   * away from silently unlabelled buttons.
   */
  protected sortOptionLabel(mode: SortMode): string {
    switch (mode) {
      case 'sequence':
        return $localize`:@@taxonomy.index.sort.sequence:Sequence`;
      case 'name':
        return $localize`:@@taxonomy.index.sort.alphabetical:A → Z`;
      case 'products':
        return $localize`:@@taxonomy.index.sort.products:Products`;
    }
  }
}
