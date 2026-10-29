/**
 * SEO/security header set for SSR responses (AECI-89, AECI-1478 /
 * `docs/CACHE_STRATEGY.md` §7, `docs/STAGE_1_PHASE_2_SPEC.md` §8.6).
 *
 * Two layers:
 *
 *   - `applySecurityHeaders` sets the static security headers
 *     (`Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy`).
 *     It runs on every SSR render, cacheable or not, so a signed-in `/admin` or
 *     `/vendor` 200 carries the same policy as a public page (AECI-1478).
 *   - `applySeoHeaders` runs on cacheable responses only (the caller is
 *     `withCacheHeaders` in `server-runtime.ts`, which short-circuits
 *     non-cacheable statuses). It adds the security set plus two SEO headers on
 *     top of `Cache-Control` / `Cache-Tag`:
 *
 *   - `Vary: Accept-Language` — locale variance is already segmented at the
 *     URL-prefix layer, so this just advertises the dimension to well-behaved
 *     proxies without fragmenting Cloudflare's edge cache. Set via
 *     delete-then-set so any upstream `Vary: Cookie` / `Vary: User-Agent`
 *     (which DO fragment the cache, with no purge handle) is stripped first.
 *   - `Link: </sitemap.xml>; rel=sitemap` — sitemap discovery hint.
 *
 * Every security header is a static string, so it stays byte-identical across
 * cache hits and is safe on the edge-cached payload.
 */

/**
 * The app's Content-Security-Policy. Static (no per-request state) so it stays
 * byte-identical across every cache hit — nonces/hashes can't be used here
 * because the HTML is edge-cached and served verbatim to every visitor (a
 * cached nonce is reused by all, defeating the point), and Angular's
 * `withEventReplay()` injects a version-generated inline script that a hash
 * allowlist would have to chase across upgrades.
 *
 * `script-src 'unsafe-inline'` therefore covers the trusted inline scripts (the
 * `index.html` theme bootstrap, the injected Algolia / Supabase / PostHog
 * bootstraps, and Angular's event-replay script). It also allowlists
 * `https://static.cloudflareinsights.com`, the host of the Cloudflare Web
 * Analytics beacon (`beacon.min.js`) that Cloudflare auto-injects at the edge
 * for the zone; without it the injected `<script>` is CSP-refused. The
 * remaining directives do the real hardening (no plugins, no `<base>` hijack,
 * no off-site form posts, no framing).
 *
 * Origin notes:
 *   - `script-src` + `frame-src` — `https://challenges.cloudflare.com` hosts the
 *     Turnstile `api.js` loader and the challenge iframe it renders (AECI-1457).
 *     These are the only two directives Cloudflare's Turnstile CSP guidance
 *     lists, so `connect-src` gets no entry. `frame-src` keeps `'self'` so a
 *     same-origin frame stays allowed. The grant loads nothing by itself: the
 *     browser `TurnstileService` only injects the script when the env ships a
 *     `TURNSTILE_SITE_KEY` (dark by default).
 *   - `style-src` / `font-src` — Google Fonts stylesheet + woff2 (index.html).
 *     Angular SSR also inlines component `<style>` blocks → `'unsafe-inline'`.
 *   - `img-src 'self' data: https:` — vendor `logo_url`s from the review app come from
 *     arbitrary https origins; `data:` for inline SVG/placeholders.
 *   - `connect-src` — `'self'` for the `/api/*` service-binding proxy. (Two
 *     `browser-intake-*` Datadog RUM hosts lived here until AECI-651 removed the
 *     Datadog leg.) The Algolia search origins
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
 *     hosts here (the CSP is static and cannot read per-env config). Last, the
 *     Supabase project origin for browser auth (Phase 5, AECI-194): the
 *     `@supabase/ssr` `createBrowserClient` XHRs to `https://<ref>.supabase.co/auth/v1/*`
 *     for `getSession()`/token-refresh, magic-link OTP, and sign-out. Per
 *     ADR 0017 there is now ONE shared auth project across all environments, so
 *     a SINGLE ref — `ktuhnlypztujpsseujzx` — is allowlisted explicitly (not a
 *     `*.supabase.co` wildcard; see the `SUPABASE_URL` env vars in
 *     `apps/web/wrangler.jsonc`). If the auth
 *     project ref ever changes it must be updated here or every signed-in page
 *     CSP-refuses its session probe — the bug this fixed: the staging header's
 *     `SessionStatus`
 *     probe (`afterNextRender`, every page) hit `TypeError: Failed to fetch` in
 *     a refresh-retry loop because the origin was missing. Google OAuth's
 *     `signInWithOAuth` is a top-level navigation to `accounts.google.com`, not
 *     a `connect-src` fetch, so it needs no entry here.
 */
const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self' https://*.algolia.net https://*.algolianet.com https://cloudflareinsights.com https://us.i.posthog.com https://us-assets.i.posthog.com https://ktuhnlypztujpsseujzx.supabase.co",
  "frame-src 'self' https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

export const CONTENT_SECURITY_POLICY: string = CSP_DIRECTIVES.join('; ');

/**
 * States the browser default explicitly (AECI-1478). Cross-origin requests get
 * the origin only, so a path or query never leaks to a third party on an
 * outbound click. Same-origin requests keep the full URL.
 */
export const REFERRER_POLICY = 'strict-origin-when-cross-origin';

/**
 * Denies powerful browser features the app never uses (AECI-1478), so no
 * script allowlisted in the CSP can request them. `interest-cohort` (FLoC) is
 * left out on purpose: Chrome retired FLoC and reports the token as an
 * unrecognized feature in DevTools.
 */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()';

const SITEMAP_LINK = '</sitemap.xml>; rel=sitemap';

/**
 * Applies the static security headers, mutating the passed `Headers` in place.
 * Safe on every SSR response: none of them depends on the visitor.
 */
export function applySecurityHeaders(headers: Headers): void {
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  headers.set('Referrer-Policy', REFERRER_POLICY);
  headers.set('Permissions-Policy', PERMISSIONS_POLICY);
}

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
  applySecurityHeaders(headers);
}
