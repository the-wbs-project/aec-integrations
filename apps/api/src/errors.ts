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

import { logToPosthog } from './posthog';
import type { Env } from './env';
import { json } from './http';

type ResourceKind =
  | 'product'
  | 'product_version'
  | 'vendor'
  | 'integration'
  // A data-flow claim and the attestation on it (AECI-301). `claim` is the
  // 404 the whole `/api/vendor/claims/*` surface answers with — including for a
  // claim on an integration the caller owns neither endpoint of, which must be
  // indistinguishable from a claim that does not exist.
  | 'claim'
  | 'attestation'
  | 'category'
  | 'audience'
  | 'phase'
  | 'trade'
  | 'review'
  | 'vendor_request'
  | 'profile';

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
 * Flatten an error's `cause` chain into a single readable string. D1/SQLite
 * (and `fetch`/other wrappers) attach the underlying failure as `err.cause`,
 * which `err.message` alone drops — so a `db.batch` rejection surfaces here as a
 * generic "D1_ERROR" with the actual reason (`SQLITE_CONSTRAINT`, a failing
 * statement, "too many SQL variables", …) one link down. Walks up to 4 links
 * defensively (cyclic/rogue `cause` chains can't hang the error path) and
 * returns `undefined` when there is no cause so callers can omit the field.
 */
function causeChain(error: unknown): string | undefined {
  const parts: string[] = [];
  let current: unknown = (error as { cause?: unknown } | null)?.cause;
  let depth = 0;
  while (current != null && depth < 4) {
    parts.push(current instanceof Error ? (current.stack ?? current.message) : String(current));
    current = (current as { cause?: unknown } | null)?.cause;
    depth += 1;
  }
  return parts.length ? parts.join('\n  caused by: ') : undefined;
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
 * Options for {@link errorHandler}.
 */
export type ErrorHandlerOptions = {
  /**
   * Log EVERY error — including the 4xx/409 *client* errors (validation,
   * malformed body, auth, slug conflict) — to Datadog, not just the unknown-500
   * branch. Off by default so the high-traffic public read endpoints don't emit
   * a log line per bot 404 or per validation 400.
   *
   * Set it for endpoints where Datadog must be the **authoritative, standalone
   * error record** — the review-app promote push (`POST /api/promote`,
   * `docs/REVIEW_APP_PROMOTE_API.md` §6): the operator needs to diagnose a
   * rejected promote from Datadog alone, without the HTTP response body. The log
   * carries the same `trace_id` returned in the envelope, so a caller-reported
   * `trace_id` pivots straight to the log line.
   */
  logClientErrors?: boolean;
  /**
   * `source` attribute stamped on every emitted log — the Datadog facet callers
   * filter on (e.g. `review-app-promote`). Threaded onto both the client-error
   * log (when `logClientErrors` is set) and the always-on unknown-500 log.
   */
  source?: string;
};

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
 *      the observability plane (best-effort; each vendor leg no-ops without
 *      its own key). The
 *      message returned to the caller is deliberately generic — never leak
 *      internal error strings to the wire.
 *
 * Branches 1 & 2 (the client 4xx/409 errors) are **silent** by default — only
 * branch 3's unknown-500 logs to Datadog — so the high-traffic public read
 * endpoints don't emit a log line per bot 404 / validation 400. Pass
 * `errorHandler({ logClientErrors: true, source })` and branches 1 & 2 log too
 * (via `logRequestError`), for an endpoint where Datadog must be the
 * authoritative, standalone error record (the review-app promote push — see
 * {@link ErrorHandlerOptions}).
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
export function errorHandler<E extends { Bindings: Env }>(
  options: ErrorHandlerOptions = {},
): ErrorHandler<E> {
  const { logClientErrors = false, source } = options;
  return (error, c) => {
    const traceId = crypto.randomUUID();

    if (error instanceof ApiError) {
      if (logClientErrors) logRequestError(c, error, traceId, source);
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
      if (logClientErrors) logRequestError(c, validationError, traceId, source);
      return renderApiError(c, validationError, traceId);
    }

    // Unknown error — log and surface a generic 500. We deliberately do not
    // include the original message in the response body.
    const unknownError: unknown = error;
    const message = unknownError instanceof Error ? unknownError.message : String(unknownError);
    // D1/SQLite bury the real reason (UNIQUE/FK/CHECK violation, "too many SQL
    // variables", a failing statement) in `err.cause`, which the bare `err.message`
    // omits — so a `db.batch` 500 logged with only message+stack is undiagnosable
    // (the promote `_sendOrThrow` case). Flatten the cause chain into both the CF
    // console line and the Datadog log so the actual failure is visible.
    const cause = causeChain(unknownError);
    console.error(`Unhandled error in ${c.req.path}:`, unknownError, cause ? { cause } : '');
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'error',
      message: `Unhandled error: ${message}`,
      ...(source ? { source } : {}),
      path: c.req.path,
      method: c.req.method,
      trace_id: traceId,
      stack: unknownError instanceof Error ? unknownError.stack : undefined,
      ...(cause ? { cause } : {}),
    });

    const internalError = new ApiError(500, ApiErrorCode.INTERNAL_ERROR, 'Internal server error');
    return renderApiError(c, internalError, traceId);
  };
}

/**
 * Emit a Datadog log for a handled `ApiError` (the 4xx/409 client errors, or an
 * ApiError-carried 5xx) so the failure — and its full structured detail — is
 * queryable in Datadog under the SAME `trace_id` the caller receives in the
 * response envelope. Level scales with status: 5xx → `error`, everything else →
 * `warn` (a client-fixable 4xx isn't a server fault, but must still be findable).
 * No-op without `DD_API_KEY` (the transport self-gates). Only reached when the
 * router opts in via `errorHandler({ logClientErrors: true })`.
 */
function logRequestError<E extends { Bindings: Env }>(
  c: Context<E>,
  error: ApiError,
  traceId: string,
  source: string | undefined,
): void {
  logToPosthog(c.executionCtx, c.env, c.req.raw, {
    level: error.status >= 500 ? 'error' : 'warn',
    message: `Request error ${error.status} ${error.code}: ${error.message}`,
    ...(source ? { source } : {}),
    code: error.code,
    // `http_status`, not `status`: the transport reserves the `status` key for the
    // Datadog log level (it becomes `warn`/`error`), so a numeric `status` here
    // would be silently overwritten before it reaches the intake.
    http_status: error.status,
    ...(error.field !== undefined ? { field: error.field } : {}),
    // The full detail the caller would otherwise only see in the response body —
    // e.g. the Zod `issues[]` for a VALIDATION_FAILED, or the slug-conflict target.
    ...(error.details !== undefined ? { details: error.details } : {}),
    path: c.req.path,
    method: c.req.method,
    trace_id: traceId,
  });
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
