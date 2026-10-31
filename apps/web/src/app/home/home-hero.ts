/**
 * `aec-home-hero`: the home page hero (AECI-182, redesigned in AECI-1555).
 *
 * Faire-anchored editorial hero per `docs/design/home-direction.md` §"Hero
 * (Faire treatment)". The hero sits on the warm Bone (`--accent-warm`) band that
 * `home.ts` owns and closes with the credibility row, so the hero draws no
 * bottom rule.
 *
 * Two columns at `lg`, one column below:
 *   - Left: a small-caps eyebrow, the Source Serif display tagline (the page's
 *     only `<h1>`), a one-line lede, the search field (the ready visitor's path),
 *     and the browser-only "Popular:" row.
 *   - Right: the pair finder, a bordered white panel that asks "Do these two
 *     connect?" with two product pickers and a Forest "Show integrations" button.
 *     On mobile it sits under the left column.
 *
 * The tagline states only what is true: it does not claim dual-vendor
 * verification and avoids an "every" completeness claim.
 *
 * Every field is the reused `SearchAutocomplete` widget (AECI-144). No new
 * Algolia plumbing. The widget SSR-renders a real `<label>` and `<input>` and
 * hydration-enhances. With no Algolia config it stays a plain text field.
 *
 * Pair finder routing (JS):
 *   - two different products chosen: the product-pair page, context = the
 *     canonical first slug from `defaultIntegrationContext`;
 *   - one product chosen: that product's page at its `#integrations` section;
 *   - nothing chosen but text typed: `/search?q=` with the first typed text.
 * Typing into a picker after choosing drops that picker's choice, so the route
 * always matches what the field shows.
 *
 * No-JS base layer: the finder is a real `<form action="/search" method="get">`
 * whose pickers mount formless (`ownForm = false`, so forms never nest). Both
 * inputs are named `q`, so a native submit reaches `/search` and searches the
 * first field.
 *
 * Cached SSR route: the hero reads no cookie or visitor state, and the SSR HTML
 * is identical for every visitor. No resolver. The "Popular:" row reads the
 * browser-only `TaxonomyNavStore`, so it never reaches the cached HTML.
 */
import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { defaultIntegrationContext } from '@aeci/shared';

import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';
import { navigateToSearchQuery, navigateToSuggestion } from '../layout/search-submit';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { SearchAutocomplete } from '../search/search-autocomplete';

/** The two pair-finder pickers. */
type PairSide = 'tool' | 'other';

const PAIR_INPUT_IDS: Record<PairSide, string> = {
  tool: 'hero-pair-tool',
  other: 'hero-pair-other',
};

/** A chosen product suggestion's slug (`routerLink` is `['/products', slug]`). */
function productSlug(s: AutocompleteSuggestion | null): string | null {
  if (!s || s.kind !== 'product') return null;
  return s.routerLink[1] ?? null;
}

@Component({
  selector: 'aec-home-hero',
  imports: [RouterLink, SearchAutocomplete],
  host: { class: 'block' },
  template: `
    <section class="bg-(--accent-warm)">
      <div
        class="mx-auto grid max-w-7xl gap-10 px-6 py-16 md:px-8 md:py-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-center lg:gap-16"
      >
        <div class="min-w-0">
          <p class="aec-overline text-(--text-secondary)" i18n="@@home.hero.eyebrow.independent">
            The independent reference for AEC software
          </p>
          <h1
            class="mt-3 font-display text-[clamp(2.25rem,4.5vw+1rem,4rem)] font-normal leading-[1.05] tracking-[-0.01em] text-(--text-primary)"
            i18n="@@home.hero.tagline"
          >
            Find the integrations between your AEC tools.
          </h1>
          <p class="mt-5 text-base text-(--text-secondary)" i18n="@@home.hero.lede">
            The independent directory of integrations across the AEC stack, with no
            pay-for-placement.
          </p>

          <div class="mt-8">
            <aec-search-autocomplete
              inputId="hero-search"
              [inputClass]="'w-full max-w-xl'"
              inputHeightClass="h-11"
              [placeholder]="searchPlaceholder"
              (querySubmitted)="onSearchQuery($event)"
              (suggestionChosen)="onSuggestion($event)"
            />
          </div>

          @if (popularCategories().length > 0) {
            <p class="mt-5 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
              <span class="text-(--text-secondary)" i18n="@@home.hero.popular.label">Popular:</span>
              @for (cat of popularCategories(); track cat.id) {
                <a
                  [routerLink]="['/categories', cat.slug]"
                  class="text-(--text-primary) underline decoration-1 decoration-(--border-strong) underline-offset-4 hover:text-(--accent-primary) hover:decoration-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  >{{ cat.name }}</a
                >
              }
            </p>
          }
        </div>

        <div
          class="min-w-0 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-base) p-6"
        >
          <h2
            id="hero-pair-title"
            class="font-display text-2xl font-normal text-(--text-primary)"
            i18n="@@home.hero.pair.title"
          >
            Do these two connect?
          </h2>
          <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@home.hero.pair.hint">
            Pick two products to see every integration between them.
          </p>

          <!-- The no-JS base layer: a native GET to /search. With JS the submit
               handler routes to the pair page or a product page instead. -->
          <form
            #pairForm
            class="mt-5 flex flex-col gap-4"
            role="search"
            aria-labelledby="hero-pair-title"
            action="/search"
            method="get"
            (submit)="onPairSubmit($event)"
          >
            <aec-search-autocomplete
              [inputId]="toolInputId"
              [ownForm]="false"
              [fillOnSelect]="true"
              [kinds]="productKinds"
              [label]="toolLabel"
              [labelVisible]="true"
              [placeholder]="pairPlaceholder"
              inputClass="w-full"
              inputHeightClass="h-11"
              (input)="clearChoice('tool')"
              (suggestionChosen)="choose('tool', $event)"
              (querySubmitted)="submitPair()"
            />
            <aec-search-autocomplete
              [inputId]="otherInputId"
              [ownForm]="false"
              [fillOnSelect]="true"
              [kinds]="productKinds"
              [label]="otherLabel"
              [labelVisible]="true"
              [placeholder]="pairPlaceholder"
              inputClass="w-full"
              inputHeightClass="h-11"
              (input)="clearChoice('other')"
              (suggestionChosen)="choose('other', $event)"
              (querySubmitted)="submitPair()"
            />
            <button
              type="submit"
              class="mt-1 h-11 w-full rounded-(--radius-md) bg-(--accent-primary) px-5 font-label text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@home.hero.pair.submit"
            >
              Show integrations
            </button>
          </form>
        </div>
      </div>
    </section>
  `,
})
export class HomeHero {
  private readonly router = inject(Router);
  private readonly taxonomy = inject(TaxonomyNavStore);
  private readonly pairForm = viewChild.required<ElementRef<HTMLFormElement>>('pairForm');

