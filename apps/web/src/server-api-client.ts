/**
 * Thin server-only client for the private API Worker.
 *
 * The SSR Worker reaches the API over a Cloudflare service binding (`env.API`,
 * declared in `wrangler.jsonc` env blocks). The binding is internal RPC —
 * there is no public URL — so the request URL's host is a placeholder that
 * Cloudflare ignores; we pass `https://api` for parity with the example in
 * `docs/STAGE_1_SPEC.md` §6.2 and `docs/API_CONTRACTS.md` §8.3.
 *
 * Phase 2 will replace the `unknown` return type with per-endpoint generics
 * keyed off the shared package. The current shape is deliberately minimal:
 * one `request<T>()` method, structured error mapping, no path registry.
 */
import type { ApiError } from '@aeci/shared';

export class ServerApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | null;
  readonly field?: string;
  readonly details?: unknown;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    traceId?: string | null;
    field?: string;
    details?: unknown;
  }) {
    super(init.message);
    this.name = 'ServerApiError';
    this.status = init.status;
    this.code = init.code;
    this.traceId = init.traceId ?? null;
    this.field = init.field;
    this.details = init.details;
  }
}

/**
 * Structural type guard for `ServerApiError`.
 *
 * `instanceof ServerApiError` is unsafe here because the SSR bundle and the
 * Angular bundle each get their own copy of this class — the Worker entry
 * (`server.ts`) constructs errors via the worker-bundle copy, but resolvers
 * importing `ServerApiError` from the Angular bundle compare against a
 * different class identity, so `instanceof` returns `false` and errors
 * propagate uncaught (see the AECI-57 404 regression where Angular SSR
 * returned `null` and the worker served the plain "Page not found." fallback).
 *
 * Name + structural property checks survive the bundle split because both
 * copies of the constructor set `this.name = 'ServerApiError'` and the
 * `status` / `code` fields.
 */
export function isServerApiError(err: unknown): err is ServerApiError {
  return (
    err instanceof Error &&
    err.name === 'ServerApiError' &&
    typeof (err as { status?: unknown }).status === 'number' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

export interface ServerApiClient {
  request<TResponse>(path: string, init?: RequestInit): Promise<TResponse>;
}

export interface ServerApiClientOptions {
  /**
   * Forward the inbound eyeball request's `Cookie` header onto every outbound
   * API call, so the API Worker's `requireAdmin()`/`requireAuth()` can read the
   * `sb-…-auth-token` session cookie (AECI-203 / Phase 5.12). ONLY the SSR
   * Worker's non-cacheable branch builds a client with this set — a cacheable
   * render must never forward visitor cookies into a response written to the
   * shared edge cache (cache-neutrality; `server-runtime.ts`). A caller-supplied
   * `Cookie` in `init.headers` wins (never clobbered).
   */
  forwardCookieFrom?: Request;
}

export function createServerApiClient(
  env: { API: Fetcher },
  options: ServerApiClientOptions = {},
): ServerApiClient {
  const inboundCookie = options.forwardCookieFrom?.headers.get('cookie') ?? null;

  return {
    async request<TResponse>(path: string, init?: RequestInit): Promise<TResponse> {
      if (!path.startsWith('/')) {
        throw new TypeError(`ServerApiClient.request: path must start with '/' (got '${path}')`);
      }

      const request = new Request(`https://api${path}`, init);
      // Merge the forwarded session cookie WITHOUT clobbering a caller-supplied
      // one (e.g. a handler that sets its own `Authorization`/`Cookie`).
      if (inboundCookie && !request.headers.has('cookie')) {
        request.headers.set('cookie', inboundCookie);
      }
      const response = await env.API.fetch(request);

      if (response.ok) {
        return (await response.json()) as TResponse;
      }

      throw await toServerApiError(response);
    },
  };
}

async function toServerApiError(response: Response): Promise<ServerApiError> {
  const bodyText = await response.text();

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(bodyText);
  } catch {
    return new ServerApiError({
      status: response.status,
      code: 'UNKNOWN',
      message: bodyText.slice(0, 500) || response.statusText || 'Unknown error',
    });
  }

  const envelope = parseApiErrorEnvelope(parsedJson);
  if (envelope) {
    const { error, trace_id } = envelope;
    return new ServerApiError({
      status: response.status,
      code: error.code,
      message: error.message,
      traceId: trace_id,
      field: error.field,
      details: error.details,
    });
  }

  return new ServerApiError({
    status: response.status,
    code: 'UNKNOWN',
    message:
      typeof parsedJson === 'object' && parsedJson !== null
        ? JSON.stringify(parsedJson).slice(0, 500)
        : String(parsedJson).slice(0, 500),
  });
}

/**
 * Structural read of the shared `ApiErrorSchema` envelope (api/common.ts):
 * `{ error: { code, message, field?, details? }, trace_id }`.
 *
 * Deliberately zod-free (AECI-221). This module's `isServerApiError` guard is
 * imported by the Angular browser resolvers (`core/api/fetch-or-null.ts`); when
 * the envelope read used `ApiErrorSchema.safeParse`, that one value import
 * dragged the whole `@aeci/shared` api barrel + the 327 kB `zod` chunk into the
 * browser's INITIAL graph — shipping ~54 kB of zod on every detail/browse page.
 * The canonical schema still lives in `@aeci/shared`; this is the SSR client's
 * defensive read of an already-received error response, where a lenient
 * structural check is equivalent (and never throws). `ApiError` is imported
 * type-only, so it erases.
 */
function parseApiErrorEnvelope(value: unknown): ApiError | null {
  if (typeof value !== 'object' || value === null) return null;
  const { error, trace_id } = value as { error?: unknown; trace_id?: unknown };
  if (typeof trace_id !== 'string') return null;
  if (typeof error !== 'object' || error === null) return null;
  const { code, message, field } = error as {
    code?: unknown;
    message?: unknown;
    field?: unknown;
  };
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  if (field !== undefined && typeof field !== 'string') return null;
  return value as ApiError;
}
