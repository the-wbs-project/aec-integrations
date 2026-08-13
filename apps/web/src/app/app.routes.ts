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
  tradeBrowseResolver,
} from './taxonomy/taxonomy-browse.resolver';
import {
  categoriesIndexResolver,
  audiencesIndexResolver,
  phasesIndexResolver,
  tradesIndexResolver,
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
  // AECI-61 / AECI-157 / AECI-544 — Phase 2.15 taxonomy index + browse pages.
  // Both the four flat indexes and the four `:slug` browse pages each share one
  // component + one resolver factory, keyed by the static `data.kind`. AECI-157
  // lit up the `/audiences` + `/phases` indexes (originally deferred to Phase 3);
  // AECI-544 added `/trades`, the fourth facet (STAGE_1_SPEC.md §5.5a).
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
  // Trades (AECI-544 / AECI-546). The index applies the
  // `TRADE_PUBLISH_MIN_PRODUCTS` floor to the terms it lists — though the index
  // page itself is always indexable. A sub-floor TERM page still resolves 200, so
  // its URL is stable across the gate; what it loses is indexability (`noindex`
  // via `applyBrowseMeta`) and its sitemap entry.
  {
    path: 'trades',
    pathMatch: 'full',
    loadComponent: () => import('./taxonomy/taxonomy-index').then((m) => m.TaxonomyIndexPage),
    data: { kind: 'trade' },
    resolve: { terms: tradesIndexResolver },
  },
  {
    path: 'trades/:slug',
    loadComponent: () => import('./taxonomy/taxonomy-browse').then((m) => m.TaxonomyBrowsePage),
    data: { kind: 'trade' },
    resolve: { term: tradeBrowseResolver },
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
  // (gate + nav + badge + <router-outlet/>); the children render in the outlet.
  //
  // AECI-576 / Phase 8.3 P1.2 — the admin area became the operator console
  // (`docs/ADMIN_PANEL_SPEC.md` §5), so `/admin` now redirects to the Overview
  // rather than to the review queue. The three Operations queues are unchanged.
  // AECI-577 / P1.3 added `activity` (§5.2); AECI-578 / P1.4 added `traffic`
  // (§5.3). The remaining §5 routes (`audience`, `catalog`, `system`) land with
  // their own sub-issues; until then they are neither routed nor linked, so
  // nothing in the nav can reach a 404.
  {
    path: 'admin',
    loadComponent: () => import('./admin/admin-shell').then((m) => m.AdminShell),
    resolve: { summary: adminSummaryResolver },
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      {
        path: 'overview',
        loadComponent: () => import('./admin/overview/overview').then((m) => m.AdminOverview),
      },
      // AECI-577 / Phase 8.3 P1.3 — the §5.2 Activity feed, under Insights.
      {
        path: 'activity',
        loadComponent: () => import('./admin/activity/activity-feed').then((m) => m.ActivityFeed),
      },
      {
        path: 'reviews',
        loadComponent: () => import('./admin/reviews/review-queue').then((m) => m.ReviewQueue),
      },
      {
        path: 'requests',
        loadComponent: () => import('./admin/requests/request-queue').then((m) => m.RequestQueue),
      },
      {
        path: 'reviewers',
        loadComponent: () => import('./admin/reviewers/reviewer-bans').then((m) => m.ReviewerBans),
      },
      // AECI-578 — Phase 8.3 P1.4, the §5.3 Traffic section. Renders the two
      // AECI-574 read endpoints; inherits the parent's gate and non-cacheable
      // branch, so nothing route-level changes here.
      {
        path: 'traffic',
        loadComponent: () => import('./admin/traffic/traffic').then((m) => m.AdminTraffic),
      },
      // AECI-579 / Phase 8.3 P1.5 — the operator console's catalog section
      // (`ADMIN_PANEL_SPEC.md` §5.5). No resolver of its own: the parent's
      // `adminSummaryResolver` is the gate, and the screen fetches its own data
      // client-side in `afterNextRender`, like the moderation queues.
      {
        path: 'catalog',
        loadComponent: () =>
          import('./admin/catalog/catalog-coverage').then((m) => m.CatalogCoverage),
      },
    ],
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
  // AECI-536 — focused first-party mailing-list signup page for external links
  // (LinkedIn etc.). Static + indexable + CACHEABLE (24h edge / 1h browser,
  // `Cache-Tag: route:index`) like /about — pre-wired in `ROUTE_CACHE_PATTERNS`
  // + `cacheTagInputsForPath`. Meta set in the component constructor. No resolver
  // (the signup POSTs to the non-cached `/api/subscribe` only on a user action).
  {
    path: 'updates',
    loadComponent: () => import('./updates/updates').then((m) => m.UpdatesPage),
  },
  {
    path: 'contact',
    loadComponent: () => import('./contact/contact').then((m) => m.ContactPage),
  },
  // AECI-537 — mailing-list opt-out, the destination for the welcome email's
  // tokenized `/unsubscribe?token=…` link. Deliberately NOT cacheable and NOT
  // indexed: the URL carries a per-subscriber token, so it is absent from
  // `ROUTE_CACHE_PATTERNS` + `cacheTagInputsForPath` (fail-closed `private,
  // no-store`) and the component sets `robots: noindex`. RenderMode.Server (the
  // `**` default). No resolver — the opt-out POSTs to `/api/unsubscribe` only on
  // the confirm click (a GET must never mutate). Not linked from site nav.
  {
    path: 'unsubscribe',
    loadComponent: () => import('./unsubscribe/unsubscribe').then((m) => m.UnsubscribePage),
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
