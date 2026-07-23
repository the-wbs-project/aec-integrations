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
  // AECI-270 — the unified marketing + directory home (AECI-269 direction pass):
  // the full §4.1 flow with the NEW marketing bands rendered as three live-
  // toggleable premium concepts, so the PO chooses one before the build children
  // (AECI-269 2–6) build them.
  {
    path: 'unified-home',
    loadComponent: () =>
      import('./unified-home/unified-home-preview').then((m) => m.UnifiedHomePreview),
  },
  // AECI-289 — the Stage 1.5 integration-redesign prototype: the consolidated
  // pair page (Layer A, §7) + the data-flow / claim section (Layer B, §8),
  // rendered as the chosen `b · Flow canvas` direction (PO sign-off 2026-07-01;
  // the Editorial-ledger + Dense-table exploration concepts were removed) with
  // orientation-mirror + empty-state toggles. AECI-294/AECI-300 build against it.
  // Anchor: GitBook (Customer.io exception for the directional flow rail).
  {
    path: 'integration-pair',
    loadComponent: () =>
      import('./integration-pair/integration-pair-preview').then((m) => m.IntegrationPairPreview),
  },
  // AECI-286 — search relevance lab: compare candidate `customRanking` levers
  // (SEARCH_RANKING.md §7) over curated fixtures while real query data is still
  // too thin to tune against (the real-data run is AECI-283). No Algolia.
  {
    path: 'search-relevance',
    loadComponent: () =>
      import('./search-relevance/search-relevance-preview').then((m) => m.SearchRelevancePreview),
  },
];
