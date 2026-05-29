import { Routes } from '@angular/router';

import { notFoundResolver } from './not-found/not-found.resolver';
import { productDetailResolver } from './products/product-detail.resolver';
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
  // AECI-57 — Phase 2.11 product detail page + Phase 6 placeholder stubs.
  // The detail route resolves data SSR-side via the service binding (see
  // `productDetailResolver`); the placeholders are noindex inline panels
  // standing in for the full Phase 6 forms.
  {
    path: 'products/:slug/claim',
    loadComponent: () => import('./products/claim-placeholder').then((m) => m.ClaimPlaceholder),
  },
  {
    path: 'products/:slug/correction',
    loadComponent: () =>
      import('./products/correction-placeholder').then((m) => m.CorrectionPlaceholder),
  },
  {
    path: 'products/:slug',
    loadComponent: () => import('./products/product-detail').then((m) => m.ProductDetailPage),
    resolve: { product: productDetailResolver },
  },
  // AECI-59 — Phase 2.13 vendor index, detail, and Phase 6 placeholder stubs.
  // Same shape as the product block above: resolver runs SSR-side, hydration
  // reads from TransferState; placeholders are noindex inline panels.
  {
    path: 'vendors',
    pathMatch: 'full',
    loadComponent: () => import('./vendors/vendors-index').then((m) => m.VendorsIndex),
  },
  {
    path: 'vendors/:slug/claim',
    loadComponent: () =>
      import('./vendors/claim-placeholder').then((m) => m.VendorClaimPlaceholder),
  },
  {
    path: 'vendors/:slug/correction',
    loadComponent: () =>
      import('./vendors/correction-placeholder').then((m) => m.VendorCorrectionPlaceholder),
  },
  {
    path: 'vendors/:slug',
    loadComponent: () => import('./vendors/vendor-detail').then((m) => m.VendorDetailPage),
    resolve: { vendor: vendorDetailResolver },
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
