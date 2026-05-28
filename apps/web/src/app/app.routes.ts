import { Routes } from '@angular/router';

import { productDetailResolver } from './products/product-detail.resolver';

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
  // Dev-only preview routes for v0.dev → Angular ports. Always registered in
  // the Angular bundle (lazy-loaded, no eager-bundle cost) but blocked at the
  // SSR Worker for `ENV === 'production'`. See `apps/web/src/server-runtime.ts`
  // (`isPreviewPath`) and `apps/web/src/app/preview/preview.routes.ts`.
  {
    path: 'preview',
    loadChildren: () => import('./preview/preview.routes').then((m) => m.previewRoutes),
  },
];
