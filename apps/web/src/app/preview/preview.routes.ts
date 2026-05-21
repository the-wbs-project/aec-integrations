import { Routes } from '@angular/router';

/**
 * Dev-only preview routes for v0.dev → Angular ports.
 *
 * Registered in every Angular build (lazy-loaded — no eager-bundle cost) and
 * blocked at the SSR Worker when `env.ENV === 'production'`. See
 * `apps/web/src/server-runtime.ts` (`isPreviewPath`) for the runtime gate and
 * `docs/design/workflow.md` for the loop these routes participate in.
 *
 * Preview routes are not real product surfaces — they exist so designers and
 * engineers can review ported v0 screens before the corresponding entity-page
 * issue lands in Phase 2. Don't link to them from product navigation.
 */
export const previewRoutes: Routes = [
  {
    path: 'vendor-detail',
    loadComponent: () =>
      import('./vendor-detail/vendor-detail').then((m) => m.VendorDetail),
  },
];
