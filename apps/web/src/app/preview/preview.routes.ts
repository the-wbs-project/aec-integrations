import { Routes } from '@angular/router';

import { provideAdminChipTones } from '../admin/console/chip-tones';
import { VENDOR_SECTION_ROUTES } from '../vendor/vendor.routes';

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
  // AECI-522 — the Stage 2 vendor dashboard. It first rendered two IA concepts; the
  // PO chose the tabbed shell and AECI-1809 deleted the single-page one. The real
  // dashboard components are used verbatim, fed synthetic fixtures with the
  // `VendorApi` shadowed by a fixture-backed fake.
  //
  // It carries the portal's own section routes as CHILDREN because the tabbed
  // concept is a router shell now (`vendor/vendor.routes.ts`): its nav links are
  // relative, so mounting the same array here makes them resolve under
  // `/preview/vendor-dashboard/...` instead of jumping into the live portal, and
  // the preview keeps reviewing the component that actually ships.
  {
    path: 'vendor-dashboard',
    loadComponent: () =>
      import('./vendor-dashboard/vendor-dashboard-preview').then((m) => m.VendorDashboardPreview),
    children: VENDOR_SECTION_ROUTES,
  },
  // AECI-1809 — the portal form layout (`vendor/shared/portal-form.ts`) on a demo form,
  // so the sticky save bar can be checked against a focused field without a session.
  {
    path: 'portal-form',
    loadComponent: () =>
      import('./portal-form/portal-form-preview').then((m) => m.PortalFormPreview),
  },
  // AECI-1009 — the `/admin/contests` queue over a fixture-backed fake API, so the
  // Protests view and its decision form render without an admin session.
  {
    path: 'admin-contests',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-contests/admin-contests-preview').then((m) => m.AdminContestsPreview),
  },
  // AECI-1377: the "Product requests from vendors" section of `/admin/requests` over
  // a fake API, so the three decision forms and the product picker render without an
  // admin session.
  {
    path: 'admin-product-requests',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-product-requests/admin-product-requests-preview').then(
        (m) => m.AdminProductRequestsPreview,
      ),
  },
  // AECI-1177 — the `/admin/review-responses` queue over a fixture-backed fake API,
  // so every card state and the reason form render without an admin session.
  {
    path: 'admin-review-responses',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-review-responses/admin-review-responses-preview').then(
        (m) => m.AdminReviewResponsesPreview,
      ),
  },
  // AECI-1643 — the `/admin/reviews` queue over a fixture-backed fake API, so the
  // status tabs, the remove form and its confirm render without an admin session.
  {
    path: 'admin-reviews',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-reviews/admin-reviews-preview').then((m) => m.AdminReviewsPreview),
  },
  // AECI-1638 — the `/admin/legal` litigation holds section over a fake API, so the
  // place and release forms render without an admin session.
  {
    path: 'admin-litigation-holds',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-litigation-holds/admin-litigation-holds-preview').then(
        (m) => m.AdminLitigationHoldsPreview,
      ),
  },
  // AECI-1613 — the `/admin/review-updates` queue over a fixture-backed fake API,
  // so every card state and the reason form render without an admin session.
  {
    path: 'admin-review-updates',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-review-updates/admin-review-updates-preview').then(
        (m) => m.AdminReviewUpdatesPreview,
      ),
  },
  // AECI-1613 — the `/account` review-update panel over a fake API, so the form and
  // every update badge render without a signed-in session.
  {
    path: 'account-review-updates',
    loadComponent: () =>
      import('./account-review-updates/account-review-updates-preview').then(
        (m) => m.AccountReviewUpdatesPreview,
      ),
  },
  // AECI-1813 — the console legend in the real app: the seven chip tones, the
  // status-to-tone map, the table recipe, the paginator, the inline control form
  // and the danger pattern, over fixtures.
  {
    path: 'admin-console-legend',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-console-legend/admin-console-legend-preview').then(
        (m) => m.AdminConsoleLegendPreview,
      ),
  },
  // AECI-1461 — `/admin/activity` over a fake API, so the Class column, the class
  // filter and the all-classes figure render without an admin session.
  {
    path: 'admin-activity',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-activity/admin-activity-preview').then((m) => m.AdminActivityPreview),
  },
  // AECI-822: `/admin/seo` Panels 1 and 2 over a fake API, with a gallery of the
  // empty, no-site-address and failed states, for review without a session.
  {
    path: 'admin-seo',
    loadComponent: () => import('./admin-seo/admin-seo-preview').then((m) => m.AdminSeoPreview),
  },
  // AECI-1223 — `/admin/email` over a fake API, so the summary, the sign-in panel and
  // the sends list render without an admin session.
  {
    path: 'admin-email',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-email/admin-email-preview').then((m) => m.AdminEmailPreview),
  },
  // AECI-1091 — the Integrations tab of `/admin/vendors/:id` over a fake API, so the
  // evidenced-pair rows and the retire form render without an admin session.
  // `?retire=<row id>` opens that row's form.
  {
    path: 'admin-vendor-integrations',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-vendor-integrations/admin-vendor-integrations-preview').then(
        (m) => m.AdminVendorIntegrationsPreview,
      ),
  },
  // AECI-2202: the Products tab of `/admin/vendors/:id` over a fake API, so the row
  // Actions menu and each dialog it opens render without a session.
  {
    path: 'admin-vendor-products',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-vendor-products/admin-vendor-products-preview').then(
        (m) => m.AdminVendorProductsPreview,
      ),
  },
  // AECI-1615: the Billing tab of `/admin/vendors/:id` over a fake API, so the Grants
  // section, the Withdraw action and the signed-deal form render without a session.
  {
    path: 'admin-vendor-billing',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-vendor-billing/admin-vendor-billing-preview').then(
        (m) => m.AdminVendorBillingPreview,
      ),
  },
  // AECI-1237 — the Field corrections section of `/admin/vendors/:id` over a fake
  // API, so the lock list and the correct and lift forms render without a session.
  {
    path: 'admin-field-corrections',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-field-corrections/admin-field-corrections-preview').then(
        (m) => m.AdminFieldCorrectionsPreview,
      ),
  },
  // AECI-2139 — the Data flow corrections section of `/admin/vendors/:id` over a fake
  // API, so the list and the correct and lift forms render without a session.
  {
    path: 'admin-flow-corrections',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-flow-corrections/admin-flow-corrections-preview').then(
        (m) => m.AdminFlowCorrectionsPreview,
      ),
  },
  // AECI-1618: the pending brand-asset removals section of `/admin/vendors` over a fake
  // API, so the list and the hold forms render without a session.
  {
    path: 'admin-brand-asset-removals',
    providers: [provideAdminChipTones()],
    loadComponent: () =>
      import('./admin-brand-asset-removals/admin-brand-asset-removals-preview').then(
        (m) => m.AdminBrandAssetRemovalsPreview,
      ),
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
