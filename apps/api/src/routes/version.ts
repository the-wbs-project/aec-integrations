import type { VersionResponse, Environment } from '@aeci/shared';
import type { Context } from 'hono';

import type { Env } from '../env';
import { json } from '../http';

/**
 * `GET /api/version` (AECI-74) — public-readable build metadata.
 *
 * AECI-71's `promote-to-prod` workflow calls this to verify staging is at the
 * commit being promoted. The endpoint is intentionally trivial: no DB, no
 * Datadog log (CI calls it on every promotion), `Cache-Control: private,
 * no-store` so a stale value never lies about what's deployed.
 *
 * `COMMIT_SHA` and `DEPLOYED_AT` are injected via `wrangler --var` at deploy
 * (and dev) time; both are optional in `Env` so a missing injection returns
 * sentinels rather than throwing.
 */
const EPOCH_SENTINEL = '1970-01-01T00:00:00.000Z';

function resolveEnvironment(env: Env['ENV']): Environment {
  return env ?? 'development';
}

export function createVersionHandler(): (c: Context<{ Bindings: Env }>) => Response {
  return (c) => {
    const body: VersionResponse = {
      sha: c.env.COMMIT_SHA ?? 'unknown',
      deployedAt: c.env.DEPLOYED_AT ?? EPOCH_SENTINEL,
      environment: resolveEnvironment(c.env.ENV),
    };
    return json(body);
  };
}
