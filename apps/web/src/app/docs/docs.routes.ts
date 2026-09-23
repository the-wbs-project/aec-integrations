/**
 * `/docs` child routes (AECI-1104), lazy-loaded from `app.routes.ts` so the
 * Markdown only ships on docs routes (`STAGE_2_PRODUCT_DOCS_SPEC.md` §2).
 *
 * One explicit route per manifest page, generated from `DOCS_PAGES`, rather
 * than a `:slug` param: an unknown `/docs/...` path matches nothing here and
 * falls through to the app's `**` 404, the same reason `/legal/*` is explicit.
 */
import type { Routes } from '@angular/router';

import { DOCS_PAGES } from './docs-content';

export const DOCS_ROUTES: Routes = DOCS_PAGES.map((page) => ({
  path: `${page.section}/${page.slug}`,
  loadComponent: () => import('./docs-page').then((m) => m.DocsPageComponent),
  data: { section: page.section, slug: page.slug },
}));
