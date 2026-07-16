/**
 * Pure (Angular-free) runtime for the SSR Worker — route classification,
 * cookie hygiene, edge cache integration, and Hono wiring. Lives in its own
 * module so it can be unit-tested under plain-Node Vitest without booting
 * Angular. The Worker entry (`server.ts`) imports `createApp` from here and
 * supplies the Angular renderer.
 *
 * Two contracts pinned in `CLAUDE.md` and `docs/CACHE_STRATEGY.md` govern this
 * module. Get either wrong and the production edge cache breaks in ways that are
 * hard to detect from staging:
 *
 *   1. Native Cloudflare Workers Cache (WC-3 / AECI-317) sits *in front of* this
 *      Worker: the platform stores each cacheable response from its
 *      `Cache-Control` (`public, s-maxage=…`) and serves future HITs without ever
 *      running the Worker (there is no hand-rolled `caches.default` match/put).
 *      The cache key is URL-based (path + query string + Worker version), NOT
 *      cookies — so if SSR read a per-visitor cookie and baked it into HTML, the
 *      first visitor's render would be served to everyone. So: on the cacheable
 *      branch, strip visitor-state cookies *before* invoking SSR and keep the API
 *      client cookie-free. `VISITOR_STATE_COOKIES` is empty as of AECI-226
 *      (`theme` — the original entry — was removed with the dark theme), but the
 *      stripping mechanism is retained as general cache-pollution infrastructure.
 *      We still emit `Cache-Tag` (per-route, for queue purge — WC-5) and a
 *      `Vary: Accept-Language` advertisement; locale variance is already
 *      segmented by URL prefix (see §7 and `server/seo-headers.ts`). (Enabled on
 *      preview + staging first; demo/production stay gated on WC-4/5/6/8 —
 *      ADR 0020.)
 *
 *   2. Returning HTTP 200 with a "not found" body and a normal TTL causes the
 *      edge to pin the not-found response. New entities stay invisible until
 *      TTL expiry. So: 404s carry HTTP 404 and a ≤60s TTL.
 *
 * ROUTE CLASSIFICATION MATRIX
 * ────────────────────────────────────────────────────────────────────────────
 * CACHEABLE (cookies stripped, edge-cached with route-specific TTL):
 *   /                                       → 15min edge / 5min browser
 *   /products                               → 5min  edge / 0     browser  (§8.3)
 *   /products/:slug, /vendors/:slug,
 *     /integrations/:id                      → 15min edge / 0     browser  (§8.3)
 *   /categories/*, /audiences/*,
 *     /phases/*                             → 30min edge / 5min browser
 *   /disciplines, /disciplines/:slug        → 301 → /audiences[/:slug] (AECI-121)
 *   /vendors, /integrations                 → 301 → /products (AECI-165)
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

import { defaultIntegrationContext, LANDING_CF_HEADERS, PAGE_VIEW_CF_HEADERS } from '@aeci/shared';
import type { IntegrationDetail } from '@aeci/shared';
import { isPublicSite } from '@aeci/shared/deploy-env';
import { Hono } from 'hono';
import type { Context } from 'hono';

import type { WebEnv } from './env';
import { submitCount, submitDistribution } from './server-datadog';
import { createServerApiClient, isServerApiError } from './server-api-client';
import { buildCacheTags, cacheTagInputsForPath, type CacheTagInputs } from './server/cache-tags';
import { createRequestContext, type AeciRequestContext } from './server/request-context';
import { buildRobotsTxt } from './server/robots';
import { NOINDEX_DIRECTIVE, indexingAllowed } from './server/robots-policy';
import { applySeoHeaders } from './server/seo-headers';
import { createAdminPurgeHandler } from './server/routes/admin-purge';
import { createAuthCallbackHandler, sanitizeReturnPath } from './server/routes/auth-callback';
import { createAuthWhoamiHandler } from './server/routes/auth-whoami';
import { createIndexNowKeyHandler } from './server/routes/indexnow-key';
import { createVersionHandler } from './server/routes/version';
import { buildSitemapXml, resolveSitemapEntries } from './server/sitemap';

export type Bindings = WebEnv;

// ─── i18n ──────────────────────────────────────────────────────────────────

export const DEFAULT_LOCALE = 'en-US';

/**
 * Mirror of `angular.json` `i18n.locales`. The default locale has no URL
 * prefix; additional locales use a single-segment prefix matching their
 * `subPath`. `dir` is the locale's writing direction — `localeAttrsForPath`
 * resolves it onto `<html dir>` so logical Tailwind utilities (`ms-*`, `me-*`,
 * `text-start/end`, …) flip correctly under an RTL locale (AECI-153). Today
 * everything is LTR (en-US only). Adding a locale requires updating BOTH this
 * constant and `angular.json` together (§7a.3a).
 */
export const LOCALES: readonly { locale: string; prefix: string; dir: 'ltr' | 'rtl' }[] = [
  { locale: DEFAULT_LOCALE, prefix: '', dir: 'ltr' },
];

/** A single `LOCALES` entry — the shape `localeAttrsForPath` matches against. */
export type LocaleEntry = (typeof LOCALES)[number];

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

/**
 * Resolves the `<html lang>` / `<html dir>` attributes for a pathname from its
 * locale prefix (AECI-153). `lang` is the matched entry's `locale` (already
 * BCP-47 — no parallel map needed); `dir` is that locale's writing direction.
 * Falls back to the default (empty-prefix) entry — LTR en-US today — when no
 * prefix matches, mirroring `stripLocalePrefix`'s match rules.
 *
 * `locales` defaults to `LOCALES` but is injectable so the SSR injection helper
 * and its unit tests can exercise a synthetic RTL table without mutating the
 * readonly production constant.
 */
export function localeAttrsForPath(
  pathname: string,
  locales: readonly LocaleEntry[] = LOCALES,
): { lang: string; dir: 'ltr' | 'rtl' } {
  for (const { locale, prefix, dir } of locales) {
    if (!prefix) continue;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return { lang: locale, dir };
    }
  }
  const fallback = locales.find((l) => l.prefix === '') ?? locales[0];
  return { lang: fallback.locale, dir: fallback.dir };
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

// ─── Review-route auth gate (AECI-200) ─────────────────────────────────────

