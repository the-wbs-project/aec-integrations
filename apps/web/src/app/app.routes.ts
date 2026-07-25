import { Routes } from '@angular/router';

import { adminSummaryResolver } from './admin/admin-summary.resolver';
import { homeBrowseResolver } from './home/home-browse.resolver';
import { homeStatsResolver } from './home/home-stats.resolver';
import { notFoundResolver } from './not-found/not-found.resolver';
import { productDetailResolver } from './products/product-detail.resolver';
import { productsPairResolver } from './products/products-pair.resolver';
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
import { vendorMeResolver } from './vendor/vendor-me.resolver';
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
  // The home carries `Cache-Tag: route:index,index:home,taxonomy` (`cacheTagInputsForPath`),
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
  // AECI-294 — Stage 1.5 product-PAIR page. Two params (context + other product
  // slugs); the pair is a query-time grouping of every integration between them
  // (§7). More specific than `products/:slug` (three segments), so it must
  // precede it in the table. The legacy `/integrations/:id` route is retired —
  // the SSR Worker 301-redirects it here (see `server-runtime.ts`).
  {
    path: 'products/:contextSlug/integrations/:otherSlug',
    loadComponent: () => import('./products/products-pair').then((m) => m.ProductsPairPage),
    resolve: { pair: productsPairResolver },
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
  // AECI-294 (Stage 1.5) retired the standalone `/integrations/:id` detail route.
  // Integrations are now consolidated onto the product-PAIR page
  // (`/products/:contextSlug/integrations/:otherSlug`, above); the SSR Worker
  // 301-redirects any legacy `/integrations/:id` link to the canonical pair URL
  // (see `server-runtime.ts`). `/integrations` (the index) already 301s to
  // `/products` (AECI-165).
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
  // SSR Worker on the public tiers (production + demo, `isPublicSite`). See
  // `apps/web/src/server-runtime.ts` (`isPreviewPath`) and
  // `apps/web/src/app/preview/preview.routes.ts`.
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
        path: 'requests',
        loadComponent: () => import('./admin/requests/request-queue').then((m) => m.RequestQueue),
      },
      // AECI-521 — the claim-review queue (reviewer-assist signals). Clones the
      // requests child; claims moderate via the AECI-519 grant/reject PATCH.
      {
        path: 'claims',
        loadComponent: () => import('./admin/claims/claim-queue').then((m) => m.ClaimQueue),
      },
      {
        path: 'reviewers',
        loadComponent: () => import('./admin/reviewers/reviewer-bans').then((m) => m.ReviewerBans),
      },
    ],
  },
  // AECI-522 — Phase 2 (Stage 2) vendor portal. The signed-in vendor's dashboard
  // over `/api/vendor/*` (AECI-520). `vendorMeResolver` calls `GET /api/vendor/me`
  // (gated by `requireVendor()`): a 401/403/404 → 404 render (don't reveal the
  // surface); a 200 → the tabbed dashboard. A logged-out visitor is bounced to
  // login by the worker-level `isVendorPath` gate before SSR. Non-cacheable +
  // Cache-Tag-free by the fail-closed classifier (no change needed). Registered
  // before the `**` wildcard so it matches. NOTE the singular `/vendor` — the
  // public `/vendors/:slug` detail is a different, cacheable route.
  {
    path: 'vendor',
    loadComponent: () => import('./vendor/vendor-page').then((m) => m.VendorPage),
    resolve: { me: vendorMeResolver },
  },
  // AECI-238 — Phase 7.3 static content pages (About + Contact). No resolver:
  // the copy is static, so meta (title/description/canonical/OG) is set in each
  // component constructor via `MetaService.setStaticPageMeta` (the `Home`
  // pattern), not by a resolver. Both render `RenderMode.Server` (the `**`
  // catch-all in app.routes.server.ts) and are indexable (canonical set, no
  // noindex). `/about` is CACHEABLE (24h edge / 1h browser, `Cache-Tag:
  // route:index`) — pre-wired in `ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath`.
  // `/contact` is NON-cacheable (§3.1 "No cache"): absent from those tables, it
  // gets the fail-closed `private, no-store` default. Registered before the `**`
  // wildcard so they match.
  {
    path: 'about',
    loadComponent: () => import('./about/about').then((m) => m.AboutPage),
  },
  {
    path: 'contact',
    loadComponent: () => import('./contact/contact').then((m) => m.ContactPage),
  },
  // AECI-237 — Phase 7.2 legal pages. Four counsel-tracked documents
  // (`STAGE_1_SPEC.md` §13/§27) rendered from Markdown (`src/content/legal/`) by
  // one `LegalPage`, selected by the route's `data.slug` (short public slug →
  // long §27.1 filename in `legal-content.ts`). All four are static, indexable,
  // RenderMode.Server, and CACHEABLE (24h edge / 1h browser, `Cache-Tag:
  // route:index`) — pre-wired in `ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath`
  // for the `/legal/*` prefix. Explicit routes (not `legal/:slug`) so an unknown
  // `/legal/*` falls through to the `**` 404 (NOT_FOUND_TTL + `Cache-Tag:
  // route:404`). Registered before the `**` wildcard so they match.
  {
    path: 'legal/terms',
    loadComponent: () => import('./legal/legal-page').then((m) => m.LegalPage),
    data: { slug: 'terms' },
  },
  {
    path: 'legal/privacy',
    loadComponent: () => import('./legal/legal-page').then((m) => m.LegalPage),
    data: { slug: 'privacy' },
  },
  {
    path: 'legal/review-guidelines',
    loadComponent: () => import('./legal/legal-page').then((m) => m.LegalPage),
    data: { slug: 'review-guidelines' },
  },
  {
    path: 'legal/listing-accuracy',
    loadComponent: () => import('./legal/legal-page').then((m) => m.LegalPage),
    data: { slug: 'listing-accuracy' },
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
