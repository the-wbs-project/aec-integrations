import { Routes } from '@angular/router';

/**
 * Dev-only preview routes for v0.dev → Angular ports.
 *
 * Registered in every Angular build (lazy-loaded — no eager-bundle cost) and
 * blocked at the SSR Worker on the public tiers (production + demo,
 * `isPublicSite`). See `apps/web/src/server-runtime.ts` (`isPreviewPath`) for the
 * runtime gate and `docs/design/workflow.md` for the loop these routes
 * participate in.
 *
 * Preview routes are not real product surfaces — they exist so designers and
 * engineers can review ported v0 screens before the corresponding entity-page
 * issue lands in Phase 2. Don't link to them from product navigation.
 */
export const previewRoutes: Routes = [
  {
    path: 'vendor-detail',
    loadComponent: () => import('./vendor-detail/vendor-detail').then((m) => m.VendorDetail),
  },
  {
    path: 'layouts/detail',
    loadComponent: () =>
      import('./layouts/detail-layout-preview').then((m) => m.DetailLayoutPreview),
  },
  {
    path: 'layouts/browse',
    loadComponent: () =>
      import('./layouts/browse-layout-preview').then((m) => m.BrowseLayoutPreview),
  },
  {
    path: 'layouts/index',
    loadComponent: () => import('./layouts/index-layout-preview').then((m) => m.IndexLayoutPreview),
  },
  // AECI-185 — the home "recently added integrations" + "trending products"
  // modules, shown across every state (populated / empty / fallback) so they can
  // be axe-scanned and reviewed in both themes before 4.11 assembles `/`.
  {
    path: 'home/sections',
    loadComponent: () => import('./home/home-sections-preview').then((m) => m.HomeSectionsPreview),
  },
];
