/**
 * API Worker request-timing middleware (AECI-66 / Phase 2.20).
 *
 * Emits `aeci.api.query.duration_ms` (an OTLP histogram → server-side
 * p50/p95/p99) on every request, tagged by `endpoint` and `status_class`.
 * Registered top-level in `index.ts` so it wraps the legacy routes, the
 * Phase 2.8 sub-router, and the `*` fall-through alike.
 *
 *   - `endpoint` is the matched route *pattern* (`c.req.routePath`, e.g.
 *     `/api/products/:slug`), NOT the concrete path — keeping tag cardinality
 *     bounded. Unmatched requests fall to `*`.
 *   - `status_class` (`2xx`/`4xx`/`5xx`) powers the error-rate widget and the
 *     error-rate alert. The Phase 2.8 sub-router's `onError` converts thrown
 *     `ApiError`/`ZodError` into a response before control returns here, so
 *     `await next()` resolves and the `finally` always runs.
 *
 * **The raw `status` tag was dropped (AECI-642 / POSTHOG_MIGRATION_SPEC.md
 * §3.5).** It multiplied this metric's series count by every distinct status
 * code observed per endpoint, against a PostHog guardrail of 1,000 metric
 * series per window — and series identity includes the resource attributes, so
 * `version` already doubles every dimension while two deploy versions are live.
 * The information is not lost: the exact status code lives on the error log for
 * the same request, which is where a drill-down belongs. A per-code split of a
 * duration histogram was never a real query. **No new tag goes on this metric
 * without redoing the §AW4 cardinality arithmetic.**
 *
 * Like the rest of the telemetry surface, this MUST NOT affect the response:
 * submission is fire-and-forget (`submitDistribution` → `ctx.waitUntil`), each
 * vendor leg no-ops without its own config, and the emit is wrapped so a failure
 * here can never surface to the client.
 */

import type { MiddlewareHandler } from 'hono';

import type { Env } from './env';
import { submitDistribution } from './posthog';

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
          [`endpoint:${endpoint}`, `status_class:${Math.floor(status / 100)}xx`],
        );
      } catch (error) {
        // Observability MUST NOT break the request path — including a missing
        // ExecutionContext in non-Worker test harnesses.
        console.warn('metricsMiddleware: emit failed', error);
      }
    }
  };
}
