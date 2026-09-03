import { type Signal, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

import type { ListingView } from './listing-toolbar';

export interface ListingViewController {
  /** Active view, read from `?view=`. Anything but `table` is `cards`. */
  readonly view: Signal<ListingView>;
  /** Write the chosen view to `?view=`, merging the rest of the query. */
  set(value: ListingView): void;
}

/**
 * `?view=` ownership for a product listing page — the companion to
 * `aec-listing-toolbar`, extracted from `products-index.ts` by AECI-657 when the
 * taxonomy browse pages became a second host.
 *
 * **A URL param, never a cookie.** Both hosts are edge-cached, and the native
 * Workers Cache is keyed by URL, not cookies — so a cookie-driven view would let
 * the first visitor's choice poison the entry for everyone (`CLAUDE.md`
 * §"Cached SSR routes must render visitor-state-neutral HTML"). `view` is
 * already in `LISTING_CACHE_KEY_PARAMS` (`server-runtime.ts`), so each view gets
 * its own edge entry, and `CACHE_STRATEGY.md` §4a's superset rule stays
 * satisfied for both routes.
 *
 * It is deliberately kept **out of the fetch params**: the two views render the
 * same rows, so forking the data cache on it would double the API traffic for
 * identical payloads.
 *
 * Note the product-PAIR page's `?view=basic|detailed` is a *different* param on
 * a different route (`STAGE_1_5_SPEC.md` §7) that additionally remembers itself
 * in a post-hydration cookie. This one has no cookie: the pair page's toggle
 * hides content, so a returning reader benefits from the memory, whereas here
 * both views show the identical set and the default is not worth a cookie.
 *
 * Call from a field initializer (an injection context), like
 * `createPaginatedIndex`.
 */
export function createListingView(): ListingViewController {
  const route = inject(ActivatedRoute);
  const router = inject(Router);
  const queryParamMap = toSignal(route.queryParamMap, { requireSync: true });

  return {
    view: computed<ListingView>(() =>
      queryParamMap().get('view') === 'table' ? 'table' : 'cards',
    ),
    set(value: ListingView): void {
      void router.navigate([], {
        relativeTo: route,
        queryParams: { view: value },
        queryParamsHandling: 'merge',
      });
    },
  };
}
