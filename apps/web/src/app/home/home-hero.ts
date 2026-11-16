/**
 * `aec-home-hero`: the home page hero (AECI-182, redesigned in AECI-1555, rebuilt
 * on mock-up 9 in AECI-1792).
 *
 * The hero sits inside the page's one Bone band (`aec-bone-band`, owned by
 * `home.ts`), which also holds the credibility row. The band owns the ground, the
 * 1328px wrap and the top padding. The hero owns the space under its grid.
 *
 * Two columns at `lg`, one column below:
 *   - Left: the overline, the page's only `<h1>` at Display size (`--t-display`,
 *     40 to 72px, weight 400, set on an inner span), a one-line lede, the search
 *     field with a leading glyph, and the "Most viewed" row.
 *   - Right: the pair finder, a white `aecCard` that asks "Do these two connect?"
 *     with two product pickers and a Forest "Show integrations" button. On mobile
 *     it sits under the left column.
 *
 * The "Most viewed" row (AECI-1572, AECI-1862). Up to five product links, the most
 * viewed products over 30 days from the nightly `popular_products` stats key,
 * labelled "Most viewed, last 30 days:". When that list is empty it shows the five
 * largest categories, labelled "Largest categories:". Each label states its
 * order. Both lists arrive as inputs from resolver data, so the row ships in the
 * cached SSR HTML and never fills in after load. Its height is reserved as well
 * (two lines from `sm`, three below), so an empty row does not move the page.
 *
 * The tagline states only what is true: it does not claim dual-vendor
 * verification and avoids an "every" completeness claim.
 *
 * Every field is the reused `SearchAutocomplete` widget (AECI-144) on the shared
 * control recipe (`aec-field-control`). No new Algolia plumbing. The widget
 * SSR-renders a real `<label>` and `<input>` and hydration-enhances. With no
 * Algolia config it stays a plain text field.
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
 *     returns a real 404. While the read runs the form carries `aria-busy` and a second
 *     submit is ignored;
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
 * is identical for every visitor. It has no resolver of its own. Both rows of the
 * "Most viewed" slot come from `home.ts`: one payload per URL, never per visitor.
 */
import { HttpClient } from '@angular/common/http';
import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';

import {
  defaultIntegrationContext,
  type ProductListItem,
  type ProductPairResponse,
  type TaxonomyTermWithCount,
} from '@aeci/shared';

import { AecButton } from '../shared/button/button';
import { AecCard } from '../shared/card/card';
import { AecIcon } from '../shared/icon/icon';
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

/**
 * The three hero fields on the shared control recipe (DESIGN.md "Inputs / Fields"):
 * `aec-field-control` draws the 3:1 field edge, which holds on Bone (3.31:1), the
 * 12px radius and the 44px floor. Padding is per field: the hero search makes
 * room for its glyph.
 */
const FIELD_CLASS =
  'aec-field-control rounded-control border bg-(--surface-base) text-t-16 text-(--text-primary) placeholder:text-(--text-secondary)';
const FOCUS_RING_CLASS =
  'focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** A link in the "Most viewed" row. The underline is the link cue, not colour. */
