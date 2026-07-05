/**
 * Canonical URL construction — the single source of truth for `<link rel="canonical">`
 * and `og:url` across the app (AECI-147 / ADR 0011).
 *
 * Canonicals are **self-referential**: each host canonicalises to itself (the serving
 * origin), rather than a hardcoded production apex. This is deliberate and multi-host:
 *
 *   - The web app currently serves `prod.aecintegrations.com` (production) and
 *     `demo.aecintegrations.com` (demo); the apex (`aecintegrations.com`) is served by the
 *     landing Worker. A hardcoded-apex canonical would point crawlers at a host the web app
 *     doesn't serve. Self-referential follows the serving host, so when the directory
 *     promotes to the apex/www at the apex cutover the canonicals are already correct — no
 *     code change at launch.
 *   - Non-prod hosts (PR previews `*.workers.dev`, `staging.`) sit behind Cloudflare Access
 *     (`docs/access.md`), so their self-canonicals never reach the public index.
 *   - The sitemap (`server/sitemap.ts`) and `robots.txt` already build against the serving
 *     origin, so sitemap `<loc>` ⇄ page canonical stay consistent.
 *
 * See `docs/adr/0011-canonical-uses-serving-origin.md` and Phase 2 Spec §9.1.
 */
import { DOCUMENT } from '@angular/common';
import { REQUEST, inject } from '@angular/core';

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
 * Query params are not stripped here — `MetaService` strips them before writing the tag.
 * Must be called within an injection context.
 */
export function canonicalUrl(path: string): string {
  return `${servingOrigin()}${path.startsWith('/') ? path : `/${path}`}`;
}
