/**
 * Per-user daily activity writer (AECI-1208, `DATABASE_SCHEMA.md` §9.11).
 *
 * Registered top-level in `index.ts` after `bookmarkMiddleware`, with the same
 * post-`next()` shape: it runs the handler, then reads `c.get('auth')`. Hono's
 * `route()` runs every sub-router on the same context, so the session a guard set
 * in `authVendor`, `authAdmin`, … is visible here. No guard file changes.
 *
 * It writes only when ALL of these hold:
 *
 *   - `auth` is set. Only `requireAuth()` / `requireAdmin()` / `requireVendor()`
 *     set it, and only on success, so a 401/403 never reaches the write.
 *     `requireUserAuth()` routes (`/api/auth/*`) set `user`, not `auth`, and write
 *     nothing: they read no profile and so have no role.
 *   - The response status is below 500.
 *   - The request is not `DELETE /api/account`. That handler erases the user; a
 *     write after it would bring their row back (`lib/user-activity.ts`).
 *   - The request is not `POST /api/activity/arrival`, which writes the row itself.
 *   - The per-isolate throttle allows it (5 minutes, or a new surface bit).
 *
 * The write runs in `waitUntil` and never throws. It counts
 * `aeci.user_activity.write{outcome: written|failed}` only when it actually
 * writes, so throttled requests emit nothing.
 */

import type { Context, MiddlewareHandler } from 'hono';

import { getDb } from './db/client';
import type { Env } from './env';
import type { AuthenticatedSession } from './lib/authz';
import type { DbFactory } from './lib/handler-utils';
import {
  ActivityThrottle,
  surfacesForRequest,
  upsertUserActivity,
  utcDay,
} from './lib/user-activity';
import { submitCount } from './posthog';

export const USER_ACTIVITY_WRITE_METRIC = 'aeci.user_activity.write';

/** The arrival beacon's path. It writes its own row, so the middleware skips it. */
export const ACTIVITY_ARRIVAL_PATH = '/api/activity/arrival';

/** The isolate-wide throttle the production middleware shares. */
const isolateThrottle = new ActivityThrottle();

export type ActivityMiddlewareDeps = {
  /** Test seam: the D1 client factory. */
  dbFor?: DbFactory;
  /** Test seam: the clock. */
  now?: () => Date;
  /** Test seam: a fresh throttle per test. */
  throttle?: ActivityThrottle;
};

/** Read the guard's session off a root-app context, whose type does not carry it. */
function sessionOf(c: Context<{ Bindings: Env }>): AuthenticatedSession | undefined {
  return (c as unknown as { get(key: 'auth'): AuthenticatedSession | undefined }).get('auth');
}

/** Whether this request must never write a row. */
function isExcluded(method: string, path: string): boolean {
  if (method === 'DELETE' && path === '/api/account') return true;
  if (path === ACTIVITY_ARRIVAL_PATH) return true;
  return false;
}

export function activityMiddleware(
  deps: ActivityMiddlewareDeps = {},
): MiddlewareHandler<{ Bindings: Env }> {
  const dbFor = deps.dbFor ?? getDb;
  const now = deps.now ?? (() => new Date());
  const throttle = deps.throttle ?? isolateThrottle;

  return async (c, next) => {
    try {
      await next();
    } finally {
      try {
        const session = sessionOf(c);
        const path = c.req.path;
        if (session && c.res.status < 500 && !isExcluded(c.req.method, path)) {
          const at = now();
          const surfaces = surfacesForRequest(path);
          const key = `${session.userId}|${utcDay(at)}`;
          if (throttle.shouldWrite(key, surfaces, at.getTime())) {
            const ctx = c.executionCtx;
            ctx.waitUntil(
              (async () => {
                let outcome: 'written' | 'failed' = 'written';
                try {
                  const { db } = dbFor(c.env, { constraint: 'first-primary' });
                  await upsertUserActivity(db, {
                    userId: session.userId,
                    role: session.role,
                    vendorId: session.vendorId,
                    at,
                    surfaces,
                  });
                } catch (error) {
                  outcome = 'failed';
                  console.warn('activityMiddleware: write failed', error);
                }
                try {
                  submitCount(ctx, c.env, c.req.raw, USER_ACTIVITY_WRITE_METRIC, 1, [
                    `outcome:${outcome}`,
                  ]);
                } catch {
                  // Telemetry never breaks anything.
                }
              })(),
            );
          }
        }
      } catch (error) {
        // The activity log MUST NOT break the request path, including a missing
        // ExecutionContext in a non-Worker test harness.
        console.warn('activityMiddleware: skipped', error);
      }
    }
  };
}
