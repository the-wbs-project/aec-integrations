import { Injectable, inject } from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  NavigationEnd,
  NavigationStart,
  Router,
} from '@angular/router';

/**
 * The rows a listing showed when the reader left it, for Back and Forward only
 * (AECI-1900).
 *
 * Why it exists. On Back to `/products` the router restores the saved scroll
 * position one frame after the listing renders. The listing used to fetch its
 * rows again, so that frame had no rows: the page was about 1,700px tall and a
 * position of 2,770 could not be reached. The rows arrived a few frames later
 * and the reader landed somewhere else. Keeping the pages the reader had loaded,
 * including every "Load more" page, lets the first render on Back be as tall as
 * the page they left. The router's own restoration then lands where it should.
 * Nothing here scrolls.
 *
 * Rules.
 * - In memory, per browser tab. It is never written to localStorage,
 *   sessionStorage or a cookie: it is derived data, not visitor state, and a
 *   reload must start empty. The server never reads or writes it.
 * - Bounded to the last {@link LISTING_HISTORY_LIMIT} listings, least recently
 *   used first out.
 * - Bounded in age to {@link LISTING_HISTORY_MAX_AGE_MS} from when the reader
 *   left the listing. A restore makes no request, so without a bound a tab left
 *   open for days could show rows the server now withholds: a hidden product, or
 *   a logo an unclaimed listing no longer shows (ADR 0051). Five minutes is the
 *   edge TTL of the index and browse pages, so a restored list is never older
 *   than a fresh visit to the edge could be.
 * - Keyed by every axis of the payload (see {@link listingHistoryKey}). This
 *   codebase has rendered a swapped list before because a cache key dropped an
 *   axis, so two different lists must never share an entry.
 * - Read only on a history traversal (`popstate`). A fresh navigation to the same
 *   URL fetches as it always has. `createPaginatedIndex` owns that rule.
 */
export const LISTING_HISTORY_LIMIT = 5;

/** How long an entry stays usable after it was written: 5 minutes. */
export const LISTING_HISTORY_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The store key: the listing's URL path plus the request line of the first page
 * in the buffer.
 *
 * The request line is `indexRequestLine()` output, so it already carries the API
 * path, the page the buffer starts at, the page size, the sort, the locked term
 * (`{kind}_slug`) and every cross-filter. The path adds the route, so two routes
 * that happen to ask for the same request never share an entry either.
 */
export function listingHistoryKey(path: string, requestLine: string): string {
  return `${path} ${requestLine}`;
}

/**
 * The URL path of a routed listing, from its snapshot. Query params are left out
 * on purpose: the ones that change the payload are in the request line, and
 * presentation-only ones such as `?view=` do not change the rows.
 */
export function listingPath(snapshot: ActivatedRouteSnapshot): string {
  const segments = snapshot.pathFromRoot.flatMap((r) => r.url.map((s) => s.path));
  return `/${segments.join('/')}`;
}

/**
 * The bound and age rules both stores share: the last
 * {@link LISTING_HISTORY_LIMIT} entries, least recently used first out, each
 * usable for {@link LISTING_HISTORY_MAX_AGE_MS} after it was written.
 *
 * One entry per history entry, not per URL. A reader can open the same listing
 * URL twice in one tab with a different number of pages loaded each time. Keyed
 * by URL alone, leaving the second visit overwrote the first, and a later Back
 * to the first visit restored the wrong number of pages. So an entry carries the
 * router's id for its history entry (see {@link HistoryTraversal}), and a read
 * with an id matches that id exactly. A read without an id, which happens only
 * when the entry being returned to carries no router id, falls back to the
 * newest entry for the key.
 */
abstract class BoundedHistoryStore<V> {
  // Insertion order is recency order: a read or write moves the entry to the end.
  private readonly entries = new Map<
    string,
    { key: string; entryId: number | null; savedAt: number; value: V }
  >();

  /** The value for `key` at history entry `entryId`, or `null`. An entry past its age is dropped. */
  protected readValue(key: string, entryId: number | null, now: number): V | null {
    const slot = entryId === null ? this.newestSlotFor(key) : slotOf(key, entryId);
    const entry = slot === null ? undefined : this.entries.get(slot);
    if (slot === null || entry === undefined) return null;
    this.entries.delete(slot);
    if (now - entry.savedAt > LISTING_HISTORY_MAX_AGE_MS) return null;
    this.entries.set(slot, entry);
    return entry.value;
  }