/**
 * Matches the authenticated review-submission route `/products/:slug/review`
 * (locale prefix already stripped by the caller). Distinct from
 * `/products/:slug` (detail, cacheable) and the claim/correction forms.
 */
export function isReviewPath(localePath: string): boolean {
  return /^\/products\/[^/]+\/review$/.test(localePath);
}

/**
 * Matches the authenticated account route `/account` (AECI-202, locale prefix
 * already stripped). Auth-gated + non-cacheable, same as the review form. A
 * trailing slash is tolerated; there are no `/account/*` subroutes today.
 */
export function isAccountPath(localePath: string): boolean {
  return /^\/account\/?$/.test(localePath);
}

/**
 * Matches the admin surface `/admin` and everything under it (locale prefix
 * already stripped by the caller). Used by the worker-level anon gate (AECI-203):
 * a logged-out visitor is bounced to login rather than shown a bare 404. NOTE
 * this is the SSR catch-all's concern only — the API Worker's `POST /admin/purge`
 * is a separate, earlier-registered route and is never reached through here.
 */
export function isAdminPath(localePath: string): boolean {
  return localePath === '/admin' || localePath.startsWith('/admin/');
}

/**
 * Cheap presence check for a Supabase session cookie (`sb-<ref>-auth-token`,
 * possibly chunked `.0`/`.1`/…). This is deliberately NOT a `getClaims()`
 * verification — no network, no crypto: the API Worker is the real enforcement
 * point on `POST /api/reviews` (it verifies the JWT). The SSR gate only keeps a
 * logged-out visitor from landing on a form they can't submit. An expired
 * cookie still passes here; the form renders and the eventual POST 401s, which
 * the form surfaces as a retryable notice.
 */
export function hasSessionCookie(request: Request): boolean {
  const cookie = request.headers.get('cookie');
  if (!cookie) return false;
  return /(?:^|;)\s*sb-[^=;]*-auth-token[^=;]*=/.test(cookie);
}

// ─── Cookie hygiene ────────────────────────────────────────────────────────

/**
 * Per-visitor cookies that influence rendered HTML. The Worker strips these
 * before invoking SSR on the cacheable branch — see §9.1a.
 *
 * Empty as of AECI-226: `theme` (the original entry) was removed with the dark
 * theme. The list + `stripVisitorStateCookies()` are retained as general
 * cache-pollution infrastructure — add a cookie name here the moment SSR begins
 * reading any per-visitor cookie on a cacheable route.
 */
export const VISITOR_STATE_COOKIES: readonly string[] = [];

/**
 * Returns a new Request with every cookie name in `VISITOR_STATE_COOKIES`
 * removed from the `Cookie` header. Other cookies (e.g. Supabase session)
 * pass through unchanged. The original Request is never mutated.
 *
 * Returns the original Request when no relevant cookies are present, to avoid
 * allocating when no work is needed.
 */
export function stripVisitorStateCookies(request: Request): Request {
  // No visitor-state cookies to strip (see VISITOR_STATE_COOKIES) — skip the
  // work and avoid building a degenerate, never-matching regex.
  if (VISITOR_STATE_COOKIES.length === 0) return request;

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

export type CacheTtl = {
  edge: number;
  browser: number;
  // WC-3 (AECI-317) — optional resilience directives. When set, `buildCacheControl`
  // emits `stale-while-revalidate` / `stale-if-error` so the native Workers Cache
  // can serve a just-expired copy while it revalidates in the background (swr) or
  // when the origin errors during revalidation (sie). Applied to the data-backed
  // detail + index/browse routes only (see `RESILIENCE`).
  staleWhileRevalidate?: number;
  staleIfError?: number;
};

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
  // AECI-100 / WC-4 (AECI-318) — query params that genuinely affect this route's
  // rendered HTML. The gateway entrypoint's normalized cache key (`cacheKeyFor`)
  // keeps only these (canonically ordered) and drops everything else (utm_*,
  // fbclid, …). Omitted ⇒ the route is query-independent and the key strips the
  // query string entirely. This list MUST be a superset of every param the page
  // component reads from the URL — under-including collapses distinct renders
  // onto one key and serves wrong HTML. See docs/CACHE_STRATEGY.md §4a.
  cacheKeyParams?: readonly string[];
};

/**
 * WC-3 (AECI-317) — resilience directives spread into the data-backed detail
 * and index/browse route TTLs. `stale-while-revalidate` lets the native cache
 * serve a just-expired copy for a short window while it revalidates in the
 * background (smooths the TTL-boundary latency spike); `stale-if-error` lets it
 * serve a day-old copy if the origin 5xxs during revalidation. Static pages
 * (`/about`, `/legal`), redirects, sitemap, robots and 404s deliberately omit
 * these. Values are tunable — see docs/CACHE_STRATEGY.md §4.
 */
const RESILIENCE = { staleWhileRevalidate: 60, staleIfError: 86_400 } as const;

/**
 * AECI-143 — the listing/browse routes (`/products` + the three taxonomy browse
 * pages) all read the same content-affecting query params: pagination
 * (`page`/`perPage`), `sort`, the `view` layout toggle (AECI-190), and the
 * faceted-filter ids (`category_id`/`audience_id`/`phase_id`). Shared so the four
 * routes stay in sync; a browse page's own dimension rides the path, so it only
 * ever sees the other two facet ids in its query — over-including all three is
 * harmless per the §4a rule.
 */
const LISTING_CACHE_KEY_PARAMS: readonly string[] = [
  'page',
  'perPage',
  'sort',
  'view',
  'category_id',
  'audience_id',
  'phase_id',
];

/**
 * Cache-key params whose value is a comma-separated *set* (multi-select taxonomy
 * facets, AECI-223). The producer (`aec-facet-sidebar` `onRefine`) already emits
 * these sorted, but WC-4 (AECI-318) also sorts them inside `cacheKeyFor` so a
 * raw/hand-typed/bot `?category_id=b,a` collapses onto the same key as `a,b` —
 * the cache-key layer no longer depends solely on the producer for the invariant.
 */
const MULTI_VALUE_CACHE_KEY_PARAMS: ReadonlySet<string> = new Set([
  'category_id',
  'audience_id',
  'phase_id',
]);

