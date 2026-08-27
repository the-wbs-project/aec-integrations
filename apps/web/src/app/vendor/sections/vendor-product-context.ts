import { computed, inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type ParamMap } from '@angular/router';
import { combineLatest, map } from 'rxjs';

import type { VendorProduct } from '@aeci/shared';

import { VendorPortalStore } from '../vendor-portal-store';

/**
 * "Which product is this page about?" — resolved once, shared by the product
 * shell and each of its three sections (AECI-666).
 *
 * ── WHY A FUNCTION AND NOT A SERVICE ────────────────────────────────────────
 * The obvious alternative is a route-scoped `providers: [VendorProductContext]`
 * on the product route. That would work, but it buys nothing here and costs the
 * preview: `VendorPortalStore` is deliberately NOT root-provided so
 * `/preview/vendor-dashboard` can shadow it through DI, and a second injectable
 * in the chain is a second thing every test host and the preview have to
 * provide. This is a pure derivation over two things the caller already has, so
 * it is a function that each component calls in its own injection context — the
 * `vendorCan(...)` pattern in `vendor-capabilities.ts`, one level down.
 *
 * ── WHY THE SLUG IS READ REACTIVELY ─────────────────────────────────────────
 * Choosing a product from the nav menu is a same-route navigation: the param
 * changes, the component does not re-create. A snapshot read would pin every
 * section to whichever product happened to be selected when it first rendered.
 * (`vendor-products-page.ts` learned this already; this is the same rule, moved
 * somewhere all three sections can share it.)
 */
export interface VendorProductContext {
  /** The `:productSlug` segment, or `null` on the bare `…/products` path. */
  readonly routeSlug: Signal<string | null>;
  /** The vendor's whole catalog, from the one `GET /api/vendor/me` read. */
  readonly products: Signal<readonly VendorProduct[]>;
  /**
   * The product this page is about: the routed one when it is genuinely owned,
   * else the primary, else the first. `null` when the catalog is empty or the
   * URL names a product this vendor does not own.
   */
  readonly product: Signal<VendorProduct | null>;
  /**
   * The URL names a product this vendor does not own. Called out rather than
   * silently redirected to the default: the URL asserts a specific product, and
   * quietly rendering a different one under it is how a vendor edits the wrong
   * listing. Ownership is enforced server-side regardless — `PATCH
   * /api/vendor/products/:id` proves it against the session — so this is a
   * clarity guard, not the gate.
   */
  readonly unknownProduct: Signal<boolean>;
}

export function vendorProductContext(): VendorProductContext {
  const store = inject(VendorPortalStore);
  const route = inject(ActivatedRoute);

  // The segment lives on the PRODUCT route, but a section component sits one
  // level below it, and `ActivatedRoute.paramMap` does not inherit a parent's
  // params for a non-empty-path child. So this combines every level's `paramMap`
  // rather than reading the local one — and combines the OBSERVABLES, not the
  // snapshots, because picking a product from the nav menu is a same-route
  // navigation: the param changes and the component is reused, so a snapshot read
  // would pin each section to whichever product was selected when it first
  // rendered.
  const routeSlug = toSignal(
    combineLatest(route.pathFromRoot.map((r) => r.paramMap)).pipe(map(firstProductSlug)),
    { initialValue: firstProductSlug(route.pathFromRoot.map((r) => r.snapshot.paramMap)) },
  );

  const products = computed(() => store.me()?.products ?? []);

  const unknownProduct = computed(() => {
    const wanted = routeSlug();
    return wanted !== null && !products().some((p) => p.slug === wanted);
  });

  const product = computed<VendorProduct | null>(() => {
    const all = products();
    const wanted = routeSlug();
    if (wanted !== null) return all.find((p) => p.slug === wanted) ?? null;
    return all.find((p) => p.is_primary) ?? all[0] ?? null;
  });

  return { routeSlug, products, product, unknownProduct };
}

/** The first `:productSlug` found anywhere from the root down. Exactly one route
 *  in the chain declares it, so "first" and "the one" are the same thing. */
function firstProductSlug(maps: readonly ParamMap[]): string | null {
  for (const m of maps) {
    const slug = m.get('productSlug');
    if (slug) return slug;
  }
  return null;
}
