/**
 * Phase 2.8 (AECI-54) error model. The canonical envelope is defined in
 * `docs/API_CONTRACTS.md` §3.3:
 *
 *   { error: { code, message, field?, details? }, trace_id: string }
 *
 * The SSR client (`apps/web/src/server-api-client.ts`) already parses against
 * `ApiErrorSchema` from `@aeci/shared`, so producing this exact shape on every
 * 4xx/5xx is the contract that lets `ServerApiError` carry structured info
 * back to SSR callers.
 *
 * Scope: `errorHandler()` is registered on both the root app (covering the
 * legacy `health` / `version` / `page-views` routes and the `*` catch-alls) and
 * the Phase 2.8 sub-router, so every 4xx/5xx across the API Worker emits the
 * canonical envelope (AECI-101). `page-views` and the catch-alls throw
 * `ApiError` / `ZodError`; `health` / `version` return responses directly and
 * don't throw today, so on them the root handler is future-proofing.
 */

import { ApiErrorCode } from '@aeci/shared';
import type { Context, ErrorHandler } from 'hono';
import { ZodError } from 'zod';

import { logToDatadog } from './datadog';
import type { Env } from './env';
import { json } from './http';

type ResourceKind =
  | 'product'
  | 'vendor'
  | 'integration'
  | 'category'
  | 'audience'
  | 'phase'
  | 'review';

export type ApiErrorOptions = {
  /** Set for `VALIDATION_FAILED` so the SSR client can target the field. */
  field?: string;
  /** Free-form structured context (e.g. `{ resource, slug }` for 404s). */
  details?: unknown;
};

/**
 * Typed error thrown from a handler that the middleware converts into the
 * `ApiErrorSchema` envelope. Mirrors the class shape documented in
 * `docs/API_CONTRACTS.md` §4.2.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly field?: string;
  readonly details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = options.field;
    this.details = options.details;
  }
}

/**
 * Convenience factory for typed 404s. The AECI-54 acceptance criteria call for
 * 404 responses to identify the missing resource and slug/id; the canonical
 * realisation is `{ error: { code: 'NOT_FOUND', message, details: { resource, slug | id } }, trace_id }`.
 * Tests assert `details.resource` and `details.slug` (or `details.id`) directly.
 */
export function notFoundError(
  resource: ResourceKind,
  identifier: { slug?: string; id?: string },
): ApiError {
  const label = identifier.slug ?? identifier.id ?? '(unknown)';
  return new ApiError(404, ApiErrorCode.NOT_FOUND, `${resource} not found: ${label}`, {
    details: { resource, ...identifier },
  });
}

/**
 * Extract the most useful field path from a `ZodError`. Returns `undefined` if
 * no issue has a path (top-level error) so the canonical envelope omits the
 * field entirely rather than emitting an empty string.
 */
function firstFieldFromZodError(error: ZodError): string | undefined {
  for (const issue of error.issues) {
    if (issue.path.length > 0) return issue.path.join('.');
  }
  return undefined;
}

/**
 * Hono `onError` handler producing the `ApiErrorSchema` envelope for any
 * error thrown inside a handler. Three branches:
 *
 *   1. `ApiError` → caller intended this; reuse status/code/field/details.
 *   2. `ZodError` → request validation failed; status 400, code
 *      `VALIDATION_FAILED`, field from the first issue path, details list the
 *      full issues array so the SSR client can render multi-field validation
 *      feedback later.
 *   3. Everything else → status 500, code `INTERNAL_ERROR`, log full stack to
 *      Datadog (best-effort; helper is a no-op without `DD_API_KEY`). The
 *      message returned to the caller is deliberately generic — never leak
 *      internal error strings to the wire.
 *
 * Hono catches errors thrown by handlers and routes them here (rather than
 * propagating back through middleware `try/catch`). Each sub-router that
 * wants the canonical envelope registers this via `app.onError(errorHandler())`.
 *
 * `trace_id` is `crypto.randomUUID()` for now. When Datadog APM lands, this
 * will be the active span ID so logs and the response are pivot-able together.
 *
 * Generic over the router's env so `Variables`-extended sub-routers (e.g. the
 * AECI-193 auth-spike router, whose middleware sets `c.get('user')`) can reuse
 * the same handler — the implementation only touches `Bindings`.
 */
export function errorHandler<E extends { Bindings: Env }>(): ErrorHandler<E> {
  return (error, c) => {
    const traceId = crypto.randomUUID();

    if (error instanceof ApiError) {
      return renderApiError(c, error, traceId);
    }

    if (error instanceof ZodError) {
      const field = firstFieldFromZodError(error);
      const validationError = new ApiError(
        400,
        ApiErrorCode.VALIDATION_FAILED,
        'Request failed validation',
        { field, details: { issues: error.issues } },
      );
      return renderApiError(c, validationError, traceId);
    }

    // Unknown error — log and surface a generic 500. We deliberately do not
    // include the original message in the response body.
    const unknownError: unknown = error;
    const message = unknownError instanceof Error ? unknownError.message : String(unknownError);
    console.error(`Unhandled error in ${c.req.path}:`, unknownError);
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'error',
      message: `Unhandled error: ${message}`,
      path: c.req.path,
      method: c.req.method,
      trace_id: traceId,
      stack: unknownError instanceof Error ? unknownError.stack : undefined,
    });

    const internalError = new ApiError(500, ApiErrorCode.INTERNAL_ERROR, 'Internal server error');
    return renderApiError(c, internalError, traceId);
  };
}

function renderApiError<E extends { Bindings: Env }>(
  c: Context<E>,
  error: ApiError,
  traceId: string,
): Response {
  const errorObject: Record<string, unknown> = {
    code: error.code,
    message: error.message,
  };
  if (error.field !== undefined) errorObject.field = error.field;
  if (error.details !== undefined) errorObject.details = error.details;

  return json({ error: errorObject, trace_id: traceId }, { status: error.status });
}
