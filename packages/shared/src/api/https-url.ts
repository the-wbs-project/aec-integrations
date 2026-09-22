import { z } from 'zod';

/**
 * The shared "vendor-supplied web link" rule: an absolute `https:` URL with no
 * embedded credentials, at most 2,048 characters.
 *
 * Extracted from `LogoUrlSchema` (AECI-955) when AECI-1007 needed the same rule for
 * per-side integration links, so the two cannot drift. Never `http:`, never a
 * `data:` / `javascript:` URL, never a relative path: every value this admits is
 * rendered as an `href`, and a scheme allowlist is the cheapest place to keep a
 * script URL out of one.
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

export const HttpsUrlSchema = z
  .string()
  .trim()
  .max(HTTPS_URL_MAX_LENGTH)
  .url()
  .refine(isHttpsUrl, { message: 'Use an https:// link with no username or password.' });