const ROUTE_CACHE_PATTERNS: readonly RoutePattern[] = [
  { match: (p) => p === '/', ttl: { edge: 900, browser: 300, ...RESILIENCE } },
  { match: (p) => p === '/about', ttl: { edge: 86_400, browser: 3_600 } },
  {
    match: (p) => p === '/legal' || p.startsWith('/legal/'),
    ttl: { edge: 86_400, browser: 3_600 },
  },
  // Phase 2 §8.3: detail pages are `s-maxage=900, max-age=0`. AECI-294 retired
  // the standalone /integrations/:id detail (now a 301 to the pair page) and
  // added the product-PAIR page /products/:contextSlug/integrations/:otherSlug —
  // a detail-class route on the same TTL. Listed BEFORE the plain /products/:slug
  // matcher for clarity (a three-segment path can't match the single-segment
  // product pattern, so ordering here isn't load-bearing). The pair page
  // SSR-renders a different layout for `?view=basic` (the Overview: sync headline
  // + descriptions, no claim lanes) vs. the `detailed` default, so `view` is
  // content-affecting and MUST stay in the key — hence `cacheKeyParams: ['view']`
  // (same rationale as AECI-190's `/products ?view=table`). WC-4 (AECI-318)
  // restored the utm-strip + per-route allowlist normalization the pre-WC-3
  // `cacheKeyUrl` applied; it now feeds `cf.cacheKey` on the gateway's loopback
  // to `Renderer` (see `cacheKeyFor`). The pair route reads only `view`, so the
  // listing union isn't reused here.
  {
    match: (p) => /^\/products\/[^/]+\/integrations\/[^/]+$/.test(p),
    ttl: { edge: 900, browser: 0, ...RESILIENCE },
    cacheKeyParams: ['view'],
  },
  { match: (p) => /^\/products\/[^/]+$/.test(p), ttl: { edge: 900, browser: 0, ...RESILIENCE } },
  { match: (p) => /^\/vendors\/[^/]+$/.test(p), ttl: { edge: 900, browser: 0, ...RESILIENCE } },
  // Phase 2 Spec §8.3 — the `/products` index: edge 5 min, browser 0. The
  // shorter edge TTL is fine because the route also carries the `index:products`
  // tag the purge path can invalidate on writes; the browser is told to refetch
  // on every navigation so users always see fresh server HTML. AECI-165 removed
  // the `/vendors` and `/integrations` index pages (they now 301-redirect to
  // `/products`, registered before the SSR catch-all in `createApp`).
  {
    match: (p) => p === '/products',
    ttl: { edge: 300, browser: 0, ...RESILIENCE },
    cacheKeyParams: LISTING_CACHE_KEY_PARAMS,
  },
  // CACHE_STRATEGY.md §4 — taxonomy browse pages AND the `/categories` index are
  // `s-maxage=300, max-age=0` (5 min edge, browser revalidates every nav), same
  // as the other index/browse routes. Per-slug pages also carry `{type}:{slug}`
  // + embedded `product:{slug}` tags for targeted purge.
  {
    match: (p) => p === '/categories' || p.startsWith('/categories/'),
    ttl: { edge: 300, browser: 0, ...RESILIENCE },
    cacheKeyParams: LISTING_CACHE_KEY_PARAMS,
  },
  {
    match: (p) => p === '/audiences' || p.startsWith('/audiences/'),
    ttl: { edge: 300, browser: 0, ...RESILIENCE },
    cacheKeyParams: LISTING_CACHE_KEY_PARAMS,
  },
  {
    match: (p) => p === '/phases' || p.startsWith('/phases/'),
    ttl: { edge: 300, browser: 0, ...RESILIENCE },
    cacheKeyParams: LISTING_CACHE_KEY_PARAMS,
  },
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

/**
 * Build the `Cache-Control` for a cacheable route. Always `public` so the native
 * Workers Cache stores it (WC-3 / AECI-317 — the platform caches from this header
 * in front of the Worker), with `max-age` (browser) + `s-maxage` (edge). When the
 * route opts into resilience (see `RESILIENCE`), also emit `stale-while-revalidate`
 * / `stale-if-error` so the edge can serve a slightly-stale copy while revalidating
 * or when the origin errors.
 */
export function buildCacheControl(ttl: CacheTtl): string {
  const parts = ['public', `max-age=${ttl.browser}`, `s-maxage=${ttl.edge}`];
  if (ttl.staleWhileRevalidate != null) {
    parts.push(`stale-while-revalidate=${ttl.staleWhileRevalidate}`);
  }
  if (ttl.staleIfError != null) {
    parts.push(`stale-if-error=${ttl.staleIfError}`);
  }
  return parts.join(', ');
}

// ─── Cache-key normalization + gateway entrypoint (WC-4 / AECI-318) ──────────

/** Sort a comma-separated set canonically (the AECI-223 multi-select CSV invariant). */
function sortCsv(value: string): string {
  return value
    .split(',')
    .filter((v) => v.length > 0)
    .sort()
    .join(',');
}

/**
 * Normalized cache key for a request. Restored in WC-4 (AECI-318) after WC-3
 * moved the SSR Worker onto native Cloudflare Workers Cache (which keys on the
 * full, order-sensitive query string). The gateway entrypoint forwards this
 * string as `cf.cacheKey` on the `ctx.exports` loopback to the cached `Renderer`
 * entrypoint; a custom `cf.cacheKey` *replaces the path + query string* in the
 * native key, so the value is PATH-RELATIVE — NOT a full-origin URL like the
 * pre-WC-3 `cacheKeyUrl` that keyed the removed `caches.default` match/put.
 * Origin isn't part of a custom key, and each env / Worker version is already an
 * isolated cache namespace, so no cross-env leakage.
 *
 * Drops marketing/tracking params (`utm_*`, `fbclid`, `gclid`, `ref`, …) so
 * query-independent pages share one entry, keeps only the content-affecting
 * params declared per route in `ROUTE_CACHE_PATTERNS`, and canonicalizes order —
 * `URLSearchParams.sort()` on names (`?sort=name&page=2` == `?page=2&sort=name`)
 * plus a value sort on multi-select facet CSVs (`category_id=a,b` == `b,a`). A
 * path with no matching pattern (or no `cacheKeyParams`) yields the bare
 * `pathname` — the safe "strip everything" default. The pathname (incl. any
 * locale prefix) is preserved verbatim; locale variance is segmented by URL
 * prefix, so the key must keep it.
 */
export function cacheKeyFor(url: URL): string {
  const { path } = stripLocalePrefix(url.pathname);
  const allowed = ROUTE_CACHE_PATTERNS.find((pattern) => pattern.match(path))?.cacheKeyParams ?? [];
  const params = new URLSearchParams();
  for (const name of allowed) {
    for (const value of url.searchParams.getAll(name)) {
      params.append(name, MULTI_VALUE_CACHE_KEY_PARAMS.has(name) ? sortCsv(value) : value);
    }
  }
  params.sort(); // canonical param order — ?sort=name&page=2 and ?page=2&sort=name → one key
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/** The subset of the Worker's own entrypoints the gateway reaches via `ctx.exports`. */
type GatewayExports = { Renderer: Fetcher };

/**
 * Gateway entrypoint — the SSR Worker's `default` export (WC-4 / AECI-318). Its
 * own cache is DISABLED in `apps/web/wrangler.jsonc` (`exports.default`), so it
 * runs on every request: it computes the normalized cache key and forwards the
 * *original, unmodified* request to the cached `Renderer` entrypoint through the
 * `ctx.exports` loopback. Passing `cf.cacheKey` there replaces the path+query in
 * the native cache key, restoring the utm-strip / per-route allowlist /
 * canonical-order normalization WC-3 removed with the hand-rolled `caches.default`
 * pipeline. The request itself is untouched (utm_* etc. survive for the render +
 * client analytics); only the cache *lookup key* is normalized. Non-GET/HEAD
 * requests forward with no custom key — they aren't cached. `Renderer` (declared
 * in `server.ts`) wraps the Hono `app`, so all routing / SSR / `Cache-Control`
 * emission is unchanged and sits behind the cache.
 */
export const cacheGateway = {
  async fetch(request: Request, _env: Bindings, ctx: ExecutionContext): Promise<Response> {
    // `ctx.exports` is typed `Cloudflare.Exports`; cast to the one entrypoint we
    // call so this compiles independently of the generated loopback typings.
    const { Renderer } = ctx.exports as unknown as GatewayExports;
    if (request.method === 'GET' || request.method === 'HEAD') {
      return Renderer.fetch(request, { cf: { cacheKey: cacheKeyFor(new URL(request.url)) } });
    }
    return Renderer.fetch(request);
  },
};

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
 * negative responses after a config fix — the native Workers Cache stores the
 * 404 from its `NOT_FOUND_TTL` `Cache-Control` (short edge TTL), and the tag is
 * the only way to evict it early without waiting for TTL expiry.
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
  // SEO/security header set (AECI-89 / §7, §8.6): `Vary: Accept-Language`,
  // `Link: </sitemap.xml>; rel=sitemap`, and the Content-Security-Policy. The
  // Vary handling is delete-then-set — any upstream `Cookie`/`User-Agent` Vary
  // is stripped (those fragment the edge cache with no purge handle) while the
  // URL-segmented locale dimension is advertised.
  applySeoHeaders(headers);
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
 * Cloudflare request context (`request.cf`) the API Worker needs to enrich
 * `page_views` (AECI-177). It is populated on the inbound eyeball request but
 * does NOT survive the `env.API` service binding, so we copy the needed fields
 * onto the trusted `PAGE_VIEW_CF_HEADERS` (`x-aeci-cf-*`) before forwarding.
 * Structural — we read only the four fields we forward, so no global CF typing
 * is required and a `.cf`-less request (Node tests, local dev) is a clean no-op.
 */
interface CfLike {
  country?: string | null;
  colo?: string | null;
  asn?: number | null;
  botManagement?: { score?: number | null } | null;
}

/**
 * Set the trusted `x-aeci-cf-*` headers from `request.cf`. Only fields that are
 * actually present are set, so the API Worker sees a header exactly when the
 * value exists. No-op when `request.cf` is absent.
 */
export function applyCfContextHeaders(headers: Headers, request: Request): void {
  const cf = (request as { cf?: CfLike }).cf;
  if (!cf) return;
  if (cf.country) headers.set(PAGE_VIEW_CF_HEADERS.country, cf.country);
  if (cf.colo) headers.set(PAGE_VIEW_CF_HEADERS.colo, cf.colo);
  if (typeof cf.asn === 'number') headers.set(PAGE_VIEW_CF_HEADERS.asn, String(cf.asn));
  const score = cf.botManagement?.score;
  if (typeof score === 'number') headers.set(PAGE_VIEW_CF_HEADERS.botScore, String(score));
}

/**
 * Rebuild a proxied `POST /api/page-views` request carrying trusted CF context.
 * The SSR Worker is the sole writer of `PAGE_VIEW_CF_HEADERS`, so any
 * client-supplied copies are stripped first (anti-spoof) before we set fresh
 * values from `request.cf`. Body / method / other headers (incl. `user-agent`,
 * which the API hashes) pass through unchanged.
 */
export function withForwardedCfContext(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of Object.values(PAGE_VIEW_CF_HEADERS)) headers.delete(name);
  applyCfContextHeaders(headers, request);
  return new Request(request, { headers });
}

/**
 * Cloudflare request context (`request.cf`) the API Worker needs to enrich the
 * landing lead-capture rows (`mailing_list` / `feedback`, AECI-275). Like the
 * page-view fields it is populated on the inbound eyeball request but does NOT
 * survive the `env.API` service binding, so the SSR Worker copies it onto the
 * trusted `LANDING_CF_HEADERS` (`x-aeci-cf-*`) before forwarding the unified
 * home's closing-CTA island `POST /api/subscribe` + `/api/feedback`. Structural —
 * only the fields we forward are read, so a `.cf`-less request (Node tests, local
 * dev) is a clean no-op and geo simply stays null.
 */
interface LandingCfLike {
  country?: string | null;
  city?: string | null;
  region?: string | null;
  timezone?: string | null;
  asOrganization?: string | null;
  asn?: number | null;
  metroCode?: number | null;
}

/**
 * Set the trusted `LANDING_CF_HEADERS` from `request.cf`. Only fields that are
 * actually present are set, so the API Worker sees a header exactly when the
 * value exists. No-op when `request.cf` is absent.
 */
export function applyLandingCfHeaders(headers: Headers, request: Request): void {
  const cf = (request as { cf?: LandingCfLike }).cf;
  if (!cf) return;
  if (cf.country) headers.set(LANDING_CF_HEADERS.country, cf.country);
  if (cf.city) headers.set(LANDING_CF_HEADERS.city, cf.city);
  if (cf.region) headers.set(LANDING_CF_HEADERS.region, cf.region);
  if (cf.timezone) headers.set(LANDING_CF_HEADERS.timezone, cf.timezone);
  if (cf.asOrganization) {
    headers.set(LANDING_CF_HEADERS.asOrganization, String(cf.asOrganization));
  }
  if (typeof cf.asn === 'number') headers.set(LANDING_CF_HEADERS.asn, String(cf.asn));
  if (typeof cf.metroCode === 'number') {
    headers.set(LANDING_CF_HEADERS.metroCode, String(cf.metroCode));
  }
}

/**
 * Rebuild a proxied `POST /api/subscribe` or `/api/feedback` request carrying
 * trusted CF geo context (AECI-275). The SSR Worker is the sole writer of
 * `LANDING_CF_HEADERS`, so any client-supplied copies are stripped first
 * (anti-spoof) before fresh values are set from `request.cf`. Body / method /
 * other headers (incl. the body's UTM + referrer) pass through unchanged.
 */
export function withForwardedLandingCf(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of Object.values(LANDING_CF_HEADERS)) headers.delete(name);
  applyLandingCfHeaders(headers, request);
  return new Request(request, { headers });
}

