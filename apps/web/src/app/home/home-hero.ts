/**
 * `aec-home-hero` — the home page hero (AECI-182 / Phase 4.7).
 *
 * Faire-anchored editorial hero per `docs/design/home-direction.md` §"Hero
 * (Faire treatment)": a full-bleed warm Bone (`--accent-warm`) band with a 1px
 * bottom rule, a left-aligned `max-w-3xl` column holding a small-caps eyebrow, a
 * Source-Serif display tagline (leads with the substantive trust / what-connects
 * claim, not a verb imperative — placeholder copy, final marketing copy is out of
 * scope for 4.7), a one-line lede, and the search field as the single primary
 * affordance.
 *
 * The search is the REUSED `SearchAutocomplete` widget (AECI-144) — no new
 * Algolia plumbing. It SSR-renders a static `<form action="/search">` + a real
 * sr-only `<label>` + `<input>`, then hydration-enhances; with no Algolia config
 * it degrades to a plain submit-to-`/search` field (correct for the cached home).
 * Navigation lives here (the widget is Router-free by design), wired through the
 * shared `search-submit` helpers exactly as `SiteHeader` does.
 *
 * "Popular:" quick-links reuse `TaxonomyNavStore` (the same root singleton the
 * header loads, so no new fetch). The store is browser-only — its values are
 * idle during SSR and arrive after hydration via `/api/taxonomy` — so the row is
 * gated on a non-empty set: it is a progressive enhancement that never reaches
 * the edge-cached home HTML (keeping it taxonomy-state-neutral). Per AECI-182's
 * decision, "no live data dependency beyond the search widget" is read as "no new
 * data dependency / no resolver": this reuses app-shell data fetched client-side.
 *
 * Presentational: no resolver, no meta/Cache-Tag/JSON-LD (that is the 4.11
 * assembly issue). Both themes are token-driven; the band is `#2A2520` in dark.
 */
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';
import { navigateToSearchQuery, navigateToSuggestion } from '../layout/search-submit';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { SearchAutocomplete } from '../search/search-autocomplete';

@Component({
  selector: 'aec-home-hero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, SearchAutocomplete],
  host: { class: 'block' },
  template: `
    <section class="border-b border-(--border-default) bg-(--accent-warm)">
      <div class="mx-auto max-w-7xl px-6 py-16 md:px-8 md:py-24">
        <div class="max-w-3xl">
          <p class="aec-overline text-(--text-secondary)" i18n="@@home.hero.eyebrow">
            The specifier's reference for AEC software
          </p>
          <h1
            class="mt-3 font-display text-[clamp(2.25rem,4.5vw+1rem,4rem)] font-normal leading-[1.05] tracking-[-0.01em] text-(--text-primary)"
            i18n="@@home.hero.tagline"
          >
            Every integration between AEC tools, verified by both vendors.
          </h1>
          <p class="mt-5 text-base text-(--text-secondary)" i18n="@@home.hero.lede">
            Product and vendor integrations across the AEC stack, with no vendor marketing and no
            pay-for-placement.
          </p>

          <div class="mt-8">
            <aec-search-autocomplete
              inputId="hero-search"
              [inputClass]="'w-full max-w-xl'"
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
      </div>
    </section>
  `,
})
export class HomeHero {
  private readonly router = inject(Router);
  private readonly taxonomy = inject(TaxonomyNavStore);

  /**
   * A short row of the most-integrated categories for a no-typing entry path.
   * Browser-only (the store is idle during SSR), so the row only renders after
   * the post-hydration `/api/taxonomy` fetch settles — gated on non-empty above.
   */
  protected readonly popularCategories = computed(() =>
    this.taxonomy.categoriesTop10().slice(0, 5),
  );

  /** Enter with no suggestion chosen → `/search?q=` (mirrors `SiteHeader`). */
  protected onSearchQuery(query: string): void {
    navigateToSearchQuery(this.router, query);
  }

  /** A suggestion committed → its detail page (mirrors `SiteHeader`). */
  protected onSuggestion(suggestion: AutocompleteSuggestion): void {
    navigateToSuggestion(this.router, suggestion);
  }
}
