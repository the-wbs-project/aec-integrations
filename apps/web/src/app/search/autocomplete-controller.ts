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
 *
 * Telemetry (AECI-717): every settled round-trip emits one PostHog
 * `autocomplete_searched` through the injected `onSearch` seam. See
 * `AutocompleteSearchedEvent` and `docs/ANALYTICS.md` §4.
 */
import { computed, signal } from '@angular/core';

import type { AutocompleteSearchFn, AutocompleteSuggestion } from './autocomplete-mapping';
import { resultsBucket, type ResultsBucket, type SearchStatus } from './search-telemetry';

/** Search-as-you-type debounce, ms — a touch snappier than `/search`'s 200ms. */
const AUTOCOMPLETE_DEBOUNCE_MS = 180;

/**
 * Payload for the PostHog `autocomplete_searched` event (AECI-717).
 *
 * The header autocomplete's only telemetry was the Datadog RUM
 * `aeci.search.query` action, deleted in AECI-651. This re-homes its latency and
 * error rate onto a DISTINCT event rather than `search_performed`, so that event
 * keeps meaning one `/search` search (the activation funnel's first step,
 * `docs/ANALYTICS.md` §6). It is Tier 3: `Analytics.capture` gates on consent.
 *
 * No `query` property: `search_performed.query` is the one grandfathered
 * free-text exception (`docs/ANALYTICS.md` §2), and it does not extend here.
 */
export interface AutocompleteSearchedEvent {
  /** Whether the round-trip resolved or rejected. */
  readonly status: SearchStatus;
  /**
   * CLIENT round-trip time in ms, around the whole `searchFn` call. Not the same
   * measure as `search_performed.duration_ms` (Algolia `processingTimeMS`).
   * `0` on error, matching `search_performed`.
   */
  readonly duration_ms: number;
  /** Bucket over the TRUE total `nbHits`, not the capped suggestion lists. */
  readonly results_bucket: ResultsBucket;
  /**
   * True when the response was not shown: a newer query started, the box was
   * cleared, or the component was torn down before it landed. It is still a
   * real Algolia query with real latency, so it is counted; filter
   * `superseded = false` for "results the visitor saw".
   */
  readonly superseded: boolean;
}

/** Emit seam for `autocomplete_searched` — injectable so tests assert without the SDK. */
export type AutocompleteSearchedEmitter = (event: AutocompleteSearchedEvent) => void;

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

  constructor(
    private readonly searchFn: AutocompleteSearchFn,
    /** PostHog `autocomplete_searched` seam (AECI-717); the component wires it. */
    private readonly onSearch: AutocompleteSearchedEmitter = () => undefined,
    /** Monotonic clock, ms. A seam so tests get a deterministic `duration_ms`. */
    private readonly now: () => number = () => performance.now(),
  ) {}

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

  /**
   * Run one Algolia round-trip and settle the signals.
   *
   * Telemetry is emitted BEFORE the stale-response guard: a superseded response
   * still completed a real query that incurred latency, so it counts, flagged
   * `superseded: true` (AECI-717).
   */
  private runSearch(query: string): void {
    const mine = ++this.seq;
    const startedAt = this.now();
    this.searchFn(query)
      .then((result) => {
        this.emit({
          status: 'ok',
          duration_ms: Math.round(this.now() - startedAt),
          results_bucket: resultsBucket(result.nbHits ?? 0),
          superseded: mine !== this.seq,
        });
        if (mine !== this.seq) return; // a newer query superseded this one
        this._products.set(result.products);
        this._vendors.set(result.vendors);
        this._hasSearched.set(true);
        this._loading.set(false);
      })
      .catch(() => {
        this.emit({
          status: 'error',
          duration_ms: 0,
          results_bucket: resultsBucket(0),
          superseded: mine !== this.seq,
        });
        if (mine !== this.seq) return;
        // Degrade quietly: clear results but still mark settled so the user gets
        // the "press Enter to search" affordance instead of a stuck spinner.
        this._products.set([]);
        this._vendors.set([]);
        this._hasSearched.set(true);
        this._loading.set(false);
      });
  }

  /** Telemetry must never break the dropdown: a throwing emitter is swallowed. */
  private emit(event: AutocompleteSearchedEvent): void {
    try {
      this.onSearch(event);
    } catch {
      // Deliberately ignored — suggestions matter more than the event.
    }
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