/**
 * Schedule a fire-and-forget `POST /api/page-views` against the API Worker via
 * the service binding. This is the SSR Worker's supplementary write (§14.2): it
 * captures CF/bot context for full-document renders. It is NOT the canonical
 * per-view counter — it undercounts because true edge-cache hits bypass the SSR
 * Worker entirely; the browser `PageViewTracker` (AECI-151) is the canonical
 * counter and is de-duped against this by skipping the initial navigation (SSR
 * counts the landing arrival, the client counts subsequent in-app navigations).
 *
 * Errors are swallowed — the page render must not fail because analytics did.
 * The payload shape is pinned in `@aeci/shared` (`PageViewPayloadSchema`).
 * `sourceRequest` is the inbound eyeball request: its `request.cf` and
 * `user-agent` are forwarded so the API Worker enriches this write the same way
 * it enriches the browser's proxied POST.
 *
 * Under native Workers Cache (WC-3 / AECI-317) an edge HIT never runs the SSR
 * Worker, so this fires only when the Worker actually renders — a native-cache
 * MISS on a cacheable route, or a non-cacheable render. Edge HITs are therefore
 * not counted server-side; the browser `PageViewTracker` (canonical, above)
 * covers them. On a MISS the resolver may attach a richer payload (entity_type /
 * entity_id) via `AeciRequestContext.pageView`; otherwise the runtime falls back
 * to the path-derived `{ route }`.
 */
