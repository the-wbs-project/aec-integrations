import { type Signal, afterNextRender, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';

import { RoleStatus } from '../../auth/role-status';
import { SessionStatus } from '../../auth/session-status';

import { ListingViewPreference } from './listing-view-preference';
import type { ListingView } from './listing-toolbar';

export interface ListingViewController {
  /** Active view. `?view=` when the URL carries it, else the remembered
   *  preference applied post-hydration, else `cards`. */
  readonly view: Signal<ListingView>;
  /** Write the chosen view to `?view=`, merging the rest of the query, and
   *  remember the choice for the next visit (profile when signed in, cookie
   *  otherwise — see `ListingViewPreference`). */
  set(value: ListingView): void;
}

/**
 * `?view=` ownership for a product listing page — the companion to
 * `aec-listing-toolbar`, extracted from `products-index.ts` by AECI-657 when the
 * taxonomy browse pages became a second host.
 *
 * **A URL param as the source of truth, remembered as a default.** Both hosts
 * are edge-cached, and the native Workers Cache is keyed by URL, not cookies —
 * so a server-read cookie would let the first visitor's choice poison the entry
 * for everyone (`CLAUDE.md` §"Cached SSR routes must render visitor-state-neutral
 * HTML"). `view` is already in `LISTING_CACHE_KEY_PARAMS` (`server-runtime.ts`),
 * so each explicitly-chosen view gets its own edge entry. On top of that, the
 * user's last explicit choice is remembered client-side (`ListingViewPreference`:
 * `profiles.listing_view_preference` when signed in, the `aeci_listing_view`
 * cookie otherwise) and applied POST-HYDRATION only — an `afterNextRender` read
 * can never leak into the cached SSR HTML. An explicit `?view=` in the URL always
 * wins (deep-link + cache-key fork); the remembered value only supplies the
 * default when the URL carries none.
 *
 * **The restore sets a signal, it does NOT navigate.** Navigating to
 * `?view=<remembered>` after hydration would look tidier, but the index's
 * `httpResource` rebuilds its request from the whole query-param map, so a
 * restore navigation cancels the in-flight `/api/products` fetch and re-issues an
 * identical one — a doubled API call on every listing page load for every
 * table-preferring user, plus URL churn on a page the visitor never touched.
 * This mirrors the pair page's `aeci_pair_view` handling exactly.
 *
 * `view` is deliberately kept **out of the fetch params**: the two views render
 * the same rows, so forking the data cache on it would double the API traffic for
 * identical payloads.
 *
 * Note the product-PAIR page's `?view=basic|detailed` is a *different* param on
 * a different route (`STAGE_1_5_SPEC.md` §7) that remembers itself in the same
 * post-hydration cookie pattern.
 *
 * Call from a field initializer (an injection context), like
 * `createPaginatedIndex`.
 */
export function createListingView(): ListingViewController {
  const route = inject(ActivatedRoute);
  const router = inject(Router);
  const session = inject(SessionStatus);
  const role = inject(RoleStatus);
  const preference = inject(ListingViewPreference);
  const queryParamMap = toSignal(route.queryParamMap, { requireSync: true });

  /** The remembered choice, `null` until the post-hydration read lands (and on
   *  the server, where it never lands at all). */
  const remembered = signal<ListingView | null>(null);

  // Browser-only (`afterNextRender` never runs during SSR), so the remembered
  // choice can't influence the cache-shared SSR render.
  afterNextRender(() => {
    if (!session.signedIn()) {
      remembered.set(preference.rememberedFromCookie());
      return;
    }
    // Signed in: the remembered value lives on the profile, so wait for the one
    // `GET /api/account` probe the header already makes (coalesced; a no-op once
    // it has landed). The cookie covers the gap until it resolves.
    remembered.set(preference.rememberedFromCookie());
    void role.ensureProbed().then(() => {
      const fromProfile = preference.rememberedFromProfile();
      if (fromProfile !== null) remembered.set(fromProfile);
    });
  });

  return {
    view: computed<ListingView>(() => {
      // An explicit URL param wins — it's deep-linkable and cache-key-forked, so
      // the SSR render is already correct for it.
      const param = queryParamMap().get('view');
      if (param === 'table' || param === 'cards') return param;
      return remembered() ?? 'cards';
    }),
    set(value: ListingView): void {
      preference.persist(value);
      remembered.set(value);
      void router.navigate([], {
        relativeTo: route,
        queryParams: { view: value },
        queryParamsHandling: 'merge',
      });
    },
  };
}
