/**
 * Canonical URL construction — the single source of truth for `<link rel="canonical">`
 * and `og:url` across the app (AECI-147 / ADR 0011).
 *
 * Canonicals are **self-referential**: each host canonicalises to itself (the serving
 * origin), rather than a hardcoded production apex. This is deliberate and multi-host:
 *
 *   - The web app serves `www.aecintegrations.com` + the apex (production, since the
 *     AECI-247/277 cutover) and `demo.aecintegrations.com` (demo). Self-referential
 *     follows the serving host, which is why the apex cutover needed no code change here.
 *   - The flip side, and the reason this is worth understanding before adding a hostname:
 *     a self-referential canonical means a second public host does not point at `www.` —
 *     it declares ITSELF canonical for every URL it serves. `prod.aecintegrations.com`
 *     did exactly that until AECI-807 retired it. Adding a route to an indexed env
 *     (`apps/web/wrangler.jsonc` `env.production`) is what creates that situation; there
 *     is no per-host opt-out here by design.
 *   - Non-prod hosts (PR previews `*.workers.dev`, `staging.`) sit behind Cloudflare Access
 *     (`docs/access.md`), so their self-canonicals never reach the public index.
 *   - The sitemap (`server/sitemap.ts`) and `robots.txt` already build against the serving
 *     origin, so sitemap `<loc>` ⇄ page canonical stay consistent.
 *
 * See `docs/adr/0011-canonical-uses-serving-origin.md` and Phase 2 Spec §9.1.
 */
import { DOCUMENT } from '@angular/common';
import { REQUEST, inject } from '@angular/core';

// The listing engine's own `?page=` clamp, imported rather than re-derived: the
// canonical and the fetched page must agree on what `?page=abc` means, and a second
// copy that agrees by coincidence is how they would drift. The module is pure (no
// `inject`, no `$localize`) and already in the eager route graph, so this costs
// nothing at the bundle level.
import { parseIndexPage } from '../shared/paginated-index/paginated-index-request';

/**
 * Fallback when neither the SSR request nor a browser location is available (e.g. a
 * build-time prerender with no request context). The canonical public home — `www.`
 * (ADR 0011 amendment 2026-07-05: the bare apex 301s to `www.` in the SSR Worker).
 */
const FALLBACK_ORIGIN = 'https://www.aecintegrations.com';

/**
 * The serving origin for the current render.
 *
 * - Server (`RenderMode.Server`): the inbound SSR `REQUEST` origin.
 * - Client (hydration / CSR navigation): `location.origin` — the same host the SSR request
 *   came from, so a canonical rebuilt on the client matches the one baked into the SSR HTML
 *   (no hydration drift).
 *
 * Must be called within an injection context.
 */
export function servingOrigin(): string {
  const request = inject(REQUEST, { optional: true });
  if (request) return new URL(request.url).origin;
  const origin = inject(DOCUMENT, { optional: true })?.defaultView?.location?.origin;
  return origin ?? FALLBACK_ORIGIN;
}

/**
 * Absolute, self-referential canonical URL for an app-relative path (leading slash optional).
 * Query params are not stripped here — `MetaService` strips them before writing the tag,
 * keeping only `CANONICAL_QUERY_ALLOWLIST` (`page`, for the paginated listings that go
 * through `listingCanonicalUrl` below). Must be called within an injection context.
 */
export function canonicalUrl(path: string): string {
  return `${servingOrigin()}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Canonical for a PAGINATED listing surface — `/products` and the four taxonomy
 * browse routes (AECI-803).
 *
 * Page 2 and beyond self-reference (`…/products?page=2`) instead of pointing back at
 * page 1, which is Google's documented guidance for a paginated series and which the
 * `<aec-pagination-footer>` `?page=N+1` anchor makes a real, crawlable trail. Page 1
 * is the bare path: `?page=1` and the absent param are the same document, so the
 * clamp collapses them (as it does `?page=0` and `?page=abc`) rather than minting a
 * second URL for one page of content.
 *
 * `page` is the ONLY param that survives; `MetaService.setEntityMeta` strips the rest
 * via `CANONICAL_QUERY_ALLOWLIST`. Sort and facet selections are deliberately not
 * canonical targets — their controls emit no `href`, so nothing crawls them. The
 * accepted consequence is that `?sort=name&page=2` canonicalises to `?page=2`, a
 * different set of products; that is no worse than the previous behaviour, which
 * pointed it at page 1 of the default sort.
 *
 * Cache-safe because `page` is in `LISTING_CACHE_KEY_PARAMS` (`server-runtime.ts`),
 * so `?page=2` has its own edge entry to bake this canonical into. Keep the two lists
 * in step. Must be called within an injection context.
 */
export function listingCanonicalUrl(path: string, pageParam: string | null): string {
  const page = parseIndexPage(pageParam);
  return canonicalUrl(page > 1 ? `${path}?page=${page}` : path);
}
