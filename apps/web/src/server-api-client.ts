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
import { ApiErrorSchema, type ApiError } from "@aeci/shared";

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
    this.name = "ServerApiError";
    this.status = init.status;
    this.code = init.code;
    this.traceId = init.traceId ?? null;
    this.field = init.field;
    this.details = init.details;
  }
}

export interface ServerApiClient {
  request<TResponse>(path: string, init?: RequestInit): Promise<TResponse>;
}

export function createServerApiClient(env: { API: Fetcher }): ServerApiClient {
  return {
    async request<TResponse>(
      path: string,
      init?: RequestInit,
    ): Promise<TResponse> {
      if (!path.startsWith("/")) {
        throw new TypeError(
          `ServerApiClient.request: path must start with '/' (got '${path}')`,
        );
      }

      const request = new Request(`https://api${path}`, init);
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
      code: "UNKNOWN",
      message: bodyText.slice(0, 500) || response.statusText || "Unknown error",
    });
  }

  const envelope = ApiErrorSchema.safeParse(parsedJson);
  if (envelope.success) {
    const { error, trace_id } = envelope.data as ApiError;
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
    code: "UNKNOWN",
    message:
      typeof parsedJson === "object" && parsedJson !== null
        ? JSON.stringify(parsedJson).slice(0, 500)
        : String(parsedJson).slice(0, 500),
  });
}
