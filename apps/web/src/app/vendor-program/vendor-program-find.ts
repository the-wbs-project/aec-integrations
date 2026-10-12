/**
 * Find your product, the vendor program page's third section
 * (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §6, AECI-1287). Every "Claim your listing
 * free" on the page scrolls here (`#find-your-product`).
 *
 * - **The box** is the site's `aec-search-autocomplete` with its own `inputId`, a
 *   visible label and the placeholder "Search for your product or company". It
 *   searches in the browser only, so the cached HTML holds the empty box and
 *   nothing else.
 * - **A hit.** Choosing a product or vendor suggestion does not navigate. It shows
 *   a result card with the name, "Claim this listing" (the listing's own claim
 *   form, `/products/:slug/claim` or `/vendors/:slug/claim`) and "View the
 *   listing". The claim click fires `plan_cta_clicked` with plan `free`,
 *   placement `search_result`, page `vendor_program` (§9).
 * - **Ask us to add it.** Under the box, always: "Can't find your product? Ask us
 *   to add it." The link goes to `/contact?topic=add-product` (`ADD_PRODUCT_TOPIC`),
 *   where the contact page offers an email with the subject and the prompt filled
 *   in (§6, settled 2026-10-12). It fires no analytics event.
 * - **A miss.** A settled query with no suggestion shows the "may already be
 *   listed" line, ending in the same "ask us to add it" link. Never "are already
 *   listed" (§8). A search that failed is not a miss and shows nothing.
 * - **Layout.** From `lg` the heading and lede take the left five columns and the
 *   box, the ask line and the result take the right seven (§11, full width).
 * - **Enter with no choice** goes to `/search?q=`, as in the header. The no-JS
 *   form does the same through its `action`.
 * - **Analytics.** `vendor_product_search` fires once per settled non-empty query,
 *   with the count only. The query text never leaves the browser: it can name a
 *   company before it has agreed to anything (§9). Re-settling the same text does
 *   not count twice.
 *
 * Every string is `i18n` / `$localize`. Light only.
 */
import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { Analytics } from '../analytics/analytics';
import { ADD_PRODUCT_TOPIC } from '../contact/contact-topics';
import { navigateToSearchQuery } from '../layout/search-submit';
import type { AutocompleteSettled } from '../search/autocomplete-controller';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { SearchAutocomplete } from '../search/search-autocomplete';

@Component({
  selector: 'aec-vendor-program-find',
  imports: [RouterLink, SearchAutocomplete],
  host: { class: 'grid gap-6 lg:grid-cols-12 lg:gap-x-12' },
  template: `
    <div class="lg:col-span-5">
      <h2 id="vp-find-heading" i18n="@@vendorProgram.find.heading">Find your product</h2>
      <p
        class="mt-3 max-w-[56ch] leading-relaxed text-(--text-secondary)"
        i18n="@@vendorProgram.find.lede"
      >
        Search for your product or your company. Choose it, then claim the listing. A claim costs
        nothing and needs no account.
      </p>
    </div>

    <div class="lg:col-span-7">
      <aec-search-autocomplete
        inputId="vendor-program-search"
        [label]="label"
        [labelVisible]="true"
        [placeholder]="placeholder"
        inputClass="w-full"
        inputHeightClass="h-11"
        (suggestionChosen)="choose($event)"
        (querySubmitted)="toSearch($event)"
        (searchSettled)="settled($event)"
      />
      <p class="mt-3 text-sm text-(--text-secondary)" data-testid="vp-find-ask">
        <span i18n="@@vendorProgram.find.askLead">Can't find your product?</span>
        {{ ' ' }}
        <a
          routerLink="/contact"
          [queryParams]="askQuery"
          [class]="askLink"
          i18n="@@vendorProgram.find.ask"
          >Ask us to add it.</a
        >
      </p>

      <div class="mt-5" aria-live="polite" data-testid="vp-find-outcome">
        @if (chosen(); as hit) {
          <div
            class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-5"
            data-testid="vp-find-result"
          >
            <p class="aec-overline text-(--text-secondary)">
              {{ hit.kind === 'product' ? productTag : vendorTag }}
            </p>
            <p class="mt-1 font-display text-xl text-(--text-primary)">{{ hit.title }}</p>
            @if (hit.subtitle) {
              <p class="mt-0.5 text-sm text-(--text-secondary)">{{ hit.subtitle }}</p>
            }
            <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
              <a
                [routerLink]="claimLink(hit)"
                (click)="trackClaim()"
                class="inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-2.5 text-sm font-semibold text-(--surface-base) no-underline hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@vendorProgram.find.claim"
                >Claim this listing</a
              >
              <a
                [routerLink]="hit.routerLink"
                class="inline-flex items-center justify-center rounded-(--radius-md) px-3 py-2 text-sm font-medium text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@vendorProgram.find.view"
                >View the listing</a
              >
            </div>
          </div>
        } @else if (missed()) {
          <p
            class="leading-relaxed text-(--text-primary)"
            data-testid="vp-find-miss"
            i18n="@@vendorProgram.find.missAsk"
          >
            Your products may already be listed, under a different name. If you cannot find yours,
            <a routerLink="/contact" [queryParams]="askQuery" [class]="askLink">ask us to add it</a
            >.
          </p>
        }
      </div>
    </div>
  `,
})
export class VendorProgramFind {
  private readonly analytics = inject(Analytics);
  private readonly router = inject(Router);

  protected readonly label = $localize`:@@vendorProgram.find.label:Your product or company`;
  protected readonly placeholder = $localize`:@@vendorProgram.find.placeholder:Search for your product or company`;
  protected readonly productTag = $localize`:@@vendorProgram.find.kind.product:Product`;
  protected readonly vendorTag = $localize`:@@vendorProgram.find.kind.vendor:Company`;

  /** `/contact?topic=add-product`: the contact page's "add your product" email. */
  protected readonly askQuery = { topic: ADD_PRODUCT_TOPIC };
  /** An in-text link (DESIGN.md, the Link Treatment Rule). */
  protected readonly askLink =
    'text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  /** The suggestion the visitor chose, shown as the result card. */
  protected readonly chosen = signal<AutocompleteSuggestion | null>(null);
  /** The last settled query found nothing. */
  protected readonly missed = signal(false);

  /** The last query counted, so re-settling the same text is not counted twice. In memory only. */
  private lastCounted: string | null = null;

  protected choose(hit: AutocompleteSuggestion): void {
    this.missed.set(false);
    this.chosen.set(hit);
  }

  protected toSearch(query: string): void {
    navigateToSearchQuery(this.router, query);
  }

  protected settled(result: AutocompleteSettled): void {
    if (result.query === '') {
      // Cleared: drop the miss line, keep a chosen card until another choice.
      this.missed.set(false);
      this.lastCounted = null;
      return;
    }
    if (result.failed) {
      // A failed search is not a miss: drop any earlier miss line, count nothing.
      this.missed.set(false);
      return;
    }
    this.missed.set(result.count === 0);
    if (result.count === 0) this.chosen.set(null);
    if (result.query !== this.lastCounted) {
      this.lastCounted = result.query;
      this.analytics.vendorProductSearch({ results_count: result.total ?? result.count });
    }
  }

  protected claimLink(hit: AutocompleteSuggestion): readonly string[] {
    return [...hit.routerLink, 'claim'];
  }

  protected trackClaim(): void {
    this.analytics.planCtaClicked({
      plan: 'free',
      placement: 'search_result',
      page: 'vendor_program',
    });
  }
}
