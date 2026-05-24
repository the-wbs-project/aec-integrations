import type { ApiError } from '@aeci/shared';

// Re-exported so Phase 2 endpoint handlers can pull the canonical envelope
// type from the same module they already import response helpers from. The
// centralized error middleware that produces values of this shape lands in
// Phase 2; until then http.ts continues returning the simpler placeholder
// shape below.
export type { ApiError };

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  // Default every API response to non-cacheable per CODE_REVIEW_CHECKLIST.md
  // (Caching). Cacheable endpoints opt in by passing Cache-Control in
  // init.headers — that path is preserved here.
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'private, no-store');
  }

  return new Response(
    JSON.stringify(data, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    {
      ...init,
      headers,
    },
  );
}

export function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

export function notFound(message = 'Route not found'): Response {
  return json({ error: message }, { status: 404 });
}
