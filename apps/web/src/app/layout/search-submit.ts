/**
 * Shared navigation helpers for the header + mobile-overlay search boxes.
 *
 * Both surfaces mount `aec-search-autocomplete` (AECI-144), which keeps the
 * progressive-enhancement `<form action="/search" method="get">` as the no-JS
 * base layer (a native GET still reaches `/search?q=…`) and, with JS, emits
 * `querySubmitted` / `suggestionChosen` instead. These helpers turn those events
 * into SPA navigations, kept here so `SiteHeader` and `NavMenu` share one
 * implementation rather than duplicating the `router.navigate` calls.
 */
import type { Router } from '@angular/router';

import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';

/** Navigate to `/search?q=…` (drops `?q=` when the query is blank). */
export function navigateToSearchQuery(router: Router, query: string): void {
  const q = query.trim();
  void router.navigate(['/search'], { queryParams: q ? { q } : {} });
}

/** Navigate to a chosen suggestion's detail page (`/products/:slug`, etc.). */
export function navigateToSuggestion(router: Router, suggestion: AutocompleteSuggestion): void {
  void router.navigate([...suggestion.routerLink]);
}
