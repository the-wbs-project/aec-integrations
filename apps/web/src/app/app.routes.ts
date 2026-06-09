import { Routes } from '@angular/router';

import { integrationDetailResolver } from './integrations/integration-detail.resolver';
import { notFoundResolver } from './not-found/not-found.resolver';
import { productDetailResolver } from './products/product-detail.resolver';
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
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./home/home').then((m) => m.Home),
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
  // Dev-only preview routes for v0.dev → Angular ports. Always registered in
  // the Angular bundle (lazy-loaded, no eager-bundle cost) but blocked at the
  // SSR Worker for `ENV === 'production'`. See `apps/web/src/server-runtime.ts`
  // (`isPreviewPath`) and `apps/web/src/app/preview/preview.routes.ts`.
  {
    path: 'preview',
    loadChildren: () => import('./preview/preview.routes').then((m) => m.previewRoutes),
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