  protected writeValue(key: string, entryId: number | null, value: V, now: number): void {
    const slot = slotOf(key, entryId);
    this.entries.delete(slot);
    this.entries.set(slot, { key, entryId, savedAt: now, value });
    while (this.entries.size > LISTING_HISTORY_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private newestSlotFor(key: string): string | null {
    let found: string | null = null;
    for (const [slot, entry] of this.entries) if (entry.key === key) found = slot;
    return found;
  }

  /** How many entries are held. For specs. */
  get size(): number {
    return this.entries.size;
  }
}

function slotOf(key: string, entryId: number | null): string {
  return `${entryId ?? '-'} ${key}`;
}

@Injectable({ providedIn: 'root' })
export class ListingHistoryStore extends BoundedHistoryStore<readonly unknown[]> {
  /**
   * The pages stored under `key`, oldest page first, or `null`. An entry older
   * than {@link LISTING_HISTORY_MAX_AGE_MS} is dropped and reads as `null`, so
   * the listing fetches. `entryId` is the history entry a Back or Forward
   * returns to (`null` when it carries no router id). `now` is for specs.
   */
  read<T>(key: string, entryId: number | null, now: number = Date.now()): readonly T[] | null {
    return this.readValue(key, entryId, now) as readonly T[] | null;
  }

  /**
   * Store the pages a listing rendered for history entry `entryId`. An empty
   * list stores nothing. `now` is for specs.
   */
  write<T>(
    key: string,
    entryId: number | null,
    pages: readonly T[],
    now: number = Date.now(),
  ): void {
    if (pages.length === 0) return;
    this.writeValue(key, entryId, [...pages], now);
  }
}

/**
 * The filter panel's last counts response, for Back and Forward only (AECI-1900).
 *
 * Why it exists. On a filtered listing the rows are short and the filter panel
 * sets the page height. On Back the panel fetched its counts again, so in the
 * frame the router restored the position it was about 127px tall, not about
 * 1,000. The page was too short, the position was clamped, and scroll anchoring
 * moved the reader when the counts arrived. Measured on `/products` with one
 * filter: left at 1,576, landed at 1,925.
 *
 * Same rules as {@link ListingHistoryStore}: in memory per tab, never persisted,
 * the last {@link LISTING_HISTORY_LIMIT} entries, {@link LISTING_HISTORY_MAX_AGE_MS}
 * old at most, read only when the panel is created by a Back or Forward. The key
 * is {@link listingHistoryKey} over the counts request line, which carries every
 * filter and the locked term. Its own instance, so counts never evict rows.
 */
@Injectable({ providedIn: 'root' })
export class FacetHistoryStore extends BoundedHistoryStore<unknown> {
  /** The counts stored for `key` at history entry `entryId`, or `null`. `now` is for specs. */
  read<T>(key: string, entryId: number | null, now: number = Date.now()): T | null {
    return this.readValue(key, entryId, now) as T | null;
  }

  /** Store the counts the panel rendered for history entry `entryId`. `now` is for specs. */
  write<T>(key: string, entryId: number | null, counts: T, now: number = Date.now()): void {
    this.writeValue(key, entryId, counts, now);
  }
}

/**
 * Whether the page being built is a Back or Forward, and which history entry it
 * is (AECI-1900).
 *
 * `router.currentNavigation()` answers the first only while the navigation runs.
 * The listing's controller is built inside it, but the filter panel is a child
 * built in the page's first render, which can come after `NavigationEnd`. This
 * keeps the latest `NavigationStart` and answers for the navigation in progress
 * or the one that rendered the page on screen, and for nothing later.
 *
 * The history entry id. The router writes `navigationId` (the id of the
 * navigation that rendered the entry) into `history.state` on every navigation,
 * and a Back or Forward rewrites the entry it lands on with its own new id
 * (`replaceState` in Angular 22's `HistoryStateManager`). So:
 * - the entry on screen is the id of the last `NavigationEnd`. A listing records
 *   it when the reader leaves ({@link currentEntryId});
 * - a Back or Forward to that entry carries the same id in the public
 *   `NavigationStart.restoredState.navigationId` ({@link restoredEntryId}).
 * `Navigation` does not expose `restoredState`, which is why this listens to the
 * events rather than reading `router.currentNavigation()`.
 *
 * Browser only. It starts listening when a listing first injects it, which is
 * before any listing could have been stored, so it has seen every navigation a
 * restore depends on.
 */
@Injectable({ providedIn: 'root' })
export class HistoryTraversal {
  private readonly router = inject(Router);
  private latest: { id: number; popstate: boolean; restoredId: number | null } | null = null;
  private onScreen: number | null = null;

  constructor() {
    this.router.events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        this.latest = {
          id: e.id,
          popstate: e.navigationTrigger === 'popstate',
          restoredId: e.restoredState?.navigationId ?? null,
        };
      } else if (e instanceof NavigationEnd) {
        this.onScreen = e.id;
      }
    });
  }

  /** True when the navigation in progress, or the one that rendered the page on screen, is a Back or Forward. */
  isTraversal(): boolean {
    const latest = this.latest;
    if (latest === null || !latest.popstate) return false;
    return latest.id === this.router.currentNavigation()?.id || latest.id === this.onScreen;
  }

  /** On a Back or Forward, the id of the history entry it returns to, or `null` when that entry carries none. */
  restoredEntryId(): number | null {
    return this.isTraversal() ? (this.latest?.restoredId ?? null) : null;
  }

  /** The id of the history entry on screen, or `null` before the first `NavigationEnd` this has seen. */
  currentEntryId(): number | null {
    return this.onScreen;
  }
}
