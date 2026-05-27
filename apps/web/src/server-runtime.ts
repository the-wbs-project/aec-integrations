/**
 * Pure (Angular-free) runtime for the SSR Worker — route classification,
 * cookie hygiene, edge cache integration, and Hono wiring. Lives in its own
 * module so it can be unit-tested under plain-Node Vitest without booting
 * Angular. The Worker entry (`server.ts`) imports `createApp` from here and
 * supplies the Angular renderer.
 *
 * Two contracts pinned in `CLAUDE.md` and `docs/STAGE_1_SPEC.md` (§9.1, §9.1a,
 * §9.1b, §7a.3, §7a.3a) govern this module. Get either wrong and the
 * production edge cache breaks in ways that are hard to detect from staging:
 *
 *   1. The edge cache is keyed by URL only (Cloudflare Pro — no `Vary`, no
 *      cache-tag). If SSR reads a per-visitor cookie (e.g. `theme=dark`) and
 *      bakes the result into HTML, the first visitor's render is served to
 *      everyone. So: on the cacheable branch, strip visitor-state cookies
 *      *before* invoking SSR; the client reconciles theme post-hydration from
 *      `localStorage` + `matchMedia`.
 *
 *   2. Returning HTTP 200 with a "not found" body and a normal TTL causes the
 *      edge to pin the not-found response. New entities stay invisible until
 *      TTL expiry. So: 404s carry HTTP 404 and a ≤60s TTL.
 *
 * ROUTE CLASSIFICATION MATRIX
 * ────────────────────────────────────────────────────────────────────────────
 * CACHEABLE (cookies stripped, edge-cached with route-specific TTL):
 *   /                                       → 15min edge / 5min browser
 *   /products, /vendors, /integrations      → 5min  edge / 0     browser  (§8.3)
 *   /products/:slug, /vendors/:slug,
 *     /integrations/:id                     → 1hr  edge / 5min browser
 *   /categories/*, /disciplines/*,
 *     /phases/*                             → 30min edge / 5min browser
 *   /about, /legal/*                        → 24hr edge / 1hr  browser
 *
 * NON-CACHEABLE (cookies pass through unchanged, no edge cache, no s-maxage):
 *   /api/*       — forwarded raw to `env.API.fetch` (AECI-30 service binding);
 *                  Supabase session cookies MUST survive this path.
 *   /auth/*      — login / magic-link / OAuth callback all read session state.
 *   /account*    — user-specific.
 *   /search      — query-string explosion, per §9.2 not cached.
 *   <unknown>    — fail closed (`private, no-store`). A new page is
 *                  non-cacheable until it's explicitly added to the matcher
 *                  table; safer than the inverse.
 *
 * Locale prefixes from `LOCALES` are stripped before classification so the
 * matcher table stays single-source as locales are added. The `LOCALES`
 * constant MUST match `angular.json` `i18n.locales`; both files change
 * together (§7a.3a).
 *
 * When extending: add the new route pattern to `ROUTE_CACHE_PATTERNS`, update
 * the matrix above, and consider whether the new route needs to be exempted
 * from cookie stripping (i.e. added to the non-cacheable list instead).
 */

import { Hono } from 'hono';

import type { WebEnv } from './env';
import { buildCacheTags, cacheTagInputsForPath, type CacheTagInputs } from './server/cache-tags';
import { createAdminPurgeHandler } from './server/routes/admin-purge';

export type Bindings = WebEnv;

// ─── i18n ──────────────────────────────────────────────────────────────────

export const DEFAULT_LOCALE = 'en-US';

/**
 * Mirror of `angular.json` `i18n.locales`. The default locale has no URL
 * prefix; additional locales use a single-segment prefix matching their
 * `subPath`. Adding a locale requires updating BOTH this constant and
 * `angular.json` together (§7a.3a).
 */
export const LOCALES: readonly { locale: string; prefix: string }[] = [
  { locale: DEFAULT_LOCALE, prefix: '' },
];

/**
 * Removes a leading locale prefix from a pathname (if any) and returns the
 * matched locale + the locale-stripped path. Used so the cache-route matchers
 * can stay single-source across locales.
 */
export function stripLocalePrefix(pathname: string): {
  locale: string;
  path: string;
} {
  for (const { locale, prefix } of LOCALES) {
    if (!prefix) continue;
    if (pathname === prefix) return { locale, path: '/' };
    if (pathname.startsWith(`${prefix}/`)) {
      return { locale, path: pathname.slice(prefix.length) };
    }
  }
  return { locale: DEFAULT_LOCALE, path: pathname };
}