function firePageView(
  execCtx: WaitUntilContext,
  env: Bindings,
  payload: NonNullable<AeciRequestContext['pageView']>,
  sourceRequest: Request,
): void {
  const headers = new Headers({ 'content-type': 'application/json' });
  applyCfContextHeaders(headers, sourceRequest);
  const userAgent = sourceRequest.headers.get('user-agent');
  if (userAgent) headers.set('user-agent', userAgent);
  execCtx.waitUntil(
    env.API.fetch(
      new Request('https://api/api/page-views', {
        method: 'POST',
        headers,
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
  const start = Date.now();
  const url = new URL(request.url);
  const ttl = request.method === 'GET' ? cacheControlForRoute(url) : null;
  // The API client is built per-branch (below) so cache-neutrality is structural:
  // the cookie-FORWARDING client (which lets an authenticated SSR resolver read
  // the visitor's `sb-…-auth-token` cookie — AECI-203) is constructed ONLY in the
  // non-cacheable branch and can never reach the response written to the shared
  // edge cache. The cacheable branch keeps the cookie-free client.

  // AECI-103 — bounded per-render *count* covering every branch the Worker runs:
  // the non-cacheable branch (which `aeci.page.render.duration_ms` excludes — see
  // the comment below) and the cacheable render (a native-cache MISS). Edge HITs
  // skip the Worker under WC-3, so there is no `hit` count here — HIT visibility
  // moves to `Cf-Cache-Status` + the Workers observability dashboard (WC-8). This
  // is the cost-bounded pipe-health signal that replaces the per-render log
  // firehose. Tags are deliberately low-cardinality (`cache_status` +
  // `status_class`) — no path/slug tags — so metric cost can't blow up.
  // Documented in docs/OBSERVABILITY.md.
  const emitRenderCount = (cacheStatus: 'miss' | 'non_cacheable', statusCode: number): void => {
    submitCount(execCtx, env, request, 'aeci.ssr.render', 1, [
      `cache_status:${cacheStatus}`,
      `status_class:${Math.floor(statusCode / 100)}xx`,
    ]);
  };

  if (ttl === null) {
    // Non-cacheable branch: pass cookies through, never cache. Forward the
    // inbound `Cookie` onto the SSR→API service-binding calls so an
    // authenticated resolver (e.g. the `/admin` gate) can read the session
    // cookie. Safe here precisely because this branch never writes the response
    // to the shared edge cache.
    const reqCtx = createRequestContext(createServerApiClient(env, { forwardCookieFrom: request }));
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
      firePageView(execCtx, env, reqCtx.pageView, request);
    }
    emitRenderCount('non_cacheable', finalResponse.status);
    return finalResponse;
  }

  const { path: localePath } = stripLocalePrefix(url.pathname);

  // AECI-66 / Phase 2 §14 — emit `aeci.page.render.duration_ms` for cacheable
  // routes, tagged by `route_class` (detail/index/browse) + `cache_status` +
  // `status_code` so the dashboard's 4xx/5xx widget can split on it. Under WC-3
  // the Worker only runs on a native-cache MISS (edge HITs skip it), so the sole
  // `cache_status` value here is `MISS`; HIT-rate visibility moves to
  // `Cf-Cache-Status` + the Workers observability dashboard (WC-8). Non-cacheable
  // paths (the 404 wildcard, non-GET) have no route_class and are intentionally
  // excluded from this histogram — they're covered by the `aeci.ssr.render` count
  // metric (AECI-103, emitted on every branch). Documented in docs/OBSERVABILITY.md.
  const routeClass = cacheTagInputsForPath(localePath)?.route;
  const emitRenderMetric = (statusCode: number): void => {
    if (!routeClass) return;
    // `status_class` (2xx/4xx/5xx) is what the error-rate widget + monitor split
    // on — Datadog tag filters can't do numeric `>= 400` on `status_code`.
    submitDistribution(execCtx, env, request, 'aeci.page.render.duration_ms', Date.now() - start, [
      `route_class:${routeClass}`,
      'cache_status:MISS',
      `status_code:${statusCode}`,
      `status_class:${Math.floor(statusCode / 100)}xx`,
    ]);
  };

  // Cacheable branch: cookie-stripped render. The native Workers Cache (WC-3)
  // stores the response from its `Cache-Control` and serves future HITs in front
  // of the Worker, so there is no `caches.default` match/put here — reaching this
  // code at all means the platform cache missed (or is revalidating).
  const sanitized = stripVisitorStateCookies(request);
  // Cookie-FREE API client on the cacheable branch: this render can be stored by
  // the shared edge cache, so it must never forward a visitor's session cookie
  // (cache-neutrality). The cookie-stripped `sanitized` request goes to SSR; the
  // client below carries no inbound auth.
  const reqCtx = createRequestContext(createServerApiClient(env));
  const rendered = await renderer(sanitized, reqCtx);
  // Transform BEFORE the response is returned so the cached payload carries any
  // deployment-scoped inserts (e.g. Datadog public tokens).
  const transformed = transformResponse
    ? await transformResponse(rendered, env, request, execCtx)
    : rendered;
  const tagInputs = mergeEmbeddedTags(cacheTagInputsForPath(localePath), reqCtx.embedded);
  const response = withCacheHeaders(transformed, ttl, tagInputs);
  emitRenderMetric(response.status);
  emitRenderCount('miss', response.status);

  // Phase 2 §3.1 + AC: SSR fires `POST /api/page-views` after the response is
  // built. Only on 2xx — 404 / 5xx renders don't pollute view counts. Prefer
  // the resolver-attached payload (carries entity_type/entity_id when
  // available); otherwise fall back to the path-derived `{ route }`.
  if (response.status >= 200 && response.status < 300) {
    firePageView(execCtx, env, reqCtx.pageView ?? { route: localePath }, request);
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

  // apex → www 301 (canonical host = `www.`; ADR 0011 amendment 2026-07-05, which
  // flips the original AECI-247 www→apex direction). Production binds BOTH the bare
  // apex (`aecintegrations.com`) and `www.aecintegrations.com` to this Worker; the
  // canonical host is now `www.` (self-referential canonicals + `PUBLIC_SITE_URL`,
  // ADR 0011), so the bare apex is folded to `www.` with a permanent redirect.
  // Registered first so it short-circuits before SSR and the X-Robots stamp; path
  // + query are preserved in the Location. Cache-Control is `private, max-age=3600`
  // — browser-cacheable but NOT edge-cacheable (AECI-318 / WC-4): the Location embeds
  // the query, but the WC-4 gateway normalizes the shared-edge cache key (strips the
  // query for the bare-apex path), so a shared edge entry would collapse distinct-query
  // apex hits onto whichever Location warmed it first. `private` keeps the flip off the
  // edge — the browser keys on the full URL and stays correct — so enabling prod
  // caching in WC-5/6/8 can't silently mis-route the naked domain.
  // Only the EXACT bare apex matches — `www.` itself (which serves), the `prod.`/
  // `demo.`/`staging.` tiers, `localhost`, and `*.workers.dev` never carry it, so no
  // other host is touched. `www.` never redirects, so a fresh client does at most one
  // apex→www hop and there is no apex↔www loop (a loop is only possible for a client
  // still replaying the retired www→apex 301 from cache — bounded by its 1h browser
  // TTL / 24h edge TTL, so purge the edge cache after the direction flip deploys).
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    if (url.hostname === 'aecintegrations.com') {
      return new Response(null, {
        status: 301,
        headers: {
          Location: `${url.protocol}//www.${url.hostname}${url.pathname}${url.search}`,
          'Cache-Control': 'private, max-age=3600',
        },
      });
    }
    return next();
  });

  // Pre-launch crawler block (`server/robots-policy.ts`). FAIL-CLOSED: unless
  // `ALLOW_INDEXING=true`, stamp `X-Robots-Tag: noindex, nofollow` on every
  // response so demo (public, NOT behind Access), staging, and PR previews never
  // enter a search index — even when a crawler ignores robots.txt or reaches a
  // URL via an external link. Registered first so it wraps every route.
  //
  // `/api/*` is skipped: those are byte-for-byte proxied to the private API
  // Worker (JSON, never indexable) and the passthrough contract keeps them
  // untouched. The response is rebuilt rather than mutated in place because a
  // response's headers may be immutable. Under native Workers Cache (WC-3) a HIT
  // skips the Worker, so this egress stamp runs only on the render that populates
  // the cache — the `noindex` decision is baked into the stored payload and served
  // on every subsequent HIT (no per-HIT re-stamp is possible). WC-8 (AECI-322)
  // hardens this so a front-of-Worker HIT can never leak an indexable non-prod page.
  app.use('*', async (c, next) => {
    await next();
    if (indexingAllowed(c.env)) return;
    if (new URL(c.req.url).pathname.startsWith('/api/')) return;
    const res = c.res;
    if (res.headers.get('X-Robots-Tag')) return;
    const headers = new Headers(res.headers);
    headers.set('X-Robots-Tag', NOINDEX_DIRECTIVE);
    c.res = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  });

  // /api/* — raw passthrough to the private API Worker via the service
  // binding. Cookies (Supabase session, anti-CSRF, anything else) MUST reach
  // the API Worker untouched. No envelope normalization on this path; SSR
  // data loaders that want normalization go through `createServerApiClient`.
  //
  // Two enriched POST exceptions rebuild the request with trusted Cloudflare
  // request-context headers (request.cf doesn't survive the binding) after
  // stripping any client-supplied copies (anti-spoof):
  //   - `POST /api/page-views` (AECI-177) → `PAGE_VIEW_CF_HEADERS`.
  //   - `POST /api/subscribe` + `/api/feedback` (AECI-275) → `LANDING_CF_HEADERS`,
  //     the closing-CTA island's lead-capture geo. UTM + referrer still ride the
  //     body; only geo is header-forwarded.
  // Every other `/api/*` request still forwards `c.req.raw` byte-for-byte.
  app.all('/api/*', (c) => {
    const req = c.req.raw;
    if (req.method === 'POST') {
      const { pathname } = new URL(req.url);
      if (pathname === '/api/page-views') {
        return c.env.API.fetch(withForwardedCfContext(req));
      }
      if (pathname === '/api/subscribe' || pathname === '/api/feedback') {
        return c.env.API.fetch(withForwardedLandingCf(req));
      }
    }
    return c.env.API.fetch(req);
  });

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

  // GET /robots.txt — when indexing is allowed, allows the public surface and
  // points at the sitemap (the `Sitemap:` line is derived from the request
  // origin so it is correct per environment). When indexing is disallowed
  // (pre-launch: demo/staging/previews), `Allow: /` with no sitemap line —
  // crawling stays permitted so the `X-Robots-Tag: noindex` egress stamp above
  // is actually seen and honored; a `Disallow: /` would hide the noindex from
  // compliant crawlers. Long-lived edge + browser TTL (CACHE_STRATEGY.md §4).
  app.get('/robots.txt', (c) => {
    const origin = new URL(c.req.url).origin;
    return new Response(buildRobotsTxt(origin, indexingAllowed(c.env)), {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': buildCacheControl({ edge: 86_400, browser: 86_400 }),
      },
    });
  });

  // GET /{INDEXNOW_KEY}.txt — IndexNow key-verification file (AECI-236, §20.2).
  // Search engines fetch it to confirm host ownership before honoring the
  // IndexNow submissions the API Worker sends on promote. Only the configured key
  // file is served (text/plain = the key); every other root-level `*.txt` (and a
  // wrong/unset key) falls through to the SSR catch-all → branded 404. The literal
  // `/robots.txt` above is registered first, so this param route never intercepts
  // it. No-op until INDEXNOW_KEY is provisioned at launch.
  app.get('/:file{[^/]+\\.txt}', createIndexNowKeyHandler());

  // GET /_version — the SSR Worker's OWN build metadata (AECI-92). Served here,
  // NOT proxied: `/api/version` forwards raw to the API Worker and so only ever
  // reports the API Worker's SHA. This route reports the SSR Worker's
  // `COMMIT_SHA` so CI can verify the SSR bundle is current independently of the
  // API deploy. `private, no-store` (set in the handler), no `Cache-Tag`.
  app.get('/_version', createVersionHandler());

  // GET /auth/whoami — THROWAWAY(AECI-193) auth-spike smoke route; remove when
  // Phase 5.5 lands real auth surfaces. Registered before the SSR catch-all so
  // it wins; `/auth/*` is already non-cacheable in the route classifier (the
  // fail-closed matrix above), so no classifier or `VISITOR_STATE_COOKIES`
  // change accompanies it. 401 without a session cookie, 200 (with a
  // full-chain API-Worker verification payload) with one.
  app.get('/auth/whoami', createAuthWhoamiHandler());

  // GET /auth/callback — Phase 5.4 (AECI-195) PKCE callback: code → session
  // (cookies set via the @supabase/ssr Hono adapter), defensive
  // profile-ensure over the service binding, 303 to the validated same-origin
  // `return` path (errors → /auth/login?error=…). Registered before the SSR
  // catch-all so it wins; `/auth/*` is already non-cacheable in the route
  // classifier, so no classifier or `VISITOR_STATE_COOKIES` change.
  app.get('/auth/callback', createAuthCallbackHandler());

  // AECI-121 — permanent redirects for the renamed taxonomy facet
  // (Discipline → Audience). Registered BEFORE the SSR catch-all so they win;
  // `/disciplines/*` no longer SSRs (the Angular route is `/audiences/:slug` and
  // `ROUTE_CACHE_PATTERNS` lists `/audiences`). 301 (permanent) so search engines
  // transfer link equity to the canonical `/audiences/*` URLs, with the query
  // string preserved in the Location so a filtered legacy link keeps its facets.
  //
  // Cache-Control is `private, max-age=3600` — browser-cacheable but NOT
  // edge-cacheable (AECI-318 / WC-4). The Location embeds the query, but the WC-4
  // gateway normalizes the shared-edge cache key and strips the query for
  // non-listing paths like `/disciplines/*` (not in `ROUTE_CACHE_PATTERNS`); a
  // shared edge entry would therefore collapse distinct-query links onto whichever
  // Location warmed it first, serving the wrong redirect target. `private` keeps
  // this off the edge; the browser keys on the full URL, so per-URL client caching
  // stays correct. No `Cache-Tag` — nothing is edge-stored to purge, and the
  // slug→audience mapping is immutable. Locale-prefixed `/es/disciplines/...` (no
  // locales ship yet) would fall through to the SSR 404, acceptable until a locale
  // is added.
  const audienceRedirect = (c: Context<{ Bindings: Bindings }>): Response => {
    const url = new URL(c.req.url);
    const targetPath = url.pathname.replace(/^\/disciplines/, '/audiences');
    return new Response(null, {
      status: 301,
      headers: {
        Location: `${url.origin}${targetPath}${url.search}`,
        'Cache-Control': 'private, max-age=3600',
      },
    });
  };
  app.get('/disciplines', audienceRedirect);
  app.get('/disciplines/:slug', audienceRedirect);

  // AECI-165 — the `/vendors` and `/integrations` index/listing pages were
  // removed (orphaned from the nav after AECI-160). They were previously
  // indexable and in `sitemap.xml`, so they 301-redirect to `/products` (the
  // remaining directory listing) rather than 404 — search engines transfer link
  // equity instead of dropping the URLs. Registered BEFORE the SSR catch-all so
  // they win, and as a standalone Response (NOT through `handleSsr`, which forces
  // 3xx to `no-store`) so the permanent mapping stays edge-cacheable. Only the
  // bare index paths match here — `/vendors/:slug`, the claim/correction forms,
  // and `/integrations/:id` fall through to the SSR pipeline unchanged. The
  // mapping never changes, so no `Cache-Tag` purge handle is needed. The query
  // string is dropped: the old listing's `page` / `sort` / `sourceProductId`
  // params don't map onto `/products`. Locale-prefixed `/es/vendors` (no locales
  // ship yet) would fall through to the SSR 404, acceptable until a locale lands.
  const removedIndexRedirect = (c: Context<{ Bindings: Bindings }>): Response => {
    const url = new URL(c.req.url);
    return new Response(null, {
      status: 301,
      headers: {
        Location: `${url.origin}/products`,
        'Cache-Control': buildCacheControl({ edge: 86_400, browser: 3_600 }),
      },
    });
  };
  app.get('/vendors', removedIndexRedirect);
  app.get('/integrations', removedIndexRedirect);

  // AECI-294 (Stage 1.5) — the standalone `/integrations/:id` detail page was
  // consolidated into the product-PAIR page. Any legacy link 301-redirects to the
  // canonical pair URL: we resolve the integration's two product slugs via the
  // API binding, pick the alphabetically-first as the context (`defaultIntegrationContext`
  // — the SAME rule the pair route, canonical, and sitemap use), and redirect.
  // The 301 is emitted as a standalone Response (NOT via `handleSsr`, which forces
  // 3xx to `no-store`) so the permanent mapping stays edge-cacheable, and tagged
  // `integration:{id}` so a promote touching that integration can purge the
  // redirect. Slugs are immutable (§6.2), so the target is stable. Registered
  // BEFORE the SSR catch-all so it wins. An unknown id is NOT redirected — it
  // renders the standard SSR 404 (the Angular `**` wildcard: branded, accessible,
  // `noindex`, with `NOT_FOUND_TTL` + `route:404`), exactly like a junk
  // product/vendor slug, so junk ids never 301 to `/products`.
  const pairRedirect = async (c: Context<{ Bindings: Bindings }>): Promise<Response> => {
    const url = new URL(c.req.url);
    const id = c.req.param('id');
    // Delegate to the SSR pipeline so a missing/unknown id gets the real 404 page
    // (accessible + noindex), not a bare text body. `/integrations/:id` is
    // non-cacheable, so `handleSsr` renders the `**` wildcard and applies
    // `NOT_FOUND_TTL` + `route:404` to the 404 response.
    const notFound = () => handleSsr(c.req.raw, c.env, renderer, c.executionCtx, transformResponse);
    if (!id) return notFound();

    let integration: IntegrationDetail | null = null;
    try {
      integration = await createServerApiClient(c.env).request<IntegrationDetail>(
        `/api/integrations/${encodeURIComponent(id)}`,
      );
    } catch (err) {
      // A NOT_FOUND (unknown/malformed id) → render the SSR 404 below; any other
      // API error is a real failure and must surface.
      if (!(isServerApiError(err) && err.status === 404)) throw err;
    }

    if (!integration) return notFound();

    const context = defaultIntegrationContext(integration.source.slug, integration.target.slug);
    const other =
      context === integration.source.slug ? integration.target.slug : integration.source.slug;

    return new Response(null, {
      status: 301,
      headers: {
        Location: `${url.origin}/products/${context}/integrations/${other}`,
        'Cache-Control': buildCacheControl({ edge: 86_400, browser: 3_600 }),
        'Cache-Tag': `integration:${id}`,
      },
    });
  };
  app.get('/integrations/:id', pairRedirect);

  // Everything else: cache-aware SSR pipeline.
  app.all('*', (c) => {
    // `/preview/*` is dev/preview-only. Block on the public tiers (production +
    // demo) before invoking Angular so the lazy preview chunks never load on a
    // public, non-Access-gated Worker. See `isPreviewPath` above for the
    // path-shape contract and `@aeci/shared/deploy-env` for `isPublicSite`.
    if (isPublicSite(c.env.ENV)) {
      const url = new URL(c.req.url);
      if (isPreviewPath(url.pathname)) {
        return new Response('Page not found.', {
          status: 404,
          headers: { 'Cache-Control': 'private, no-store' },
        });
      }
    }

    // AECI-200 / AECI-202 — auth-gate the review-submission form and the
    // `/account` page. Both routes are already non-cacheable (no
    // `ROUTE_CACHE_PATTERNS` match), so this gate runs on a request that would
    // otherwise SSR. A logged-out visitor (no session cookie) is 303-redirected
    // to `/auth/login?return=<path>` so they bounce straight back after signing
    // in; the `return` value is narrowed by `sanitizeReturnPath` (same-origin
    // only). The redirect is `no-store`. With a cookie present the request falls
    // through to the normal SSR render (the API verifies the token on writes).
    {
      const url = new URL(c.req.url);
      const { path } = stripLocalePrefix(url.pathname);
      if ((isReviewPath(path) || isAccountPath(path)) && !hasSessionCookie(c.req.raw)) {
        const returnPath = sanitizeReturnPath(url.pathname);
        const query = returnPath === '/' ? '' : `?return=${encodeURIComponent(returnPath)}`;
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/auth/login${query}`,
            'Cache-Control': 'private, no-store',
          },
        });
      }
    }

    // AECI-203 — anon gate for the admin surface. `/admin/*` is non-cacheable
    // (fail-closed classifier). A logged-out GET (no session cookie) is
    // 303-redirected to `/auth/login?return=<path>` — friendlier than a bare 404
    // for an admin whose session expired, and the same bounce as the review gate.
    // An AUTHENTICATED non-admin is NOT handled here: the request falls through to
    // SSR, the `/admin` resolver calls `GET /api/admin/summary`, and a 403 is
    // mapped to a 404 render (don't reveal the surface). GET-only so it can't
    // intercept the API Worker's earlier-registered `POST /admin/purge`.
    if (c.req.method === 'GET') {
      const url = new URL(c.req.url);
      const { path } = stripLocalePrefix(url.pathname);
      if (isAdminPath(path) && !hasSessionCookie(c.req.raw)) {
        const returnPath = sanitizeReturnPath(url.pathname);
        const query = returnPath === '/' ? '' : `?return=${encodeURIComponent(returnPath)}`;
        return new Response(null, {
          status: 303,
          headers: {
            Location: `/auth/login${query}`,
            'Cache-Control': 'private, no-store',
          },
        });
      }
    }

    return handleSsr(c.req.raw, c.env, renderer, c.executionCtx, transformResponse);
  });

  return app;
}
