import { z } from 'zod';

import { HTTPS_URL_MAX_LENGTH, isHttpsUrl } from './https-url-rule';

/**
 * The Zod form of the shared web-link rule in `./https-url-rule`.
 *
 * The rule itself lives in a zod-free file (AECI-2033) so that public pages that
 * only call `isHttpsUrl` do not load zod. Import the rule from there, not from
 * here, and never re-export it from this file.
 */
export const HttpsUrlSchema = z
  .string()
  .trim()
  .max(HTTPS_URL_MAX_LENGTH)
  .url()
  .refine(isHttpsUrl, { message: 'Use an https:// link with no username or password.' });
