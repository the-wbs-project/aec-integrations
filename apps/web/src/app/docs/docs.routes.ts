/**
 * `/docs` child routes (AECI-1104, AECI-1248), lazy-loaded from `app.routes.ts`
 * so the Markdown only ships on docs routes (`STAGE_2_PRODUCT_DOCS_SPEC.md` §2).
 *
 * Every route is explicit and generated from the manifest (`docs-content.ts`),
 * rather than a `:section` / `:slug` param: an unknown `/docs/...` path matches
 * nothing here and falls through to the app's `**` 404, the same reason
 * `/legal/*` is explicit.
 *
 *   - `''`                    the docs home
 *   - `<section>`             the section index, for each non-empty section
 *   - `<section>/<slug>`      each article
 *
 * A single-page section (`faq`) has no index: its one page takes the
 * `<section>` path. A section with no pages gets no route at all.
 */
import type { Routes } from '@angular/router';

import { DOCS_SECTIONS } from './docs-content';

const loadPage = () => import('./docs-page').then((m) => m.DocsPageComponent);

export const DOCS_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    loadComponent: () => import('./docs-home').then((m) => m.DocsHomeComponent),
  },
  ...DOCS_SECTIONS.flatMap((section): Routes => {
    if (section.singlePage) {
      const [page] = section.pages;
      return [
        {
          path: section.id,
          loadComponent: loadPage,
          data: { section: section.id, slug: page.slug },
        },
      ];
    }
    return [
      {
        path: section.id,
        loadComponent: () => import('./docs-section').then((m) => m.DocsSectionComponent),
        data: { section: section.id },
      },
      ...section.pages.map((page) => ({
        path: `${section.id}/${page.slug}`,
        loadComponent: loadPage,
        data: { section: section.id, slug: page.slug },
      })),
    ];
  }),
];
