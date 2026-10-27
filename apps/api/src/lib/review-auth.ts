/**
 * Machine-to-machine auth for the review-app push endpoint (`POST /api/promote`),
 * and since AECI-1476 for the IndexNow runner's internal routes.
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

import { ApiErrorCode, timingSafeEqual } from '@aeci/shared';
import type { MiddlewareHandler } from 'hono';

import type { Env } from '../env';
import { ApiError } from '../errors';

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

/**
 * Hono middleware that requires `Authorization: Bearer <secret>`, where the secret
 * is read from the env by `pick`. Throws `ApiError(401, UNAUTHENTICATED)` when the
 * secret is unset (fail-closed), the header is missing, or the compare fails — the
 * sub-router's `errorHandler()` renders it as the canonical envelope. Registered
 * before the handler so an unauthenticated request never reaches the DB.
 *
 * Shared by the review-app promote routes and, since AECI-1476, the IndexNow
 * runner's internal routes. One compare, one failure shape, two secrets.
 */
export function requireBearerSecret(
  pick: (env: Env) => string | undefined,
  message: string,
): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const expected = pick(c.env);
    const presented = extractBearer(c.req.header('Authorization'));

    if (!expected || !presented || !timingSafeEqual(presented, expected)) {
      throw new ApiError(401, ApiErrorCode.UNAUTHENTICATED, message);
    }

    await next();
  };
}

/** `Authorization: Bearer <REVIEW_APP_TOKEN>` for `POST /api/promote` and its siblings. */
export function requireReviewAppAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return requireBearerSecret(
    (env) => env.REVIEW_APP_TOKEN,
    'Missing or invalid review-app credentials',
  );
}

/** `Authorization: Bearer <INDEXNOW_RUNNER_TOKEN>` for the IndexNow runner's
 *  `/api/internal/indexnow/*` routes (AECI-1476). Unset on every tier but
 *  production, so those tiers answer 401 to every call. */
export function requireIndexNowRunnerAuth(): MiddlewareHandler<{ Bindings: Env }> {
  return requireBearerSecret(
    (env) => env.INDEXNOW_RUNNER_TOKEN,
    'Missing or invalid IndexNow runner credentials',
  );
}
