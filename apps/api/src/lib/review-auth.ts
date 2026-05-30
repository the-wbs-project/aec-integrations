/**
 * Machine-to-machine auth for the review-app push endpoint (`POST /api/promote`).
 *
 * A single long-lived bearer token, stored as the `REVIEW_APP_TOKEN` Wrangler
 * secret, gates the endpoint. This mirrors the planned `POST /admin/purge`
 * approach (CACHE_STRATEGY.md) and is the simplest correct M2M auth for a
 * trusted internal caller. When admin tooling expands (Phase 6) this can move
 * behind Cloudflare Access without changing the handler.
 *
 * The compare is constant-time so a timing side-channel can't be used to
 * recover the token byte-by-byte. A length mismatch returns early — that leaks
 * only the token's length, which is not sensitive for a high-entropy secret.
 */

import { ApiErrorCode } from '@aeci/shared';
import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import { ApiError } from '../errors';

/** Constant-time string equality over UTF-8 bytes. */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  if (ab.length !== bb.length) return false;
  let mismatch = 0;
  for (let i = 0; i < ab.length; i += 1) mismatch |= ab[i] ^ bb[i];
  return mismatch === 0;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/**
 * Hono middleware that requires a valid `Authorization: Bearer <REVIEW_APP_TOKEN>`
 * header. Throws `ApiError(401, UNAUTHENTICATED)` — the sub-router's
 * `errorHandler()` renders it as the canonical envelope. Registered before the
 * promote handler so an unauthenticated request never reaches the DB.
 */
export function requireReviewAppAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const expected = c.env.REVIEW_APP_TOKEN;
    const presented = extractBearer(c.req.header('Authorization'));

    if (!expected || !presented || !timingSafeEqual(presented, expected)) {
      throw new ApiError(
        401,
        ApiErrorCode.UNAUTHENTICATED,
        'Missing or invalid review-app credentials',
      );
    }

    await next();
  };
}
