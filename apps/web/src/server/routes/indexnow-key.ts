/**
 * `GET /{INDEXNOW_KEY}.txt` — IndexNow key-verification file (AECI-236, §20.2).
 *
 * IndexNow requires the submitting host to publish a verification file named
 * `{key}.txt` at the site root whose body is exactly the key. Search engines
 * (Bing/Yandex/…) fetch it to confirm we own the host before honoring the
 * URL submissions the API Worker sends on promote (`apps/api` `notifyIndexNow`).
 *
 * Served as a dynamic route (not a static asset) because the key is a per-env
 * secret (`INDEXNOW_KEY`) — it must stay out of git and the build bundle, and be
 * provisionable / rotatable without a rebuild.
 *
 * Registered (in `server-runtime.ts`) as a single param route constrained to
 * root-level `*.txt`, AFTER the literal `/robots.txt` route and BEFORE the SSR
 * catch-all. Only the configured key file is served; every other `*.txt` (and a
 * wrong/unset/malformed key) falls through to the SSR catch-all via `next()`, so
 * those still render the branded 404 (§20.7). `/robots.txt` is a literal route
 * registered earlier, so this never intercepts it.
 *
 * No-op (404 fall-through) until `INDEXNOW_KEY` is provisioned — which happens
 * only at public launch, alongside the API Worker's `INDEXNOW_KEY`/`PUBLIC_SITE_URL`
 * and `ALLOW_INDEXING="true"`.
 */

import type { Context, Next } from 'hono';

import type { WebEnv } from '../../env';

/** IndexNow key rule: 8–128 of `[A-Za-z0-9-]`. A malformed env value is never
 *  echoed back as a verification file. */
const INDEXNOW_KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

export function createIndexNowKeyHandler(): (
  c: Context<{ Bindings: WebEnv }>,
  next: Next,
) => Promise<Response | void> {
  return async (c, next) => {
    const key = c.env.INDEXNOW_KEY;
    const file = c.req.param('file');
    if (key && INDEXNOW_KEY_PATTERN.test(key) && file === `${key}.txt`) {
      return new Response(key, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          // Long TTL — the key is stable; rotating it means a new file URL anyway.
          'Cache-Control': 'public, max-age=86400, s-maxage=86400',
        },
      });
    }
    // Not the configured key file → let the SSR catch-all render the branded 404.
    return next();
  };
}
