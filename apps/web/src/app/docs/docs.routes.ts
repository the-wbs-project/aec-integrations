/**
 * `/docs` child routes (AECI-1104, AECI-1248), lazy-loaded from `app.routes.ts`
 * so the Markdown only ships on docs routes (`STAGE_2_PRODUCT_DOCS_SPEC.md` §2).
 *
 * `/docs` is a **layout route** (AECI-1259), like `/admin`: one `''` parent
 * renders `DocsShellComponent` (the sidebar, the top bar and a
 * `<router-outlet>`), and the home, the section indexes and the articles are its
 * children. The parent adds no path segment, so every URL is unchanged.
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
import { DocsShellComponent } from './docs-shell';

const loadPage = () => import('./docs-page').then((m) => m.DocsPageComponent);

/** The shell's children: the home, each section index and each article. */
export const DOCS_CHILD_ROUTES: Routes = [
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

/**
 * The shell has no `pathMatch`, so an unknown `/docs/...` path matches no child,
 * the router backs out of the shell, and the app's `**` 404 takes it.
 */
export const DOCS_ROUTES: Routes = [
  { path: '', component: DocsShellComponent, children: DOCS_CHILD_ROUTES },
];