// ─── Preview-route gate ────────────────────────────────────────────────────

/**
 * `/preview/*` hosts dev-only ports of v0.dev screens (see
 * `apps/web/src/app/preview/preview.routes.ts`). The routes are registered in
 * every Angular build so they're available on `*.workers.dev` preview Worker
 * deploys, but production must return 404 — production users should never see
 * these surfaces. Locale prefixes are stripped first so future-locale
 * `/es/preview/...` URLs also hit the gate.
 */
export function isPreviewPath(pathname: string): boolean {
  const { path } = stripLocalePrefix(pathname);
  return path === '/preview' || path.startsWith('/preview/');
}

// ─── Cookie hygiene ────────────────────────────────────────────────────────

/**
 * Per-visitor cookies that influence rendered HTML. The Worker strips these
 * before invoking SSR on the cacheable branch — see §9.1a.
 */
export const VISITOR_STATE_COOKIES: readonly string[] = ['theme'];

/**
 * Returns a new Request with every cookie name in `VISITOR_STATE_COOKIES`
 * removed from the `Cookie` header. Other cookies (e.g. Supabase session)
 * pass through unchanged. The original Request is never mutated.
 *
 * Returns the original Request when no relevant cookies are present, to avoid
 * allocating when no work is needed.
 */
export function stripVisitorStateCookies(request: Request): Request {
  const cookie = request.headers.get('cookie');
  if (!cookie) return request;

  const stripPattern = new RegExp(`^(?:${VISITOR_STATE_COOKIES.map(escapeRegExp).join('|')})=`);
  const parts = cookie
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean);
  const kept = parts.filter((p) => !stripPattern.test(p));
  if (kept.length === parts.length) return request;

  const headers = new Headers(request.headers);
  if (kept.length === 0) headers.delete('cookie');
  else headers.set('cookie', kept.join('; '));

  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
  });
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Cache classification ──────────────────────────────────────────────────

export type CacheTtl = { edge: number; browser: number };

/**
 * §9.1b — 404 responses on cacheable routes get a short TTL so newly-created
 * entities become visible quickly. Status code remains 404 so monitoring and
 * sitemap tooling can distinguish real misses from stale cache.
 */
export const NOT_FOUND_TTL: CacheTtl = { edge: 60, browser: 60 };

type RoutePattern = {
  match: (path: string) => boolean;
  ttl: CacheTtl;
};

const ROUTE_CACHE_PATTERNS: readonly RoutePattern[] = [
  { match: (p) => p === '/', ttl: { edge: 900, browser: 300 } },
  { match: (p) => p === '/about', ttl: { edge: 86_400, browser: 3_600 } },
  {
    match: (p) => p === '/legal' || p.startsWith('/legal/'),
    ttl: { edge: 86_400, browser: 3_600 },
  },
  { match: (p) => /^\/products\/[^/]+$/.test(p), ttl: { edge: 3_600, browser: 300 } },
  { match: (p) => /^\/vendors\/[^/]+$/.test(p), ttl: { edge: 3_600, browser: 300 } },
  { match: (p) => /^\/integrations\/[^/]+$/.test(p), ttl: { edge: 3_600, browser: 300 } },
  // Phase 2 Spec §8.3 — index pages: edge 5 min, browser 0. The shorter edge
  // TTL is fine because the routes also carry `index:<entity>` tags that the
  // /admin/purge endpoint can invalidate on writes; the browser is told to
  // refetch on every navigation so users always see fresh server HTML.
  {
    match: (p) => p === '/products' || p === '/vendors' || p === '/integrations',
    ttl: { edge: 300, browser: 0 },
  },
  {
    match: (p) => p === '/categories' || p.startsWith('/categories/'),
    ttl: { edge: 1_800, browser: 300 },
  },
  {
    match: (p) => p === '/disciplines' || p.startsWith('/disciplines/'),
    ttl: { edge: 1_800, browser: 300 },
  },
  { match: (p) => p === '/phases' || p.startsWith('/phases/'), ttl: { edge: 1_800, browser: 300 } },
];

/**
 * Returns the TTL for a cacheable route, or `null` if the URL is not
 * cacheable. Locale prefixes are stripped before matching, so the patterns
 * stay single-source across locales.
 */
