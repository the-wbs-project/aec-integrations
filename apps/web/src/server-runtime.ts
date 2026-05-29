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
 *     /integrations/:id                      → 15min edge / 0     browser  (§8.3)
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
import { createServerApiClient } from './server-api-client';
import { buildCacheTags, cacheTagInputsForPath, type CacheTagInputs } from './server/cache-tags';
import { createRequestContext, type AeciRequestContext } from './server/request-context';
import { buildRobotsTxt } from './server/robots';
import { createAdminPurgeHandler } from './server/routes/admin-purge';
import { buildSitemapXml, resolveSitemapEntries } from './server/sitemap';

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
 * §9.1b / AECI-62 AC — 404 responses on cacheable routes get a short edge
 * TTL (so newly-created entities become visible quickly) and `max-age=0` so
 * browsers always revalidate. Status code remains 404 so monitoring and
 * sitemap tooling can distinguish real misses from stale cache.
 */
export const NOT_FOUND_TTL: CacheTtl = { edge: 60, browser: 0 };

/**
 * AECI-62 AC — every 404 emitted by the cacheable branch carries this single
 * tag so the admin purge endpoint can bulk-invalidate negative responses
 * after a config fix (e.g. typo in route table, slug regenerated). 404s have
 * no entity-level tag — they aren't a particular product/vendor, they're an
 * absence. Kept as a constant rather than going through
 * `cacheTagInputsForPath` so the path-mapping table stays focused on
 * positive lookups.
 */
export const CACHE_TAG_NOT_FOUND = 'route:404';

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
  // Phase 2 §8.3: detail pages are `s-maxage=900, max-age=0`. AECI-60 brought
  // /integrations/:id onto this matrix (it was on a legacy 1hr/5min TTL before
  // the detail page existed).
  { match: (p) => /^\/products\/[^/]+$/.test(p), ttl: { edge: 900, browser: 0 } },
  { match: (p) => /^\/vendors\/[^/]+$/.test(p), ttl: { edge: 900, browser: 0 } },
  { match: (p) => /^\/integrations\/[^/]+$/.test(p), ttl: { edge: 900, browser: 0 } },
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

/**
 * SSR renderer contract. The runtime creates an `AeciRequestContext` per
 * request and passes it as the second arg; the renderer (in `server.ts`)
 * forwards it to `AngularAppEngine.handle(req, ctx)` so resolvers can mutate
 * it via Angular's built-in `REQUEST_CONTEXT` token. The runtime reads it
 * back after rendering to merge embedded cache tags and fire the page-view
 * payload. See `server/request-context.ts` for the contract.
 */
