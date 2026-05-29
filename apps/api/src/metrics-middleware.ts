/**
 * API Worker request-timing middleware (AECI-66 / Phase 2.20).
 *
 * Emits `aeci.api.query.duration_ms` (a Datadog distribution → server-side
 * p50/p95/p99) on every request, tagged by `endpoint` and `status`. Registered
 * top-level in `index.ts` so it wraps the legacy routes, the Phase 2.8
 * sub-router, and the `*` fall-through alike.
 *
 *   - `endpoint` is the matched route *pattern* (`c.req.routePath`, e.g.
 *     `/api/products/:slug`), NOT the concrete path — keeping tag cardinality
 *     bounded. Unmatched requests fall to `*`.
 *   - `status` is the final response status, so the dashboard's 4xx/5xx
 *     error-rate widget and the error-rate monitor can split on it. The
 *     Phase 2.8 sub-router's `onError` converts thrown `ApiError`/`ZodError`
 *     into a response before control returns here, so `await next()` resolves
 *     and the `finally` always runs.
 *
 * Like the rest of the Datadog surface, this MUST NOT affect the response:
 * submission is fire-and-forget (`submitDistribution` → `ctx.waitUntil`), no-ops
 * without `DD_API_KEY`, and the emit is wrapped so a failure here can never
 * surface to the client.
 */

import type { MiddlewareHandler } from 'hono';

import { submitDistribution } from './datadog';
import type { Env } from './env';

export function metricsMiddleware(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const start = Date.now();
    try {
      await next();
    } finally {
      try {
        const endpoint = c.req.routePath || c.req.path;
        const status = c.res.status;
        submitDistribution(
          c.executionCtx,
          c.env,
          c.req.raw,
          'aeci.api.query.duration_ms',
          Date.now() - start,
          // `status_class` (2xx/4xx/5xx) powers the combined error-rate widget +
          // monitor; `status` is kept for per-code drill-down.
          [
            `endpoint:${endpoint}`,
            `status:${status}`,
            `status_class:${Math.floor(status / 100)}xx`,
          ],
        );
      } catch (error) {
        // Observability MUST NOT break the request path — including a missing
        // ExecutionContext in non-Worker test harnesses.
        console.warn('metricsMiddleware: emit failed', error);
      }
    }
  };
}
