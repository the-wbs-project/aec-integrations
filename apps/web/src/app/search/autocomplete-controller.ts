/**
 * State machine for the header autocomplete (AECI-144 / Phase 3.11).
 *
 * The analogue of `SearchController` for the lightweight dropdown: it owns the
 * debounce, the stale-response guard, and the suggestion/`hasSearched` signals —
 * but NO DOM, NO Angular DI, and NO Algolia SDK. It is constructed with an
 * injected `AutocompleteSearchFn` (the factory seam), so it unit-tests with a
 * `vi.fn()` fake and `vi.useFakeTimers()` — exactly like
 * `search-controller.component.spec.ts` drives the structural `InstantSearchLib`.
 *
 * Debounce mirrors `SearchController` (manual `setTimeout`/`clearTimeout`): the
 * `query` signal mirrors the input instantly (zero input lag) while the network
 * search is coalesced. A monotonic sequence counter drops stale responses so a
 * slow earlier query can't overwrite a fast later one during rapid typing.
 */
import { computed, signal } from '@angular/core';

import type { AutocompleteSearchFn, AutocompleteSuggestion } from './autocomplete-mapping';

/** Search-as-you-type debounce, ms — a touch snappier than `/search`'s 200ms. */
const AUTOCOMPLETE_DEBOUNCE_MS = 180;

export class AutocompleteController {
  /** Current query text — mirrors the input synchronously (no debounce). */
  readonly query = signal('');

  private readonly _products = signal<readonly AutocompleteSuggestion[]>([]);
  private readonly _vendors = signal<readonly AutocompleteSuggestion[]>([]);
  private readonly _loading = signal(false);
  private readonly _hasSearched = signal(false);

  /** Product suggestions for the latest settled query. */
  readonly products = this._products.asReadonly();
  /** Vendor suggestions for the latest settled query. */
  readonly vendors = this._vendors.asReadonly();
  /** Whether a network search is in flight. */
  readonly loading = this._loading.asReadonly();
  /** True once a non-blank query has settled — gates the "no matches" row. */
  readonly hasSearched = this._hasSearched.asReadonly();

  /** Flat list across both entities — drives the empty-state check. */
  readonly suggestions = computed<readonly AutocompleteSuggestion[]>(() => [
    ...this._products(),
    ...this._vendors(),
  ]);

  /** True when a settled search returned nothing (show "no matches"). */
  readonly isEmpty = computed(() => this._hasSearched() && this.suggestions().length === 0);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic request id; a resolved search is ignored unless it is still the latest. */
  private seq = 0;

  constructor(private readonly searchFn: AutocompleteSearchFn) {}

  /** Mirror the query to the signal now, run the (debounced) search. */
  setQuery(value: string): void {
    this.query.set(value);
    const trimmed = value.trim();

    if (this.debounceTimer) clearTimeout(this.debounceTimer);

    if (trimmed.length === 0) {
      // Blank input closes the dropdown: clear results, no network, no spinner.
      this.seq++; // invalidate any in-flight response so it can't reopen the list
      this._products.set([]);
      this._vendors.set([]);
      this._loading.set(false);
      this._hasSearched.set(false);
      return;
    }

    this._loading.set(true);
    this.debounceTimer = setTimeout(() => this.runSearch(trimmed), AUTOCOMPLETE_DEBOUNCE_MS);
  }

  private runSearch(query: string): void {
    const mine = ++this.seq;
    this.searchFn(query)
      .then((result) => {
        if (mine !== this.seq) return; // a newer query superseded this one
        this._products.set(result.products);
        this._vendors.set(result.vendors);
        this._hasSearched.set(true);
        this._loading.set(false);
      })
      .catch(() => {
        if (mine !== this.seq) return;
        // Degrade quietly: clear results but still mark settled so the user gets
        // the "press Enter to search" affordance instead of a stuck spinner.
        this._products.set([]);
        this._vendors.set([]);
        this._hasSearched.set(true);
        this._loading.set(false);
      });
  }

  /** Clear the pending timer; called from the component's `DestroyRef`. */
  dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.seq++; // drop any in-flight response after teardown
  }
}
