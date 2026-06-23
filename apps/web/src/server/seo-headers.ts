/**
 * SEO/security header set for cacheable SSR responses (AECI-89 /
 * `docs/CACHE_STRATEGY.md` §7, `docs/STAGE_1_PHASE_2_SPEC.md` §8.6).
 *
 * Every cacheable response (the only caller is `withCacheHeaders` in
 * `server-runtime.ts`, which already short-circuits non-cacheable statuses)
 * carries three additional headers on top of `Cache-Control` / `Cache-Tag`:
 *
 *   - `Vary: Accept-Language` — locale variance is already segmented at the
 *     URL-prefix layer, so this just advertises the dimension to well-behaved
 *     proxies without fragmenting Cloudflare's edge cache. Set via
 *     delete-then-set so any upstream `Vary: Cookie` / `Vary: User-Agent`
 *     (which DO fragment the cache, with no purge handle) is stripped first.
 *   - `Link: </sitemap.xml>; rel=sitemap` — sitemap discovery hint.
 *   - `Content-Security-Policy` — see `CONTENT_SECURITY_POLICY` below.
 */

/**
 * The app's Content-Security-Policy. Static (no per-request state) so it stays
 * byte-identical across every cache hit — nonces/hashes can't be used here
 * because the HTML is edge-cached and served verbatim to every visitor (a
 * cached nonce is reused by all, defeating the point), and Angular's
 * `withEventReplay()` injects a version-generated inline script that a hash
 * allowlist would have to chase across upgrades.
 *
 * `script-src 'unsafe-inline'` therefore covers the three trusted inline
 * scripts (the `index.html` theme bootstrap, the injected Datadog RUM
 * bootstrap, and Angular's event-replay script). It also allowlists
 * `https://static.cloudflareinsights.com`, the host of the Cloudflare Web
 * Analytics beacon (`beacon.min.js`) that Cloudflare auto-injects at the edge
 * for the zone; without it the injected `<script>` is CSP-refused. The
 * remaining directives do the real hardening (no plugins, no `<base>` hijack,
 * no off-site form posts, no framing).
 *
 * Origin notes:
 *   - `style-src` / `font-src` — Google Fonts stylesheet + woff2 (index.html).
 *     Angular SSR also inlines component `<style>` blocks → `'unsafe-inline'`.
 *   - `img-src 'self' data: https:` — vendor/Airtable `logo_url`s come from
 *     arbitrary https origins; `data:` for inline SVG/placeholders.
 *   - `connect-src` — `'self'` for the `/api/*` service-binding proxy plus the
 *     Datadog RUM intake host(s). The v7 browser SDK ships beacons to a
 *     per-`DD_SITE` host (a distinct registrable domain, NOT a `*.datadoghq.com`
 *     subdomain — the wildcard would not match it). Two are allowlisted: the
 *     US1 default `browser-intake-datadoghq.com` (the local `.dev.vars` default
 *     `DD_SITE=datadoghq.com`) and `browser-intake-us5-datadoghq.com` for the
 *     deployed preview/staging/production envs, which run `DD_SITE=us5.datadoghq.com`
 *     (see `wrangler.jsonc` env vars; the SDK maps `us5.datadoghq.com` →
 *     `browser-intake-us5-datadoghq.com`). AECI-162 caught the missing US5 host —
 *     RUM beacons were CSP-blocked in every deployed env. Other sites use yet
 *     another `browser-intake-*` host (e.g. `browser-intake-datadoghq.eu`), so
 *     add its intake host here if `DD_SITE` changes again. The Algolia search origins
 *     (`https://*.algolia.net https://*.algolianet.com`) were added in AECI-136
 *     (Phase 3.4) for InstantSearch: the browser client resolves its query host
 *     as `{appId}-dsn.algolia.net` with `{appId}-{1,2,3}.algolianet.com` retry
 *     fallbacks, so the two wildcards cover every search XHR. Then
 *     `https://cloudflareinsights.com` is the host the Cloudflare Web Analytics
 *     beacon POSTs its RUM payload to (`/cdn-cgi/rum`). Finally the two PostHog
 *     US-Cloud hosts (`https://us.i.posthog.com` ingestion + assets) were added
 *     in AECI-239 (Phase 7.4) for the client product-analytics layer: the
 *     browser PostHog client (`app/analytics/`) POSTs events to `us.i.posthog.com`
 *     and fetches remote config from the assets host. We init PostHog with
 *     `disable_external_dependency_loading: true`, so it never injects a remote
 *     `<script>` — `script-src` therefore stays untouched, these two
 *     `connect-src` XHR origins are all it needs. The region is PINNED to US:
 *     switching `POSTHOG_HOST` to EU requires swapping these for the `eu.`
 *     hosts here (the CSP is static and cannot read per-env config).
 */
const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://browser-intake-datadoghq.com https://browser-intake-us5-datadoghq.com https://*.algolia.net https://*.algolianet.com https://cloudflareinsights.com https://us.i.posthog.com https://us-assets.i.posthog.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

export const CONTENT_SECURITY_POLICY: string = CSP_DIRECTIVES.join('; ');

const SITEMAP_LINK = '</sitemap.xml>; rel=sitemap';

/**
 * Applies the SEO/security header set to a cacheable response's headers,
 * mutating the passed `Headers` in place.
 */
export function applySeoHeaders(headers: Headers): void {
  // Delete-then-set: strip any upstream `Vary` (`Cookie` / `User-Agent` would
  // fragment the edge cache with no purge handle) and advertise only the
  // URL-segmented locale dimension.
  headers.delete('Vary');
  headers.set('Vary', 'Accept-Language');
  // Append (not set) so any upstream preload `Link` survives.
  headers.append('Link', SITEMAP_LINK);
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
}
