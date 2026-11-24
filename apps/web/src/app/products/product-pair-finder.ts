import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';

import { isReplayedEvent } from '../core/event-replay';
import { ON_FOREST_FOCUS_RING } from '../layout/header-link-classes';
import { navigateToSearchQuery } from '../layout/search-submit';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { SearchAutocomplete } from '../search/search-autocomplete';
import { AecButton } from '../shared/button/button';
import { FIELD_LABEL_FONT_CLASS } from '../shared/form-field/form-field-classes';
import { productSlug, routeFinderPair } from '../shared/pair-finder/pair-finder-route';

const INPUT_ID = 'product-pair-other';

/**
 * AECI-1787 - the pair finder under the product hero's category hub (ruling R3 decision 1:
 * "a category hub with a pair finder under it"). It is the home pair finder
 * (`home/home-hero.ts`) with one side filled: the page's product. The visitor picks the
 * other product, and the finder routes exactly as the home one does, through the shared
 * `routeFinderPair` (the pair read, the retired-slug lookup, the search fallback).
 *
 *   - another product chosen: the pair page, context first;
 *   - this product chosen again: this product's integrations, as home routes one
 *     product (`/products/:slug#integrations`);
 *   - nothing chosen but text typed: `/search?q=`;
 *   - nothing at all: focus the field.
 *
 * The heading names this product: "Does {product} connect to…?" (ruling 61,
 * 2026-11-16), its own message id, because the product side is already filled. It names
 * the search landmark. The other strings are the home finder's, with their ids:
 * "Connects to", "Type a product name" and "Show integrations".
 *
 * No-JS base layer: a native `<form action="/search" method="get">`, as on home. The
 * picker mounts formless and its input is named `q`, so a native submit searches the
 * typed text. The SSR HTML reads no visitor state.
 *
 * The submit is the hero's second button style (`on-brand-secondary`): "Visit website"
 * stays the hero's one filled button.
 */
@Component({
  selector: 'aec-product-pair-finder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecButton, SearchAutocomplete],
  host: { class: 'block' },
  template: `
    <form
      #pairForm
      class="flex flex-col gap-3"
      role="search"
      aria-labelledby="product-pair-title"
      [attr.aria-busy]="checking() ? 'true' : null"
      action="/search"
      method="get"
      data-testid="product-pair-finder"
      (submit)="onSubmit($event)"
    >
      <p
        id="product-pair-title"
        class="text-t-16 font-semibold break-words text-(--text-on-brand)"
        data-testid="product-pair-title"
      >
        {{ title() }}
      </p>
      <aec-search-autocomplete
        [inputId]="inputId"
        [ownForm]="false"
        [fillOnSelect]="true"
        [kinds]="productKinds"
        [label]="otherLabel"
        [labelVisible]="true"
        [labelClass]="labelClass"
        [placeholder]="placeholder"
        [fieldClass]="fieldClass"
        [focusRingClass]="focusRing"
        inputClass="w-full"
        inputHeightClass="h-11"
        (input)="chosen.set(null)"
        (suggestionChosen)="choose($event)"
        (querySubmitted)="submit()"
      />
      <button
        aecButton
        variant="on-brand-secondary"
        type="submit"
        class="w-full"
        i18n="@@home.hero.pair.submit"
      >
        Show integrations
      </button>
    </form>
  `,
})
export class ProductPairFinder {
  /** The page's product: the side the finder fills. */
  readonly productSlug = input.required<string>();
  /** The page's product name, for the heading. */
  readonly productName = input.required<string>();

  /** Ruling 61 (2026-11-16): the heading names the product already filled in. */
  protected readonly title = computed(
    () =>
      $localize`:@@products.detail.hero.pairFinder.title:Does ${this.productName()}:PRODUCT: connect to…?`,
  );

  private readonly router = inject(Router);
  private readonly http = inject(HttpClient);
  private readonly pairForm = viewChild.required<ElementRef<HTMLFormElement>>('pairForm');

  protected readonly inputId = INPUT_ID;
  /** The Label role's type in the on-brand ink: this finder sits on Forest (AECI-2003). */
  protected readonly labelClass = `mb-2 block ${FIELD_LABEL_FONT_CLASS} text-(--text-on-brand-secondary)`;
  protected readonly otherLabel = $localize`:@@home.hero.pair.other.label:Connects to`;
  protected readonly placeholder = $localize`:@@home.hero.pair.placeholder:Type a product name`;
  protected readonly productKinds = ['product'] as const;
  protected readonly focusRing = ON_FOREST_FOCUS_RING;
  /** The header's field on Forest, at the control radius: a Bone wash with the 3:1 edge. */
  protected readonly fieldClass =
    'rounded-control border aec-on-brand-edge bg-(--surface-on-brand-wash) px-4 text-t-16 text-(--text-on-brand) aec-on-brand-placeholder';

  /** The product committed in the picker; cleared when the field is edited. */
  protected readonly chosen = signal<AutocompleteSuggestion | null>(null);
  /** True while the pair check runs. Drives `aria-busy`. */
  protected readonly checking = signal(false);

  protected choose(suggestion: AutocompleteSuggestion): void {
    this.chosen.set(suggestion.kind === 'product' ? suggestion : null);
  }

  /** The finder's native submit (button click, or Enter on a no-Algolia field). */
  protected onSubmit(event: Event): void {
    if (isReplayedEvent(event)) return; // the native default already ran
    event.preventDefault();
    void this.submit();
  }

  /** Route the finder: the pair page, or `/search?q=`. */
  protected async submit(): Promise<void> {
    if (this.checking()) return;
    const tool = this.productSlug();
    const other = productSlug(this.chosen());
    if (other && other !== tool) {
      this.checking.set(true);
      try {
        await routeFinderPair(
          {
            router: this.router,
            http: this.http,
            changed: () => productSlug(this.chosen()) !== other,
            missingText: (slug) => (slug === other ? this.typedText() : ''),
            typedText: () => this.typedText(),
          },
          tool,
          other,
        );
      } finally {
        this.checking.set(false);
      }
      return;
    }
    if (other === tool) {
      // Home routes a single chosen product to its integrations. Same rule here.
      void this.router.navigate(['/products', tool], { fragment: 'integrations' });
      return;
    }
    const text = this.typedText();
    if (text) {
      navigateToSearchQuery(this.router, text);
      return;
    }
    this.field()?.focus();
  }

  private field(): HTMLInputElement | null {
    return this.pairForm().nativeElement.querySelector<HTMLInputElement>(`#${INPUT_ID}`);
  }

  private typedText(): string {
    return this.field()?.value.trim() ?? '';
  }
}
