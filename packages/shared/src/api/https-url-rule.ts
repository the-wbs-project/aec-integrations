/**
 * The shared "vendor-supplied web link" rule: an absolute `https:` URL with no
 * embedded credentials, at most 2,048 characters.
 *
 * Extracted from `LogoUrlSchema` (AECI-955) when AECI-1007 needed the same rule for
 * per-side integration links, so the two cannot drift. Never `http:`, never a
 * `data:` / `javascript:` URL, never a relative path: every value this admits is
 * rendered as an `href`, and a scheme allowlist is the cheapest place to keep a
 * script URL out of one.
 *
 * No Zod import (AECI-2033). Field captions on the public product and vendor
 * pages call `isHttpsUrl`, and when it lived beside `HttpsUrlSchema` that one
 * import loaded the whole of zod on those pages. Keep this file free of `zod`
 * and `api/*` schema imports (`eslint.config.mjs`). The Zod form is
 * `HttpsUrlSchema` in `./https-url`.
 */
export const HTTPS_URL_MAX_LENGTH = 2048;

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Any absolute `http:` or `https:` URL. The looser rule that contest proposals,
 * protest evidence links and the pair page's pricing link use. Moved here from
 * `integration-contests.ts` (AECI-2033) so this helper does not bring zod onto
 * the public pair page; its mailing-list form still loads zod.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
