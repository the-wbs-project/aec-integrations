/**
 * The three copy/seed targets, and how an env id maps to its bound D1 database,
 * canonical db-name, Algolia index env, and per-env credentials. Single source of
 * truth so every route resolves a `Target` the same way.
 */
import type { AlgoliaEnv } from '@aeci/shared/algolia';
import type { AlgoliaBatchCredentials } from '@aeci/shared/algolia-batch';
import type { CfPurgeCredentials } from '@aeci/shared/cache-purge';

import type { Env } from './env';

/** The selectable environments. LOCAL is intentionally absent — a deployed Worker
 * can't reach a developer's `.wrangler/state` SQLite (use the CLI for local). */
export const ENV_IDS = ['preview', 'staging', 'production'] as const;
export type EnvId = (typeof ENV_IDS)[number];

export function isEnvId(v: unknown): v is EnvId {
  return typeof v === 'string' && (ENV_IDS as readonly string[]).includes(v);
}

export interface Target {
  id: EnvId;
  /** The bound D1 database for this env. */
  db: D1Database;
  /** Canonical `aeci-app-<env>` name — the typed-confirmation value for writes. */
  dbName: string;
  /** Algolia env label (drives `indexNamesFor`). preview/staging/production map 1:1. */
  algoliaEnv: AlgoliaEnv;
  /** Algolia write credentials for this env's reindex (graceful-skip if absent). */
  algolia: AlgoliaBatchCredentials;
  /** Cloudflare cache-purge credentials for this env (graceful-skip if absent). */
  purge: CfPurgeCredentials;
}

export function dbNameFor(id: EnvId): string {
  return `aeci-app-${id}`;
}

/** Resolve a `Target` for an env id from the Worker bindings. */
export function targetFor(env: Env, id: EnvId): Target {
  switch (id) {
    case 'preview':
      return {
        id,
        db: env.DB_PREVIEW,
        dbName: dbNameFor(id),
        algoliaEnv: 'preview',
        algolia: { appId: env.ALGOLIA_APP_ID, apiKey: env.ALGOLIA_ADMIN_KEY_PREVIEW },
        purge: { apiToken: env.CF_PURGE_API_TOKEN_PREVIEW, zoneId: env.CF_ZONE_ID_PREVIEW },
      };
    case 'staging':
      return {
        id,
        db: env.DB_STAGING,
        dbName: dbNameFor(id),
        algoliaEnv: 'staging',
        algolia: { appId: env.ALGOLIA_APP_ID, apiKey: env.ALGOLIA_ADMIN_KEY_STAGING },
        purge: { apiToken: env.CF_PURGE_API_TOKEN_STAGING, zoneId: env.CF_ZONE_ID_STAGING },
      };
    case 'production':
      return {
        id,
        db: env.DB_PRODUCTION,
        dbName: dbNameFor(id),
        algoliaEnv: 'production',
        algolia: { appId: env.ALGOLIA_APP_ID, apiKey: env.ALGOLIA_ADMIN_KEY_PRODUCTION },
        purge: { apiToken: env.CF_PURGE_API_TOKEN_PRODUCTION, zoneId: env.CF_ZONE_ID_PRODUCTION },
      };
  }
}