const POPULAR_LINK_CLASS =
  'rounded-sm text-(--text-primary) underline decoration-(--border-field) decoration-1 underline-offset-4 transition-colors hover:text-(--accent-primary) hover:decoration-current focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

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
  imports: [AecButton, AecCard, AecIcon, RouterLink, SearchAutocomplete],
  host: { class: 'block' },
  template: `
    <div
      class="grid gap-12 pb-12 lg:grid-cols-[minmax(0,1fr)_26rem] lg:items-center lg:gap-16 lg:pb-16"
    >
      <div class="min-w-0">
        <p class="aec-overline text-(--text-secondary)" i18n="@@home.hero.eyebrow.independent">
          The independent reference for AEC software
        </p>
        <!-- The size sits on the inner span: the unlayered h1 rule beats any
             utility on the h1 itself (the Unlayered-Heading Rule). -->
        <h1 id="home-title" class="mt-4 text-(--text-primary)">
          <span
            data-testid="home-hero-title"
            class="block font-display text-t-display font-normal leading-[1.05] tracking-[-0.02em]"
            i18n="@@home.hero.tagline"
            >Find the integrations between your AEC tools.</span
          >
        </h1>
        <p
          class="mt-6 max-w-[36em] text-t-20 leading-normal text-(--text-secondary)"
          i18n="@@home.hero.lede"
        >
          The independent directory of integrations across the AEC stack, with no pay-for-placement.
        </p>

        <!-- The search glyph sits over the field's start. The label is sr-only, so
             the field is the first box in this wrapper and the glyph centres on it. -->
        <div class="relative mt-8 max-w-xl">
          <aec-search-autocomplete
            inputId="hero-search"
            inputClass="w-full"
            inputHeightClass="h-11"
            [fieldClass]="searchFieldClass"
            [focusRingClass]="focusRingClass"
            [placeholder]="searchPlaceholder"
            [searchName]="searchName"
            (querySubmitted)="onSearchQuery($event)"
            (suggestionChosen)="onSuggestion($event)"
          />
          <span
            class="pointer-events-none absolute start-4 top-[22px] flex -translate-y-1/2 text-(--text-secondary)"
          >
            <aec-icon name="search" decorative [size]="5" />
          </span>
        </div>

        <!-- AECI-1862: the row's height is reserved, two lines from sm and three
             below (the five-name worst case), so nothing below it moves. Both lists
             come from resolver data, so the row ships in the cached SSR HTML. -->
        <div data-testid="home-popular" class="mt-4 min-h-[72px] sm:min-h-12">
          @if (popular().length > 0) {
            <p class="flex flex-wrap content-start items-baseline gap-x-4 text-t-14 leading-6">
              <span
                class="text-(--text-secondary) max-sm:basis-full"
                i18n="@@home.hero.popular.mostViewed"
                >Most viewed, last 30 days:</span
              >
              @for (product of popular(); track product.id) {
                <a [routerLink]="['/products', product.slug]" [class]="popularLinkClass">{{
                  product.name
                }}</a>
              }
            </p>
          } @else if (popularCategories().length > 0) {
            <p class="flex flex-wrap content-start items-baseline gap-x-4 text-t-14 leading-6">
              <span
                class="text-(--text-secondary) max-sm:basis-full"
                i18n="@@home.hero.popular.largestCategories"
                >Largest categories:</span
              >
              @for (cat of popularCategories(); track cat.id) {
                <a [routerLink]="['/categories', cat.slug]" [class]="popularLinkClass">{{
                  cat.name
                }}</a>
              }
            </p>
          }
        </div>
      </div>

      <div aecCard class="min-w-0 p-6 sm:p-8">
        <h2 id="hero-pair-title" class="text-(--text-primary)" i18n="@@home.hero.pair.title">
          Do these two connect?
        </h2>
        <p class="mt-1 text-t-14 text-(--text-secondary)" i18n="@@home.hero.pair.hint">
          Pick two products to see every integration between them.
        </p>

        <!-- The no-JS base layer: a native GET to /search. With JS the submit
             handler routes to the pair page or a product page instead. -->
        <form
          #pairForm
          class="mt-6 flex flex-col gap-4"
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
            [fieldClass]="pairFieldClass"
            [focusRingClass]="focusRingClass"
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
            [fieldClass]="pairFieldClass"
            [focusRingClass]="focusRingClass"
            (input)="clearChoice('other')"
            (suggestionChosen)="choose('other', $event)"
            (querySubmitted)="submitPair()"
          />
          <button aecButton type="submit" class="mt-2 w-full" i18n="@@home.hero.pair.submit">
            Show integrations
          </button>
        </form>
      </div>
    </div>
  `,
})
export class HomeHero {
  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
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
  protected readonly searchFieldClass = `${FIELD_CLASS} ps-12 pe-4`;
  protected readonly pairFieldClass = `${FIELD_CLASS} px-4`;
  protected readonly focusRingClass = FOCUS_RING_CLASS;
  protected readonly popularLinkClass = POPULAR_LINK_CLASS;

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
   * The fallback row when `popular_products` is empty (no product has cleared the
   * 30-day view floor yet): the largest categories by product count, already
   * ranked by `home.ts` from the `browse` resolver. Resolver data, so it ships in
   * the cached SSR HTML and the row never fills in after load (AECI-1862).
   */
  readonly largestCategories = input<readonly TaxonomyTermWithCount[]>([]);

  /** At most five links, as for the product row. */
  protected readonly popularCategories = computed(() => this.largestCategories().slice(0, 5));

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

  /** True while the pair check runs. Drives `aria-busy`. */
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