export function cacheControlForRoute(url: URL): CacheTtl | null {
  const { path } = stripLocalePrefix(url.pathname);
  for (const pattern of ROUTE_CACHE_PATTERNS) {
    if (pattern.match(path)) return pattern.ttl;
  }
  return null;
}

/**
 * Whether a URL is eligible for edge caching. Equivalent to
 * `cacheControlForRoute(url) !== null` but named to read as a predicate at
 * call sites.
 */
export function isCacheableRoute(url: URL): boolean {
  return cacheControlForRoute(url) !== null;
}

export function buildCacheControl(ttl: CacheTtl): string {
  return `public, max-age=${ttl.browser}, s-maxage=${ttl.edge}`;
}

// ─── SSR pipeline ──────────────────────────────────────────────────────────

export type SsrRenderer = (request: Request) => Promise<Response>;

/**
 * Returns Cloudflare's default edge cache, or `null` when running outside the
 * Worker runtime (e.g. unit tests in Node). Callers must guard.
 */
function getEdgeCache(): Cache | null {
  const cachesGlobal = (globalThis as { caches?: { default?: Cache } }).caches;
  return cachesGlobal?.default ?? null;
}

/**
 * Ensures a response carries an explicit non-cacheable directive when none is
 * already set. Cloudflare will otherwise apply default cache heuristics.
 */
function ensureNoStore(response: Response): Response {
  if (response.headers.has('Cache-Control')) return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Wraps a rendered SSR response with the cache headers for a cacheable route.
 * 404s receive `NOT_FOUND_TTL` (§9.1b); 2xx receive the route's TTL. Other
 * statuses (5xx, redirects) are returned non-cacheable.
 *
 * On 2xx, also writes `Cache-Tag` from the provided inputs (AECI-56 /
 * `docs/CACHE_STRATEGY.md` §2–3). 404s skip `Cache-Tag` — they aren't stored
 * in `caches.default` (see `handleSsr`), so the tag would never be a target
 * of purge-by-tag.
 */
function withCacheHeaders(
  response: Response,
  routeTtl: CacheTtl,
  tagInputs: CacheTagInputs | null,
): Response {
  const isOk = response.status >= 200 && response.status < 300;
  const is404 = response.status === 404;

  if (!isOk && !is404) return ensureNoStore(response);

  const ttl = is404 ? NOT_FOUND_TTL : routeTtl;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', buildCacheControl(ttl));
  if (isOk && tagInputs) {
    headers.set('Cache-Tag', buildCacheTags(tagInputs));
  }
  // Belt-and-braces: never let an upstream Vary slip through on a cacheable
  // response — it fragments the edge cache and breaks purge-by-URL (§7a.3,
  // §9.3). Locale is segmented by URL prefix, visitor state is client-only.
  headers.delete('Vary');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Subset of `ExecutionContext` the cache pipeline actually uses. Typed as the
 * minimum needed so call sites (Hono's `c.executionCtx`, tests, raw Worker
 * `fetch(req, env, ctx)`) don't fight type-narrowing differences between
 * Hono's `ExecutionContext<unknown>` and Cloudflare's looser
 * `ExecutionContext`.
 */
type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

/**
 * Optional post-SSR hook. `server.ts` uses this to (a) inject the Datadog RUM
 * bootstrap `<script>` into the rendered HTML before it reaches the edge
 * cache, so the cached payload already carries deployment-scoped public
 * tokens, and (b) emit a per-render Datadog log so any SSR hit produces
 * visible signal in Datadog Logs. Kept generic (no Datadog vocabulary in this
 * file) so `createApp` remains a pure cache/cookie/SSR pipeline.
 *
 * Receives the request and the waitUntil-capable ctx so transforms can fan
 * out async side-effects (logging, metrics) without blocking the response.
 */
export type ResponseTransform = (
  response: Response,
  env: Bindings,
  request: Request,
  ctx: WaitUntilContext,
) => Promise<Response> | Response;

/**
 * Fire-and-forget page-view capture for cacheable SSR routes (AECI-58 wiring
 * for the AECI-55 capture endpoint). POSTs `{ route }` to the private API
 * Worker via the service binding, dropped through `ctx.waitUntil` so the
 * outer response is never delayed. Phase 2 the endpoint is a no-op write
 * (returns 204); Phase 4 wires the `page_views` table.
 *
 * Errors are intentionally swallowed: a flaky capture path must never bubble
 * as a 5xx on the user's HTML response. The `.catch(() => {})` lives inside
 * the promise handed to `waitUntil` so the Workers runtime doesn't surface
 * the rejection either.
 */
function firePageView(env: Bindings, ctx: WaitUntilContext, route: string): void {
  ctx.waitUntil(
    env.API.fetch(
      new Request('https://api/api/page-views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ route }),
      }),
    )
      .then(() => undefined)
      .catch(() => undefined),
  );
}

async function handleSsr(
  request: Request,
  env: Bindings,
  renderer: SsrRenderer,
  ctx: WaitUntilContext,
  transformResponse?: ResponseTransform,
): Promise<Response> {
  const url = new URL(request.url);
  const ttl = request.method === 'GET' ? cacheControlForRoute(url) : null;

  if (ttl === null) {
    // Non-cacheable branch: pass cookies through, never cache.
    const rendered = await renderer(request);
    const transformed = transformResponse
      ? await transformResponse(rendered, env, request, ctx)
      : rendered;
    return ensureNoStore(transformed);
  }

  const { path: localePath } = stripLocalePrefix(url.pathname);

  // Cacheable branch: edge-cache lookup, then cookie-stripped render on miss.
  // page-view capture fires on BOTH branches so cached hits are also counted
  // (the metric reflects visitor arrivals, not SSR misses).
  const cache = getEdgeCache();
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      firePageView(env, ctx, localePath);
      return hit;
    }
  }

  const sanitized = stripVisitorStateCookies(request);
  const rendered = await renderer(sanitized);
  // Transform BEFORE cache write so the cached payload carries any
  // deployment-scoped inserts (e.g. Datadog public tokens).
  const transformed = transformResponse
    ? await transformResponse(rendered, env, request, ctx)
    : rendered;
  const tagInputs = cacheTagInputsForPath(localePath);
  const response = withCacheHeaders(transformed, ttl, tagInputs);

  // Per §9.1: only 2xx is stored. 404s are *returned* with NOT_FOUND_TTL via
  // the response's Cache-Control header (so Cloudflare honors it edge-side),
  // but we don't put them into the Worker's `caches.default` — keeps the
  // recovery story simple when an entity is created moments later.
  if (cache && response.status >= 200 && response.status < 300) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  firePageView(env, ctx, localePath);
  return response;
}

