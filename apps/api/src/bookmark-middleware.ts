/**
 * API Worker outbound `x-d1-bookmark` middleware (AECI-250).
 *
 * Emits the D1 Sessions API bookmark on the response so a caller can resume the
 * logical session for read-your-writes on a subsequent request. Generic by
 * design: write handlers stash their `DbContext` via `writeDb(c, dbFor)`
 * (`c.set('dbCtx', …)`), and this middleware reads it back after the handler runs
 * and sets the header from `getBookmark()`. Read handlers never set `dbCtx` (and
 * `getBookmark()` returns `null` on the `'first-unconstrained'` / plain-binding
 * paths), so the header is simply omitted there — no behaviour change on reads.
 *
 * Registered top-level in `index.ts` right after `metricsMiddleware`, mirroring
 * its post-`next()` `finally` + try/catch shape. Like the rest of the
 * cross-cutting surface, it MUST NOT affect the request path: a failure here
 * (including a non-Worker test harness) can never surface to the client.
 */

import type { MiddlewareHandler } from 'hono';

import type { Env } from './env';

export function bookmarkMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    try {
      await next();
    } finally {
      try {
        const bookmark = c.get('dbCtx')?.getBookmark() ?? null;
        if (bookmark) c.res.headers.set('x-d1-bookmark', bookmark);
      } catch (error) {
        // Bookmark emission MUST NOT break the request path.
        console.warn('bookmarkMiddleware: emit failed', error);
      }
    }
  };
}
