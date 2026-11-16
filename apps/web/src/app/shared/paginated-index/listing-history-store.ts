import { Injectable } from '@angular/core';
import type { ActivatedRouteSnapshot } from '@angular/router';

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
 * - Keyed by every axis of the payload (see {@link listingHistoryKey}). This
 *   codebase has rendered a swapped list before because a cache key dropped an
 *   axis, so two different lists must never share an entry.
 * - Read only on a history traversal (`popstate`). A fresh navigation to the same
 *   URL fetches as it always has. `createPaginatedIndex` owns that rule.
 */
export const LISTING_HISTORY_LIMIT = 5;

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

@Injectable({ providedIn: 'root' })
export class ListingHistoryStore {
  // Insertion order is recency order: a read or write moves the key to the end.
  private readonly entries = new Map<string, readonly unknown[]>();

  /** The pages stored under `key`, oldest page first, or `null`. */
  read<T>(key: string): readonly T[] | null {
    const pages = this.entries.get(key);
    if (pages === undefined) return null;
    this.entries.delete(key);
    this.entries.set(key, pages);
    return pages as readonly T[];
  }

  /** Store the pages a listing rendered. An empty list stores nothing. */
  write<T>(key: string, pages: readonly T[]): void {
    if (pages.length === 0) return;
    this.entries.delete(key);
    this.entries.set(key, [...pages]);
    while (this.entries.size > LISTING_HISTORY_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** How many listings are held. For specs. */
  get size(): number {
    return this.entries.size;
  }
}