  protected readonly searchPlaceholder = $localize`:@@home.hero.search.placeholder:Try Procore, Sage 300, Bluebeam`;
  protected readonly toolLabel = $localize`:@@home.hero.pair.tool.label:Your tool`;
  protected readonly otherLabel = $localize`:@@home.hero.pair.other.label:Connects to`;
  protected readonly pairPlaceholder = $localize`:@@home.hero.pair.placeholder:Type a product name`;
  protected readonly productKinds = ['product'] as const;
  protected readonly toolInputId = PAIR_INPUT_IDS.tool;
  protected readonly otherInputId = PAIR_INPUT_IDS.other;

  /** The product committed in each picker; cleared when that field is edited. */
  private readonly chosen = {
    tool: signal<AutocompleteSuggestion | null>(null),
    other: signal<AutocompleteSuggestion | null>(null),
  };

  /**
   * A short row of the most-integrated categories for a no-typing entry path.
   * Browser-only (the store is idle during SSR), so the row only renders after
   * the post-hydration `/api/taxonomy` fetch settles.
   */
  protected readonly popularCategories = computed(() =>
    this.taxonomy.categoriesTop10().slice(0, 5),
  );

  /** Enter with no suggestion chosen: `/search?q=` (mirrors `SiteHeader`). */
  protected onSearchQuery(query: string): void {
    navigateToSearchQuery(this.router, query);
  }

  /** A suggestion committed: its detail page (mirrors `SiteHeader`). */
  protected onSuggestion(suggestion: AutocompleteSuggestion): void {
    navigateToSuggestion(this.router, suggestion);
  }

  protected choose(side: PairSide, suggestion: AutocompleteSuggestion): void {
    this.chosen[side].set(suggestion.kind === 'product' ? suggestion : null);
  }

  /** Typing in a picker drops its earlier choice, so the route matches the field. */
  protected clearChoice(side: PairSide): void {
    this.chosen[side].set(null);
  }

  /** The finder's native submit (button click, or Enter on a no-Algolia field). */
  protected onPairSubmit(event: Event): void {
    event.preventDefault();
    this.submitPair();
  }

  /** Route the finder: pair page, product page, or `/search?q=`. */
  protected submitPair(): void {
    const tool = productSlug(this.chosen.tool());
    const other = productSlug(this.chosen.other());

    if (tool && other && tool !== other) {
      const context = defaultIntegrationContext(tool, other);
      const rest = context === tool ? other : tool;
      void this.router.navigate(['/products', context, 'integrations', rest]);
      return;
    }
    const single = tool ?? other;
    if (single) {
      void this.router.navigate(['/products', single], { fragment: 'integrations' });
      return;
    }

    const text = [this.fieldText('tool'), this.fieldText('other')].find((t) => t !== '');
    if (text) {
      navigateToSearchQuery(this.router, text);
      return;
    }
    this.field('tool')?.focus();
  }

  private field(side: PairSide): HTMLInputElement | null {
    return this.pairForm().nativeElement.querySelector<HTMLInputElement>(
      `#${PAIR_INPUT_IDS[side]}`,
    );
  }

  private fieldText(side: PairSide): string {
    return this.field(side)?.value.trim() ?? '';
  }
}