export type SsrRenderer = (request: Request, ctx: AeciRequestContext) => Promise<Response>;

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
 * `docs/CACHE_STRATEGY.md` §2–3). On 404, writes the single `route:404`
 * sentinel tag (AECI-62) so the admin purge endpoint can bulk-invalidate
 * negative responses after a config fix — 404s still aren't stored in
 * `caches.default` (see `handleSsr`), but Cloudflare's edge does cache them
 * per the response's `Cache-Control`, and a tag is the only way to evict
 * those without waiting for TTL expiry.
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
  if (is404) {
    headers.set('Cache-Tag', CACHE_TAG_NOT_FOUND);
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
 * Schedule a fire-and-forget `POST /api/page-views` against the API Worker
 * via the service binding. Phase 2 endpoint is a no-op (AECI-55); Phase 4
 * wires the actual write. Errors are swallowed — the page render must not
 * fail because analytics did. The payload shape is pinned in
 * `packages/shared/src/api/page-views.ts` (`PageViewPayloadSchema`).
 *
 * Cacheable routes fire on BOTH cache HIT and MISS so the metric reflects
 * visitor arrivals rather than SSR misses. On HIT the resolver never runs,
 * so the runtime synthesizes a minimal `{ route }` payload from the locale-
 * stripped path; on MISS the resolver may attach a richer payload (with
 * entity_type / entity_id) via `AeciRequestContext.pageView`.
 */
function firePageView(
  execCtx: WaitUntilContext,
  env: Bindings,
  payload: NonNullable<AeciRequestContext['pageView']>,
): void {
  execCtx.waitUntil(
    env.API.fetch(
      new Request('https://api/api/page-views', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    )
      .then(() => undefined)
      .catch(() => undefined),
  );
}

/**
 * Merge resolver-supplied embedded entities into the path-derived tag inputs.
 * `cacheTagInputsForPath` is path-only; the resolver knows which vendor and
 * which integrations the page actually renders. Returns `null` when the path
 * isn't cacheable (matching `cacheTagInputsForPath`'s contract).
 */
function mergeEmbeddedTags(
  base: CacheTagInputs | null,
  embedded: readonly { type: string; slug?: string; id?: string }[],
): CacheTagInputs | null {
  if (!base) return null;
  if (embedded.length === 0) return base;
  return {
    ...base,
    embedded: base.embedded ? [...base.embedded, ...embedded] : [...embedded],
  };
}

async function handleSsr(
  request: Request,
  env: Bindings,
  renderer: SsrRenderer,
  execCtx: WaitUntilContext,
  transformResponse?: ResponseTransform,
): Promise<Response> {
  const url = new URL(request.url);
  const ttl = request.method === 'GET' ? cacheControlForRoute(url) : null;
  const reqCtx = createRequestContext(createServerApiClient(env));

  if (ttl === null) {
    // Non-cacheable branch: pass cookies through, never cache.
    const rendered = await renderer(request, reqCtx);
    const transformed = transformResponse
      ? await transformResponse(rendered, env, request, execCtx)
      : rendered;
    // §9.1b / AECI-62 — 404 on a non-cacheable path (unknown URL hitting the
    // wildcard route) must still carry NOT_FOUND_TTL + the route:404 sentinel
    // tag. Without this, the edge would serve `private, no-store` and admin
    // would lose the bulk-purge handle for negative responses.
    const finalResponse =
      transformed.status === 404
        ? withCacheHeaders(transformed, NOT_FOUND_TTL, null)
        : ensureNoStore(transformed);
    if (reqCtx.pageView && finalResponse.status >= 200 && finalResponse.status < 300) {
      firePageView(execCtx, env, reqCtx.pageView);
    }
    return finalResponse;
  }

  const { path: localePath } = stripLocalePrefix(url.pathname);

  // Cacheable branch: edge-cache lookup, then cookie-stripped render on miss.
  // page-view capture fires on BOTH branches so cached hits are also counted
  // (the metric reflects visitor arrivals, not SSR misses). On HIT the
  // resolver never runs, so we synthesize a minimal `{ route }` payload; on
  // MISS a resolver may attach a richer payload via `reqCtx.pageView`.
  const cache = getEdgeCache();
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      firePageView(execCtx, env, { route: localePath });
      return hit;
    }
  }

  const sanitized = stripVisitorStateCookies(request);
  const rendered = await renderer(sanitized, reqCtx);
  // Transform BEFORE cache write so the cached payload carries any
  // deployment-scoped inserts (e.g. Datadog public tokens).
  const transformed = transformResponse
    ? await transformResponse(rendered, env, request, execCtx)
    : rendered;
  const tagInputs = mergeEmbeddedTags(cacheTagInputsForPath(localePath), reqCtx.embedded);
  const response = withCacheHeaders(transformed, ttl, tagInputs);

  // Per §9.1: only 2xx is stored. 404s are *returned* with NOT_FOUND_TTL via
  // the response's Cache-Control header (so Cloudflare honors it edge-side),
  // but we don't put them into the Worker's `caches.default` — keeps the
  // recovery story simple when an entity is created moments later.
  if (cache && response.status >= 200 && response.status < 300) {
    execCtx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  // Phase 2 §3.1 + AC: SSR fires `POST /api/page-views` after the response is
  // built. Only on 2xx — 404 / 5xx renders don't pollute view counts. Prefer
  // the resolver-attached payload (carries entity_type/entity_id when
  // available); otherwise fall back to the path-derived `{ route }`.
  if (response.status >= 200 && response.status < 300) {
    firePageView(execCtx, env, reqCtx.pageView ?? { route: localePath });
  }

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

  // GET /sitemap.xml — SEO discovery surface (AECI-63 / Phase 2.17). Handled
  // here, not by Angular: it enumerates every public entity from the API via
  // the service binding. `Cache-Tag: sitemap,taxonomy` is set literally rather
  // than via `buildCacheTags` (which only emits `route:*`/entity tags). On an
  // API failure we return a non-cacheable 500 so a transient error is never
  // pinned at the edge for the hour-long sitemap TTL.
  app.get('/sitemap.xml', async (c) => {
    const base = new URL(c.req.url).origin;
    try {
      const entries = await resolveSitemapEntries(createServerApiClient(c.env), base);
      return new Response(buildSitemapXml(entries), {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Cache-Control': buildCacheControl({ edge: 3600, browser: 0 }),
          'Cache-Tag': 'sitemap,taxonomy',
        },
      });
    } catch {
      return new Response('sitemap unavailable', {
        status: 500,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
  });

  // GET /robots.txt — allows the public surface, points at the sitemap. The
  // `Sitemap:` line is derived from the request origin so it is correct per
  // environment. Long-lived edge + browser TTL (CACHE_STRATEGY.md §4).
  app.get('/robots.txt', (c) => {
    const origin = new URL(c.req.url).origin;
    return new Response(buildRobotsTxt(origin), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': buildCacheControl({ edge: 86_400, browser: 86_400 }),
      },
    });
  });

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
