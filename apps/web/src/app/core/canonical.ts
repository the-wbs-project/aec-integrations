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
