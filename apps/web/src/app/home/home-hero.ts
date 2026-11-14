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
 *     and the "Popular:" row (AECI-1572): up to five product links, the most
 *     viewed products over 30 days from the nightly `popular_products` stats key,
 *     or the five largest categories when that list is empty.
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
 *     canonical first slug from `defaultIntegrationContext`. The finder first reads
 *     the pair from the same-origin API (AECI-1823), with a 2.5 s timeout. On a
 *     `NOT_FOUND` it first asks the retired-slug map, as the pair resolver does
 *     (AECI-991), bounded by the same 2.5 s, and navigates to the survivor pair on a hit. Otherwise a stale
 *     slug goes to `/search?q=` with the typed text of the side the envelope names
 *     (`details.slug`), or the first typed text. A timeout or any other failure of
 *     the read navigates to the pair page. A direct request to a bad pair URL still
 *     returns a real 404. While the read runs the form carries `aria-busy`, the
 *     button `aria-disabled`, and a second submit is ignored;
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
 * is identical for every visitor. It has no resolver of its own. The "Popular:"
 * row arrives as an input from `home.ts`, which reads the stats snapshot: one
 * payload per URL, never per visitor, so the row ships in the cached HTML.
 * An empty list leaves the row out of that HTML. After hydration the row then
 * shows the category fallback from `TaxonomyNavStore`.
 */
import { HttpClient } from '@angular/common/http';
import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';

import {
  defaultIntegrationContext,
  type ProductListItem,
  type ProductPairResponse,
} from '@aeci/shared';

import { AecButton } from '../shared/button/button';
import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';
import { navigateToSearchQuery, navigateToSuggestion } from '../layout/search-submit';
import { pairPath } from '../core/api/product-pairs';
import { decodeNotFound } from '../core/api/http-get-or-null';
import {
  httpGetSlugRedirect,
  movedPairPath,
  rewriteRetiredPairSlugs,
} from '../core/api/slug-redirects';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { SearchAutocomplete } from '../search/search-autocomplete';
import { isReplayedEvent } from '../core/event-replay';

/** The two pair-finder pickers. */
type PairSide = 'tool' | 'other';

const PAIR_INPUT_IDS: Record<PairSide, string> = {
  tool: 'hero-pair-tool',
  other: 'hero-pair-other',
};

/** How long the finder waits on the pair read before it navigates anyway (AECI-1823). */
const PAIR_READ_TIMEOUT_MS = 2500;

/** Resolve with `fallback` if `work` has not settled within `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** A chosen product suggestion's slug (`routerLink` is `['/products', slug]`). */
function productSlug(s: AutocompleteSuggestion | null): string | null {
  if (!s || s.kind !== 'product') return null;
  return s.routerLink[1] ?? null;
}

