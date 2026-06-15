import { Routes } from '@angular/router';

import { adminSummaryResolver } from './admin/admin-summary.resolver';
import { homeBrowseResolver } from './home/home-browse.resolver';
import { homeStatsResolver } from './home/home-stats.resolver';
import { integrationDetailResolver } from './integrations/integration-detail.resolver';
import { notFoundResolver } from './not-found/not-found.resolver';
import { productDetailResolver } from './products/product-detail.resolver';
import { reviewProductResolver } from './reviews/review-product.resolver';
import {
  categoryBrowseResolver,
  audienceBrowseResolver,
  phaseBrowseResolver,
} from './taxonomy/taxonomy-browse.resolver';
import {
  categoriesIndexResolver,
  audiencesIndexResolver,
  phasesIndexResolver,
} from './taxonomy/taxonomy-index.resolver';
import { vendorDetailResolver } from './vendors/vendor-detail.resolver';

export const routes: Routes = [
  // AECI-186 — Phase 4.11 home assembly. Two parallel SSR resolvers feed the
  // page (both via the service binding; hydration reads from TransferState):
  //   - `browse` (`homeBrowseResolver`, AECI-184) — the live aggregate taxonomy
  //     (`GET /api/taxonomy`, with `product_count`) for the "Browse by" grids.
  //     Counts are LIVE, not `stats_cache` (§10).
  //   - `stats` (`homeStatsResolver`, AECI-186) — the daily `stats_cache`
  //     snapshot (`GET /api/stats/home`, AECI-179) for the stats cards +
  //     recently-added + trending sections.
  // The home carries `Cache-Tag: route:index,taxonomy` (`cacheTagInputsForPath`),
  // so a taxonomy edit purges it; the daily stats snapshot needs no purge handle
  // (the §4 900s edge TTL bounds staleness). Home meta/JSON-LD is set by the
  // `Home` component (static copy), not a resolver.
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./home/home').then((m) => m.Home),
    resolve: { browse: homeBrowseResolver, stats: homeStatsResolver },
  },
  {
    path: '_demo/spartan',
    loadComponent: () => import('./demo/spartan-demo').then((m) => m.SpartanDemo),
  },
  {
    path: 'products',
    pathMatch: 'full',
    loadComponent: () => import('./products/products-index').then((m) => m.ProductsIndex),
  },
  // AECI-57 — Phase 2.11 product detail page. The detail route resolves data
  // SSR-side via the service binding (see `productDetailResolver`).
  // AECI-128 — claim/correction submission forms. One `RequestForm` component
  // renders all four routes (products/vendors × claim/correction), keyed by the
  // static route `data` ({ entity, kind }); it addresses its target by
  // (entity, slug) and the API resolves the slug, so it works whether landed on
  // (SSR) or reached via a detail-page CTA (client-side `[routerLink]`).
  // Replaced the noindex `PlaceholderPage` stubs (formerly AECI-108).
  {
    path: 'products/:slug/claim',
    loadComponent: () => import('./requests/request-form').then((m) => m.RequestForm),
    data: { entity: 'product', kind: 'claim' },
  },
  {
    path: 'products/:slug/correction',
    loadComponent: () => import('./requests/request-form').then((m) => m.RequestForm),
    data: { entity: 'product', kind: 'correction' },
  },
  // AECI-200 — Phase 5.9 authenticated review-submission form. Uses the
  // dedicated `reviewProductResolver` for `product.id` (the POST body) +
  // `name`/`slug` (copy + back link); a null product renders the shared 404
  // shell. It is the detail-resolver scaffold WITHOUT the product-detail side
  // effects (no canonical/JSON-LD, no `Cache-Tag`, and `trackPageView: false`)
  // — reusing `productDetailResolver` would fire a product page-view on every
  // SSR landing here and miscount review visits as product views. The route is
  // non-cacheable (no `ROUTE_CACHE_PATTERNS` match → fail-closed
  // `private, no-store`), and the SSR Worker gates it: an unauthenticated
  // visitor is 303-redirected to `/auth/login?return=<path>` before SSR (see
  // `server-runtime.ts`'s review auth-gate). The API (`POST /api/reviews`,
  // AECI-197) is the real enforcement point on submit.
  {
    path: 'products/:slug/review',
    loadComponent: () => import('./reviews/review-form').then((m) => m.ReviewForm),
    resolve: { product: reviewProductResolver },
  },
  {
    path: 'products/:slug',
    loadComponent: () => import('./products/product-detail').then((m) => m.ProductDetailPage),
    resolve: { product: productDetailResolver },
  },
  // AECI-59 — Phase 2.13 vendor detail. Resolver runs SSR-side, hydration reads
  // from TransferState. Claim/correction forms (AECI-128) use the shared
  // `RequestForm` — see the product block above.
  //
  // AECI-165 removed the `/vendors` index/listing page (orphaned from the nav
  // after AECI-160). `/vendors` now 301-redirects to `/products` at the SSR
  // Worker (see `server-runtime.ts`), so there is no Angular index route here —
  // only the detail + claim/correction routes below.
  {
    path: 'vendors/:slug/claim',
    loadComponent: () => import('./requests/request-form').then((m) => m.RequestForm),
    data: { entity: 'vendor', kind: 'claim' },
  },
  {
    path: 'vendors/:slug/correction',
    loadComponent: () => import('./requests/request-form').then((m) => m.RequestForm),
    data: { entity: 'vendor', kind: 'correction' },
  },
  {
    path: 'vendors/:slug',
    loadComponent: () => import('./vendors/vendor-detail').then((m) => m.VendorDetailPage),
    resolve: { vendor: vendorDetailResolver },
  },
  // AECI-61 / AECI-157 — Phase 2.15 taxonomy index + browse pages. Both the
  // three flat indexes and the three `:slug` browse pages each share one
  // component + one resolver factory, keyed by the static `data.kind`. AECI-157
  // lit up the `/audiences` + `/phases` indexes (originally deferred to Phase 3).
  // Resolvers run SSR-side; hydration reads from TransferState.
  {
    path: 'categories',
    pathMatch: 'full',
    loadComponent: () => import('./taxonomy/taxonomy-index').then((m) => m.TaxonomyIndexPage),
    data: { kind: 'category' },
    resolve: { terms: categoriesIndexResolver },
  },
  {
    path: 'categories/:slug',
    loadComponent: () => import('./taxonomy/taxonomy-browse').then((m) => m.TaxonomyBrowsePage),
    data: { kind: 'category' },
    resolve: { term: categoryBrowseResolver },
  },
  {
    path: 'audiences',
    pathMatch: 'full',
    loadComponent: () => import('./taxonomy/taxonomy-index').then((m) => m.TaxonomyIndexPage),
    data: { kind: 'audience' },
    resolve: { terms: audiencesIndexResolver },
  },
  {
    path: 'audiences/:slug',
    loadComponent: () => import('./taxonomy/taxonomy-browse').then((m) => m.TaxonomyBrowsePage),
    data: { kind: 'audience' },
    resolve: { term: audienceBrowseResolver },
  },
  {
    path: 'phases',
    pathMatch: 'full',
    loadComponent: () => import('./taxonomy/taxonomy-index').then((m) => m.TaxonomyIndexPage),
    data: { kind: 'phase' },
    resolve: { terms: phasesIndexResolver },
  },
  {
    path: 'phases/:slug',
    loadComponent: () => import('./taxonomy/taxonomy-browse').then((m) => m.TaxonomyBrowsePage),
    data: { kind: 'phase' },
    resolve: { term: phaseBrowseResolver },
  },
  // AECI-60 — Phase 2.14 integration detail. Integrations are keyed by record
  // ID, not slug (Phase 2 Spec §6.5). The detail resolver runs SSR-side via the
  // service binding; hydration reads from TransferState. A null result renders
  // the global 404 shell. No claim/correction routes — explicitly out of scope
  // for Stage 1 (Phase 6 covers product + vendor only).
  //
  // AECI-165 removed the `/integrations` index/listing page (orphaned from the
  // nav after AECI-160). `/integrations` now 301-redirects to `/products` at the
  // SSR Worker (see `server-runtime.ts`), so there is no Angular index route
  // here — only the detail route below.
  {
    path: 'integrations/:id',
    loadComponent: () =>
      import('./integrations/integration-detail').then((m) => m.IntegrationDetailPage),
    resolve: { integration: integrationDetailResolver },
  },
  // AECI-142 — Phase 3.9 search page. Results are queried browser-side from
  // Algolia with the search-only key (the API Worker is not in the read path,
  // §7.5), so there is NO resolver — the SSR shell paints meta + search box +
  // tabs + empty state, and the browser runs the search after hydration. The
  // route is non-cacheable (`private, no-store`) by virtue of NOT being in
  // `server-runtime.ts`'s `ROUTE_CACHE_PATTERNS` (fail-closed default), and the
  // component sets `robots: noindex` (search-results pages aren't canonical,
  // §4.6). Registered before the `**` wildcard so it matches.
  {
    path: 'search',
    loadComponent: () => import('./search/search-page').then((m) => m.SearchPage),
  },
  // AECI-194 — Phase 5.3 login page. Magic-link + Google OAuth, both
  // redirecting through /auth/callback?return=<validated path> (AECI-195).
  // Non-cacheable by the /auth/* rule in `server-runtime.ts`'s route
  // classifier (no classifier change needed); the component sets
  // `robots: noindex` (utility page). No resolver — the browser talks to
  // Supabase directly with the SSR-injected public config.
  {
    path: 'auth/login',
    loadComponent: () => import('./auth/login').then((m) => m.LoginPage),
  },
  // AECI-202 / Phase 5.11 — the signed-in user's account page. Auth-gated +
  // non-cacheable: the SSR Worker 303s an unauthenticated visitor to
  // `/auth/login?return=/account` before SSR (`isAccountPath` gate in
  // `server-runtime.ts`); `/account` is non-cacheable by the fail-closed default
  // (no classifier change). No resolver — identity + actions are user-specific
  // and fetched client-side over the `/api/*` proxy after hydration; the
  // component sets `robots: noindex`.
  {
    path: 'account',
    loadComponent: () => import('./account/account').then((m) => m.AccountPage),
  },
  // Dev-only preview routes for v0.dev → Angular ports. Always registered in
  // the Angular bundle (lazy-loaded, no eager-bundle cost) but blocked at the
  // SSR Worker for `ENV === 'production'`. See `apps/web/src/server-runtime.ts`
  // (`isPreviewPath`) and `apps/web/src/app/preview/preview.routes.ts`.
  {
    path: 'preview',
    loadChildren: () => import('./preview/preview.routes').then((m) => m.previewRoutes),
  },
  // AECI-203 — Phase 5.12 admin surface gate + shell, extended to a layout in
  // AECI-205 / Phase 5.14. Non-cacheable (fail-closed classifier — no change
  // needed) and RenderMode.Server (the `**` catch-all in app.routes.server.ts).
  // `adminSummaryResolver` calls `GET /api/admin/summary` (gated by
  // `requireAdmin()`): a 401/403 → 404 render (don't reveal the surface); a 200 →
  // the shell + pending-count badge. A logged-out visitor is bounced to login by
  // the worker-level `isAdminPath` gate before SSR. `AdminShell` is the layout
  // (gate + nav + badge + <router-outlet/>); the children render in the outlet,
  // and `/admin` redirects to the review queue.
  {
    path: 'admin',
    loadComponent: () => import('./admin/admin-shell').then((m) => m.AdminShell),
    resolve: { summary: adminSummaryResolver },
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'reviews' },
      {
        path: 'reviews',
        loadComponent: () => import('./admin/reviews/review-queue').then((m) => m.ReviewQueue),
      },
      {
        path: 'reviewers',
        loadComponent: () => import('./admin/reviewers/reviewer-bans').then((m) => m.ReviewerBans),
      },
    ],
  },
  // AECI-62 — Phase 2.16 global 404. Must be the last entry so every other
  // route gets a chance to match first. The resolver sets RESPONSE_INIT.status
  // to 404 and the noindex meta tags; the SSR runtime then emits NOT_FOUND_TTL
  // (60s edge / 0 browser) and `Cache-Tag: route:404` per AECI-56.
  {
    path: '**',
    loadComponent: () => import('./not-found/not-found').then((m) => m.NotFound),
    resolve: { _: notFoundResolver },
  },
];
