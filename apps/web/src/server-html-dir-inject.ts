/**
 * Sets the `<html lang>` / `<html dir>` attributes on the SSR HTML response
 * from the request's locale prefix (AECI-153).
 *
 * Why a response rewrite and not a component host binding: `<html>` is emitted
 * verbatim from `apps/web/src/index.html` — Angular renders into `<app-root>`,
 * so no component can author the document element. The cache-safe injection
 * point is the `transformResponse` chain in `server.ts`, which runs inside
 * `handleSsr` BEFORE the response is returned (and stored by the native Workers
 * Cache). Unlike theme (per-visitor, cookie-stripped), `dir`/`lang` derive purely
 * from the URL's locale prefix, and the native cache key already segments by URL
 * (including that prefix) — so baking them into the cached HTML is cache-safe
 * (§9.1a / §7a.3a).
 *
 * Modeled on `injectDatadogBootstrap`, with three deliberate differences:
 *   - Gated on `content-type: text/html` ONLY, not on status — so Angular's
 *     full-document 404 also gets correct `lang`/`dir`. (The cheap-text 404
 *     emitted by the runtime has no `<html>` tag and is a safe no-op below.)
 *   - Replaces the WHOLE opening tag via `/<html\b[^>]*>/i`, rebuilding it as
 *     `<html lang dir>`. Overwriting (not appending) is corruption-proof
 *     regardless of any existing attribute order/quoting on the tag.
 *   - Skips the body read+rewrite entirely when the resolved attrs equal the
 *     static `index.html` default (`dir === 'ltr' && lang === DEFAULT_LOCALE`),
 *     so the shipping en-US path pays zero cost; only a non-default (e.g. RTL)
 *     locale triggers a body pass. Dormant today — en-US ships LTR-only.
 */

import { DEFAULT_LOCALE, LOCALES, localeAttrsForPath, type LocaleEntry } from './server-runtime';

const HTML_OPEN_TAG = /<html\b[^>]*>/i;

/**
 * Rewrites the opening `<html>` tag's `lang`/`dir` to match the request's
 * locale. Returns the original response untouched when:
 *
 *   - Response is not `text/html` (assets, JSON proxies, the cheap-text 404).
 *   - The resolved attrs are the static default (en-US LTR) — nothing to do.
 *   - The HTML has no `<html …>` opening tag (defensive; SSR output always has
 *     one, but the cheap-text 404 body does not).
 */
export async function injectHtmlLangDir(
  response: Response,
  request: Request,
  locales: readonly LocaleEntry[] = LOCALES,
): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) return response;

  const { pathname } = new URL(request.url);
  const { lang, dir } = localeAttrsForPath(pathname, locales);

  // Shipping en-US path: index.html already declares these attrs, so there is
  // nothing to rewrite. Skip the body read entirely to stay zero-cost.
  if (dir === 'ltr' && lang === DEFAULT_LOCALE) return response;

  const html = await response.clone().text();
  if (!HTML_OPEN_TAG.test(html)) return response;

  // Function replacement avoids `$`-pattern interpretation in the replacement
  // string; `lang`/`dir` come from the controlled LOCALES table regardless.
  const next = html.replace(HTML_OPEN_TAG, () => `<html lang="${lang}" dir="${dir}">`);
  const headers = new Headers(response.headers);
  // The body length changed — drop any cached content-length so the runtime
  // recomputes it instead of truncating/padding to the original size.
  headers.delete('content-length');
  return new Response(next, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
