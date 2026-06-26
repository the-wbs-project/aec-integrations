/**
 * The four copy/seed targets, and how an env id maps to its bound D1 database,
 * canonical db-name, Algolia index env, and per-env credentials. Single source of
 * truth so every route resolves a `Target` the same way.
 */
import type { AlgoliaEnv } from '@aeci/shared/algolia';
import type { AlgoliaBatchCredentials } from '@aeci/shared/algolia-batch';
import type { CfPurgeCredentials } from '@aeci/shared/cache-purge';

import type { Env } from './env';

/** The selectable environments. LOCAL is intentionally absent — a deployed Worker
 * can't reach a developer's `.wrangler/state` SQLite (use the CLI for local). */
export const ENV_IDS = ['preview', 'staging', 'demo', 'production'] as const;
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
  /** Algolia env label (drives `indexNamesFor`). preview/staging/demo/production map 1:1. */
  algoliaEnv: AlgoliaEnv;
  /** Algolia write credentials for this env's reindex (graceful-skip if absent). */
  algolia: AlgoliaBatchCredentials;
  /** Cloudflare cache-purge credentials for this env (graceful-skip if absent). */
  purge: CfPurgeCredentials;
}

export function dbNameFor(id: EnvId): string {
  return `aeci-app-${id}`;
}

/** The bound D1 + Algolia index prefix per env — the only things that actually
 * differ between tiers. (Credentials are shared; see `targetFor`.) */
const DB_AND_ALGOLIA_ENV: Record<EnvId, { db: (env: Env) => D1Database; algoliaEnv: AlgoliaEnv }> =
  {
    preview: { db: (e) => e.DB_PREVIEW, algoliaEnv: 'preview' },
    staging: { db: (e) => e.DB_STAGING, algoliaEnv: 'staging' },
    demo: { db: (e) => e.DB_DEMO, algoliaEnv: 'demo' },
    production: { db: (e) => e.DB_PRODUCTION, algoliaEnv: 'production' },
  };

/** Resolve a `Target` for an env id from the Worker bindings. The Algolia app/key
 * and the Cloudflare purge token/zone are SINGLE shared secrets — one Algolia app
 * (its admin key reaches every `{env}_*` index) and one `aecintegrations.com` zone
 * — so only the bound DB and the Algolia index prefix vary per env. */
export function targetFor(env: Env, id: EnvId): Target {
  const { db, algoliaEnv } = DB_AND_ALGOLIA_ENV[id];
  return {
    id,
    db: db(env),
    dbName: dbNameFor(id),
    algoliaEnv,
    algolia: { appId: env.ALGOLIA_APP_ID, apiKey: env.ALGOLIA_ADMIN_KEY },
    purge: { apiToken: env.CF_PURGE_API_TOKEN, zoneId: env.CF_ZONE_ID },
  };
}