// ─── Hono app wiring ───────────────────────────────────────────────────────

/**
 * Build the Hono app. The SSR renderer is required so tests can inject a
 * stub without booting Angular; the Worker entry (`server.ts`) supplies the
 * real Angular renderer.
 */
export function createApp(options: {
  ssrRenderer: SsrRenderer;
  transformResponse?: ResponseTransform;
}): Hono<{
  Bindings: Bindings;
}> {
  const renderer = options.ssrRenderer;
  const transformResponse = options.transformResponse;
  const app = new Hono<{ Bindings: Bindings }>();

  // /api/* — raw passthrough to the private API Worker via the service
  // binding. Cookies (Supabase session, anti-CSRF, anything else) MUST reach
  // the API Worker untouched. No envelope normalization on this path; SSR
  // data loaders that want normalization go through `createServerApiClient`.
  app.all('/api/*', (c) => c.env.API.fetch(c.req.raw));

  // POST /admin/purge — manual cache-tag invalidation (AECI-56, Phase 2.10).
  // Non-cacheable; the handler authenticates with `ADMIN_PURGE_TOKEN` and
  // proxies to Cloudflare's purge-by-tag API.
  app.post('/admin/purge', createAdminPurgeHandler());

  // Everything else: cache-aware SSR pipeline.
  app.all('*', (c) => {
    // `/preview/*` is dev/preview-only. Block in production before invoking
    // Angular so the lazy preview chunks never load on the production Worker.
    // See `isPreviewPath` above for the path-shape contract.
    if (c.env.ENV === 'production') {
      const url = new URL(c.req.url);
      if (isPreviewPath(url.pathname)) {
        return new Response('Page not found.', {
          status: 404,
          headers: { 'Cache-Control': 'private, no-store' },
        });
      }
    }
    return handleSsr(c.req.raw, c.env, renderer, c.executionCtx, transformResponse);
  });

  return app;
}
