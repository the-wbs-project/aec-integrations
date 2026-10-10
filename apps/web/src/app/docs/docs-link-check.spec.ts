/**
 * AECI-1254 — the docs link checker's helpers, against fixture routes and hrefs.
 *
 * Plain Vitest (no `.md` import, no DOM). The real content is checked against
 * the real route table in `docs-content.component.spec.ts`.
 */
import type { Routes } from '@angular/router';
import { describe, expect, it } from 'vitest';

import {
  type DocsLinkTargets,
  appRoutePatterns,
  brokenLinkReason,
  findBrokenDocsLinks,
  matchesRoutePattern,
} from './docs-link-check.harness';

const page = () => Promise.resolve(class {});

const ROUTES: Routes = [
  { path: '', pathMatch: 'full', loadComponent: page },
  { path: 'products', pathMatch: 'full', loadComponent: page },
  { path: 'products/:slug', loadComponent: page },
  {
    path: 'admin',
    loadComponent: page,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
      { path: 'overview', loadComponent: page },
    ],
  },
  {
    path: 'vendor',
    loadChildren: () => Promise.resolve([{ path: ':slug/claims', loadComponent: page }]),
  },
  { path: 'empty-group' },
  { path: '**', loadComponent: page },
];

const TARGETS: DocsLinkTargets = {
  docsHeadingIds: (path) =>
    ({ '/docs': [], '/docs/trust/agreement-states': ['confirmed'] })[path] as
      | readonly string[]
      | undefined,
  routePatterns: ['/', '/products', '/products/:slug', '/admin/overview'],
};

describe('appRoutePatterns', () => {
  it('flattens children and lazy children into full patterns, skipping the wildcard', async () => {
    expect(await appRoutePatterns(ROUTES)).toEqual([
      '/',
      '/products',
      '/products/:slug',
      '/admin',
      '/admin/overview',
      '/vendor/:slug/claims',
    ]);
  });

  // A layout route only routes through a child, so the parent alone never counts.
  it('leaves out a layout parent and a route that renders nothing', async () => {
    const patterns = await appRoutePatterns([
      { path: 'shell', loadComponent: page, children: [{ path: 'leaf', loadComponent: page }] },
      { path: 'bare' },
    ]);
    expect(patterns).toEqual(['/shell/leaf']);
  });

  it('reads a lazy module that default-exports its routes', async () => {
    const patterns = await appRoutePatterns([
      {
        path: 'lazy',
        loadChildren: () =>
          Promise.resolve({ default: [{ path: 'x', loadComponent: page }] as Routes }),
      },
    ]);
    expect(patterns).toEqual(['/lazy/x']);
  });

  // Silently skipping a matcher would let every link under it pass unchecked.
  it('throws on a matcher route it cannot read', async () => {
    await expect(appRoutePatterns([{ matcher: () => null, loadComponent: page }])).rejects.toThrow(
      /matcher/,
    );
  });
});

describe('matchesRoutePattern', () => {
  it('matches a param segment to any one segment, and literals exactly', () => {
    expect(matchesRoutePattern('/products/revit', '/products/:slug')).toBe(true);
    expect(matchesRoutePattern('/products', '/products/:slug')).toBe(false);
    expect(matchesRoutePattern('/products/revit/extra', '/products/:slug')).toBe(false);
    expect(matchesRoutePattern('/Products', '/products')).toBe(false);
    expect(matchesRoutePattern('/', '/')).toBe(true);
  });
});

describe('brokenLinkReason', () => {
  it('passes docs paths the manifest serves, with a heading fragment that exists', () => {
    expect(brokenLinkReason('/docs', TARGETS)).toBeUndefined();
    expect(brokenLinkReason('/docs/trust/agreement-states#confirmed', TARGETS)).toBeUndefined();
  });

  it('fails a docs path the manifest does not serve', () => {
    expect(brokenLinkReason('/docs/trust/renamed-page', TARGETS)).toMatch(/no docs page/);
  });

  it('fails a fragment that is not a heading id on the target page', () => {
    expect(brokenLinkReason('/docs/trust/agreement-states#gone', TARGETS)).toBe(
      'the page has no heading with id "gone"',
    );
    expect(brokenLinkReason('/docs#anything', TARGETS)).toMatch(/no heading/);
  });

  // `/docs` links go to the manifest, never the route table.
  it('checks /docs against the manifest even when a route pattern would match', () => {
    const targets = { ...TARGETS, routePatterns: ['/docs/:x/:y'] };
    expect(brokenLinkReason('/docs/trust/renamed-page', targets)).toMatch(/no docs page/);
  });

  it('passes app routes by pattern, ignoring the query and the fragment', () => {
    expect(brokenLinkReason('/products/revit', TARGETS)).toBeUndefined();
    expect(brokenLinkReason('/products?sort=name#top', TARGETS)).toBeUndefined();
    expect(brokenLinkReason('/', TARGETS)).toBeUndefined();
  });

  it('fails an in-app path that matches no route', () => {
    expect(brokenLinkReason('/vendors', TARGETS)).toBe('matches no route in the app route table');
  });

  it('skips http, https and mailto links', () => {
    expect(brokenLinkReason('https://example.com/x', TARGETS)).toBeUndefined();
    expect(brokenLinkReason('http://example.com', TARGETS)).toBeUndefined();
    expect(brokenLinkReason('mailto:support@aecintegrations.com', TARGETS)).toBeUndefined();
  });

  it('fails relative, bare-fragment and protocol-relative links', () => {
    for (const href of ['plans', '../plans', '#related', '//example.com/x']) {
      expect(brokenLinkReason(href, TARGETS), href).toMatch(/site-absolute/);
    }
  });
});

describe('findBrokenDocsLinks', () => {
  it('names the source file, the href and the reason for each broken link', () => {
    expect(
      findBrokenDocsLinks(
        [
          { file: 'src/content/docs/trust/a.md', hrefs: ['/products', '/nowhere'] },
          { file: 'src/content/docs/trust/b.md', hrefs: ['/docs/gone'] },
        ],
        TARGETS,
      ),
    ).toEqual([
      'src/content/docs/trust/a.md: /nowhere (matches no route in the app route table)',
      'src/content/docs/trust/b.md: /docs/gone (no docs page, section index or docs home is served at this path)',
    ]);
  });
});
