/**
 * AECI-1254 — the docs internal link checker (`STAGE_2_PRODUCT_DOCS_SPEC.md` §4,
 * the second defense after the sync rule).
 *
 * Pure helpers, run by the `only links to docs pages and app routes that exist`
 * case in `docs-content.component.spec.ts` against the real manifest and the
 * real route table, and pinned with fixtures in `docs-link-check.spec.ts`.
 *
 *   - A `/docs` href must be a docs path the manifest serves (the home, a
 *     section index or a page), and its `#fragment`, if any, a heading id that
 *     page renders.
 *   - Any other href starting with `/` must match a route in the app's route
 *     table, read from `app.routes.ts` with every `children` and `loadChildren`
 *     followed. `:param` segments match any one segment. The `**` 404 matches
 *     nothing. A path the SSR Worker answers on its own (a 301, `sitemap.xml`)
 *     is not an app route, so a docs page must link the canonical URL instead.
 *   - `http(s):` and `mailto:` are out of scope. Anything else (a relative
 *     path, a bare `#fragment`) fails: the app sets `<base href>`, so only a
 *     site-absolute path lands where the author meant.
 *
 * Fragments on non-docs routes are not checked: those pages are not Markdown
 * with known heading ids.
 *
 * Test helper, not a spec: `*.harness.ts`, so no runner collects it and the app
 * build excludes it (`tsconfig.app.json`).
 */
import type { Route, Routes } from '@angular/router';

/** One Markdown source and the hrefs its rendered HTML carries. */
export interface DocsLinkSource {
  /** Repo-relative path of the `.md`, printed in a failure. */
  readonly file: string;
  readonly hrefs: readonly string[];
}

/** What a link may point at. */
export interface DocsLinkTargets {
  /**
   * The heading ids rendered at a docs path, or `undefined` when the manifest
   * serves nothing there. A path with no headings returns `[]`.
   */
  readonly docsHeadingIds: (path: string) => readonly string[] | undefined;
  /** Route patterns from `appRoutePatterns`, e.g. `/products/:slug`. */
  readonly routePatterns: readonly string[];
}

function joinPath(prefix: string, path: string): string {
  return [prefix, path].filter((part) => part !== '').join('/');
}

async function loadChildRoutes(route: Route, at: string): Promise<Routes> {
  const loaded: unknown = await route.loadChildren!();
  const routes =
    loaded && typeof loaded === 'object' && 'default' in loaded
      ? (loaded as { default: unknown }).default
      : loaded;
  if (!Array.isArray(routes)) {
    throw new Error(`loadChildren at "/${at}" did not resolve to a Routes array`);
  }
  return routes as Routes;
}

/**
 * Every navigable path pattern in a route table, as `/a/:b`. Follows `children`
 * and calls each `loadChildren`. A route with children is a layout, so only its
 * children count. A leaf counts when it renders something or redirects. The
 * `**` wildcard is skipped. A `matcher` route cannot be read as a pattern, so it
 * throws rather than pass every link silently.
 */
export async function appRoutePatterns(routes: Routes, prefix = ''): Promise<string[]> {
  const patterns: string[] = [];
  for (const route of routes) {
    if (route.path === '**') continue;
    if (route.matcher) {
      throw new Error(`Route under "/${prefix}" uses a matcher; the link checker cannot read it`);
    }
    const full = joinPath(prefix, route.path ?? '');
    if (route.children) patterns.push(...(await appRoutePatterns(route.children, full)));
    if (route.loadChildren) {
      patterns.push(...(await appRoutePatterns(await loadChildRoutes(route, full), full)));
    }
    const isLeaf = !route.children && !route.loadChildren;
    const lands =
      route.component !== undefined ||
      route.loadComponent !== undefined ||
      route.redirectTo !== undefined;
    if (isLeaf && lands) patterns.push(`/${full}`);
  }
  return [...new Set(patterns)];
}

function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** Whether a path (no query, no fragment) matches a route pattern. */
export function matchesRoutePattern(path: string, pattern: string): boolean {
  const actual = segments(path);
  const expected = segments(pattern);
  return (
    actual.length === expected.length &&
    expected.every((segment, i) => segment.startsWith(':') || segment === actual[i])
  );
}

const OUT_OF_SCOPE = /^(https?:|mailto:)/i;

function isDocsPath(path: string): boolean {
  return path === '/docs' || path.startsWith('/docs/');
}

/** Why one href is broken, or `undefined` when it resolves or is out of scope. */
export function brokenLinkReason(href: string, targets: DocsLinkTargets): string | undefined {
  if (OUT_OF_SCOPE.test(href)) return undefined;
  if (!href.startsWith('/') || href.startsWith('//')) {
    return 'not a site-absolute path; start it with a single /';
  }
  const hashAt = href.indexOf('#');
  const fragment = hashAt < 0 ? '' : href.slice(hashAt + 1);
  const path = (hashAt < 0 ? href : href.slice(0, hashAt)).split('?')[0];

  if (isDocsPath(path)) {
    const ids = targets.docsHeadingIds(path);
    if (!ids) return 'no docs page, section index or docs home is served at this path';
    if (fragment && !ids.includes(fragment)) {
      return `the page has no heading with id "${fragment}"`;
    }
    return undefined;
  }
  if (!targets.routePatterns.some((pattern) => matchesRoutePattern(path, pattern))) {
    return 'matches no route in the app route table';
  }
  return undefined;
}

/** Every broken link, as `<file>: <href> (<reason>)`. Empty when all resolve. */
export function findBrokenDocsLinks(
  sources: readonly DocsLinkSource[],
  targets: DocsLinkTargets,
): string[] {
  const failures: string[] = [];
  for (const { file, hrefs } of sources) {
    for (const href of hrefs) {
      const reason = brokenLinkReason(href, targets);
      if (reason) failures.push(`${file}: ${href} (${reason})`);
    }
  }
  return failures;
}