@Component({
  selector: 'aec-home-hero',
  imports: [AecButton, RouterLink, SearchAutocomplete],
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
              [searchName]="searchName"
              (querySubmitted)="onSearchQuery($event)"
              (suggestionChosen)="onSuggestion($event)"
            />
          </div>

          @if (popular().length > 0) {
            <p class="mt-5 flex flex-wrap items-baseline gap-x-4 gap-y-2 text-sm">
              <span class="text-(--text-secondary)" i18n="@@home.hero.popular.label">Popular:</span>
              @for (product of popular(); track product.id) {
                <a
                  [routerLink]="['/products', product.slug]"
                  class="text-(--text-primary) underline decoration-1 decoration-(--border-strong) underline-offset-4 hover:text-(--accent-primary) hover:decoration-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  >{{ product.name }}</a
                >
              }
            </p>
          } @else if (popularCategories().length > 0) {
            <!-- Fallback while no product clears the 30-day view floor: the five
                 largest categories, browser-only from the nav store (never in the
                 cached HTML), so the row is never blank. -->
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
            [attr.aria-busy]="checking() ? 'true' : null"
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
              aecButton
              type="submit"
              class="mt-1 w-full aria-disabled:opacity-100!"
              [attr.aria-disabled]="checking() ? 'true' : null"
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
  private readonly http = inject(HttpClient);
  private readonly taxonomy = inject(TaxonomyNavStore);
  private readonly pairForm = viewChild.required<ElementRef<HTMLFormElement>>('pairForm');

  /** Distinct from the header's "Site search" so the landmarks list can tell them apart (AECI-830). */
  protected readonly searchName = $localize`:@@home.hero.search.landmark:Search the directory`;
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
   * `HomeStatsResponse.popular_products`: the most-viewed products over 30 days,
   * already ranked. A no-typing entry path into the directory.
   */
  readonly popularProducts = input<readonly ProductListItem[]>([]);

  /** At most five links, so a wider payload can never stretch the row. */
  protected readonly popular = computed(() => this.popularProducts().slice(0, 5));

  /**
   * Fallback row when `popular_products` is empty (no product has cleared the
   * 30-day view floor yet): the five largest categories by product count, from
   * the browser-only nav store. Idle during SSR, so it never reaches the cache.
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
    if (isReplayedEvent(event)) return; // the native default already ran
    event.preventDefault();
    void this.submitPair();
  }

  /** Route the finder: pair page, product page, or `/search?q=`. */
  protected async submitPair(): Promise<void> {
    if (this.checking()) return; // a pair read is already in flight
    const tool = productSlug(this.chosen.tool());
    const other = productSlug(this.chosen.other());

    if (tool && other && tool !== other) {
      // The busy state covers the whole check: the pair read and the retired-slug lookup.
      this.checking.set(true);
      try {
        await this.routePair(tool, other);
      } finally {
        this.checking.set(false);
      }
      return;
    }
    const single = tool ?? other;
    if (single) {
      void this.router.navigate(['/products', single], { fragment: 'integrations' });
      return;
    }

    const text = this.typedText();
    if (text) {
      navigateToSearchQuery(this.router, text);
      return;
    }
    this.field('tool')?.focus();
  }

  /** The pair branch of `submitPair`: read, retired-slug lookup, then navigate. */
  private async routePair(tool: string, other: string): Promise<void> {
    const context = defaultIntegrationContext(tool, other);
    const rest = context === tool ? other : tool;
    // The visitor edited a picker while a read was in flight: that choice is theirs
    // now, so do not act on the captured pair (AECI-1823).
    const changed = (): boolean =>
      productSlug(this.chosen.tool()) !== tool || productSlug(this.chosen.other()) !== other;

    const check = await this.checkPair(context, rest);
    if (changed()) return;
    if (check.missing) {
      // A retired slug redirects to its survivor pair, as the pair resolver does
      // (AECI-991). Bounded by the same budget as the read, here only: a timeout
      // reads as "no redirect" and falls through to search.
      const rewritten = await withTimeout(
        rewriteRetiredPairSlugs(context, rest, (slug) =>
          httpGetSlugRedirect(this.http, 'product', slug),
        ),
        PAIR_READ_TIMEOUT_MS,
        null,
      );
      if (changed()) return;
      if (rewritten) {
        void this.router.navigateByUrl(movedPairPath(rewritten));
        return;
      }
      // A stale slug: send the visitor to search, not the generic 404 (AECI-1823).
      const typed = this.missingText(check.slug, tool, other) || this.typedText();
      if (typed) {
        navigateToSearchQuery(this.router, typed);
        return;
      }
    }
    void this.router.navigate(['/products', context, 'integrations', rest]);
  }

  /** True while the pair check runs. Drives `aria-busy` and `aria-disabled`. */
  protected readonly checking = signal(false);

  /**
   * Read the pair from the endpoint its resolver uses. Only a canonical `NOT_FOUND`
   * says it is missing, and then `slug` is the one the envelope names, if any. Any
   * other failure, including the timeout, answers "not missing", so a slow or flaky
   * read never strands the visitor: the pair page makes its own decision.
   */
  private async checkPair(
    context: string,
    other: string,
  ): Promise<{ missing: boolean; slug: string | null }> {
    try {
      await firstValueFrom(
        this.http
          .get<ProductPairResponse>(pairPath(context, other, undefined))
          .pipe(timeout(PAIR_READ_TIMEOUT_MS)),
      );
      return { missing: false, slug: null };
    } catch (err) {
      const notFound = decodeNotFound(err);
      return { missing: notFound !== null, slug: notFound?.slug ?? null };
    }
  }

  /** The typed text of the picker whose product the 404 named, or '' when it named neither. */
  private missingText(slug: string | null, tool: string, other: string): string {
    if (slug === tool) return this.fieldText('tool');
    if (slug === other) return this.fieldText('other');
    return '';
  }

  /** The first non-empty text typed in either picker. */
  private typedText(): string {
    return [this.fieldText('tool'), this.fieldText('other')].find((t) => t !== '') ?? '';
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
