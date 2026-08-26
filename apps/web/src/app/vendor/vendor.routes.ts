import type { Routes } from '@angular/router';

import { vendorHomeRedirectGuard } from './vendor-home-redirect.guard';
import { vendorMeResolver } from './vendor-me.resolver';

/**
 * The vendor portal's section routes — the children of the dashboard shell.
 *
 * Exported separately from {@link VENDOR_ROUTES} because THREE surfaces mount
 * them and they must not drift:
 *
 *   1. `/vendor/:vendorSlug/...` — the real, gated portal (below).
 *   2. `/preview/vendor-dashboard/...` — the dev-only concept preview, which
 *      renders the same shell against fixtures (`preview/preview.routes.ts`).
 *   3. The shell's own spec, which mounts them under a test host.
 *
 * Every section reads its data from `VendorPortalStore` (seeded by the surface
 * owner) rather than from route data, so none of them needs a resolver: the
 * portal's ONE authenticated read (`GET /api/vendor/me`) happens on the parent
 * route and stays there. Navigating between sections therefore costs no
 * round-trip, and the AECI-631 live entitlement flip keeps landing without a
 * reload.
 *
 * ── WHY `products` IS TWO ENTRIES ────────────────────────────────────────────
 * A product picker that changes the URL needs a slug segment, but the section is
 * reachable from the nav (which has no product in hand), so the bare path has to
 * render too and pick a default. Angular has no optional path segment, so this is
 * two `Route`s onto one component. The cost is that stepping from the bare path
 * to a slugged one re-creates the component (different `routeConfig`, so the
 * default `shouldReuseRoute` says no) and re-fetches the public taxonomy once;
 * every subsequent product change reuses the same route and does not.
 */
export const VENDOR_SECTION_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'overview' },
  {
    path: 'overview',
    loadComponent: () =>
      import('./sections/vendor-overview-section').then((m) => m.VendorOverviewSection),
  },
  {
    path: 'profile',
    loadComponent: () =>
      import('./sections/vendor-profile-section').then((m) => m.VendorProfileSection),
  },
  {
    path: 'products',
    loadComponent: () =>
      import('./sections/vendor-products-page').then((m) => m.VendorProductsPage),
  },
  {
    path: 'products/:productSlug',
    loadComponent: () =>
      import('./sections/vendor-products-page').then((m) => m.VendorProductsPage),
  },
  {
    path: 'integrations',
    loadComponent: () =>
      import('./sections/vendor-integrations-page').then((m) => m.VendorIntegrationsPage),
  },
  {
    path: 'seats',
    loadComponent: () => import('./sections/vendor-seats-page').then((m) => m.VendorSeatsPage),
  },
];

/**
 * AECI-522 — the Stage 2 vendor portal, mounted lazily at `/vendor` by
 * `app.routes.ts`. The signed-in vendor's dashboard over `/api/vendor/*`
 * (AECI-520). NOTE the singular `/vendor` — the public `/vendors/:slug` detail is
 * a different, cacheable route.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────
 * A LAYOUT route (the `/admin` shape): the vendor slug AND the section are both
 * in the URL — `/vendor/acme/products/revit` — so every section is linkable,
 * bookmarkable, and reachable with Back. `VendorPage` holds the gate, the head,
 * the store and the live-sync; the sections are its children.
 *
 * `vendorMeResolver` calls `GET /api/vendor/me` (gated by `requireVendor()`): a
 * 401/403/404 → a 404 render that never reveals the surface, a 200 → the
 * dashboard, a 5xx rethrows. It ALSO 404s a `:vendorSlug` that is not the
 * session's own vendor, so a URL can never render someone else's dashboard.
 *
 * Bare `/vendor` keeps working — both header menus link to it, and neither has a
 * vendor payload to build a slugged link from. The guard resolves the caller's
 * vendor and redirects to `/vendor/:vendorSlug/overview` (a real 302 under SSR),
 * or marks a 404 in place for anyone `requireVendor()` rejects, which is why its
 * component is the global `NotFound`.
 *
 * ── WHY THIS WHOLE FILE IS LAZY ─────────────────────────────────────────────
 * `app.routes.ts` reaches it through `loadChildren`, so the resolver, the guard
 * and the section table all land in a chunk that only a vendor ever downloads.
 * The portal is a private surface used by a handful of accounts; none of it
 * belongs in the initial bundle every anonymous visitor pays for (which sits
 * close enough to the 1 MB budget that eagerly importing the guard alone broke
 * the build).
 *
 * A logged-out visitor is bounced to `/auth/login` by the worker-level gate
 * before SSR (`server-runtime.ts` `isVendorPath`, which already covers the
 * sub-paths). Non-cacheable + `Cache-Tag`-free by the fail-closed classifier —
 * no `server-runtime.ts` change was needed for the deeper paths.
 */
export const VENDOR_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    canActivate: [vendorHomeRedirectGuard],
    loadComponent: () => import('../not-found/not-found').then((m) => m.NotFound),
  },
  /**
   * AECI-664 — seat-invite redemption. MUST stay ahead of `:vendorSlug`, or the
   * literal `invite` segment is captured as a vendor slug and the resolver 404s
   * the one page a non-vendor is supposed to reach.
   *
   * Deliberately OUTSIDE the `:vendorSlug` layout route: everything under it is
   * behind `vendorMeResolver`, which 404s anyone `requireVendor()` rejects — i.e.
   * exactly the audience of an invite. It stays under `/vendor/` so the
   * worker-level anon gate still bounces a signed-out visitor to
   * `/auth/login?return=<this path>` with the token intact, which IS the flow.
   */
  {
    path: 'invite/:token',
    loadComponent: () => import('./vendor-invite-page').then((m) => m.VendorInvitePage),
  },
  {
    path: ':vendorSlug',
    loadComponent: () => import('./vendor-page').then((m) => m.VendorPage),
    resolve: { me: vendorMeResolver },
    children: VENDOR_SECTION_ROUTES,
  },
];
