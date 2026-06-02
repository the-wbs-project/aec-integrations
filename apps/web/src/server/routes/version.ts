/**
 * `GET /_version` (AECI-92) — the SSR Worker's OWN build metadata.
 *
 * Distinct from the proxied `/api/version`: the SSR Worker forwards `/api/*`
 * raw to the API Worker (`server-runtime.ts` `app.all('/api/*', …)`), so
 * `/api/version` only ever reports the *API* Worker's `COMMIT_SHA`. This route
 * is served by the SSR Worker itself and reports the SSR Worker's `COMMIT_SHA`,
 * letting CI verify the SSR bundle is current independently of the API deploy
 * (a stale SSR deploy with a current API would otherwise pass every gate).
 *
 * Same response shape and contract as `apps/api`'s `/api/version`
 * (`VersionResponse` in `@aeci/shared`): public-readable, `private, no-store`
 * so a stale value never lies about what's deployed, no `Cache-Tag` so it's
 * never pinned at the edge or caught in a purge set.
 *
 * `COMMIT_SHA` / `DEPLOYED_AT` are injected via `wrangler --var` at deploy (and
 * dev) time; both are optional in `WebEnv` so a missing injection returns
 * sentinels rather than throwing.
 */

import type { VersionResponse } from '@aeci/shared';
import type { Context } from 'hono';

import type { WebEnv } from '../../env';

const EPOCH_SENTINEL = '1970-01-01T00:00:00.000Z';

export function createVersionHandler(): (c: Context<{ Bindings: WebEnv }>) => Response {
  return (c) => {
    const body: VersionResponse = {
      sha: c.env.COMMIT_SHA ?? 'unknown',
      deployedAt: c.env.DEPLOYED_AT ?? EPOCH_SENTINEL,
      environment: c.env.ENV ?? 'development',
    };
    return new Response(JSON.stringify(body), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store',
      },
    });
  };
}
