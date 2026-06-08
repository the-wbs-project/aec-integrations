/**
 * Browser-side counterpart to `core/api/fetch-or-null.ts` (AECI-151).
 *
 * The detail / browse resolvers fetch entities through the Cloudflare service
 * binding (`ServerApiClient`) during SSR. On a genuine in-app client navigation
 * SSR never ran for that route, so the resolver's client branch fetches the
 * same endpoint from the browser via the SSR Worker's same-origin `/api/*`
 * passthrough — the sanctioned browser data path (ADR 0001 §Consequences; the
 * same proxy the index pages' `httpResource()` and `RequestsApi` already use).
 * GET reads only.
 *
 * Maps the canonical `NOT_FOUND` envelope (HTTP 404 with
 * `error.code === 'NOT_FOUND'`) to `null` so the resolver renders the inline
 * NotFound state without try/catch noise — mirroring `fetchOrNull`. Any other
 * error (including a 404 without the NOT_FOUND code) rethrows.
 */
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

/**
 * Whether an error response carries the canonical `{ error: { code:
 * 'NOT_FOUND' } }` envelope. `HttpClient` parses JSON error bodies into
 * `err.error`; we also tolerate an unparsed string body defensively.
 */
function isNotFoundEnvelope(err: HttpErrorResponse): boolean {
  const body: unknown = err.error;
  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  return (parsed as { error?: { code?: string } } | null)?.error?.code === 'NOT_FOUND';
}

export async function httpGetOrNull<T>(http: HttpClient, path: string): Promise<T | null> {
  try {
    return await firstValueFrom(http.get<T>(path));
  } catch (err) {
    if (err instanceof HttpErrorResponse && err.status === 404 && isNotFoundEnvelope(err)) {
      return null;
    }
    throw err;
  }
}
