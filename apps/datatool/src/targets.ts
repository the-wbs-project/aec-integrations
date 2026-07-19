/**
 * The four copy/seed targets, and how an env id maps to its bound D1 database,
 * canonical db-name, Algolia index env, and its cache-purge queue. Single source of
 * truth so every route resolves a `Target` the same way.
 */
import type { AlgoliaEnv } from '@aeci/shared/algolia';
import type { AlgoliaBatchCredentials } from '@aeci/shared/algolia-batch';
import type { CachePurgeMessage } from '@aeci/shared/cache-purge';

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
  /** This tier's `aeci-cache-purge-{env}` Queue producer, consumed by the tier's own
   *  SSR Worker (WC-5 / WC-7). `undefined` for `preview` (no queue → graceful no-op). */
  queue: Queue<CachePurgeMessage> | undefined;
}

export function dbNameFor(id: EnvId): string {
  return `aeci-app-${id}`;
}

/** The bound D1, Algolia index prefix, and cache-purge queue producer per env — the
 * only things that actually differ between tiers. (Algolia creds are shared; see
 * `targetFor`.) `preview` has no queue: it's `*.workers.dev` with no edge cache and
 * no `aeci-cache-purge-preview` queue, so its purge is a graceful no-op. */
const DB_AND_ALGOLIA_ENV: Record<
  EnvId,
  {
    db: (env: Env) => D1Database;
    algoliaEnv: AlgoliaEnv;
    queue: (env: Env) => Queue<CachePurgeMessage> | undefined;
  }
> = {
  preview: { db: (e) => e.DB_PREVIEW, algoliaEnv: 'preview', queue: () => undefined },
  staging: {
    db: (e) => e.DB_STAGING,
    algoliaEnv: 'staging',
    queue: (e) => e.CACHE_PURGE_QUEUE_STAGING,
  },
  demo: { db: (e) => e.DB_DEMO, algoliaEnv: 'demo', queue: (e) => e.CACHE_PURGE_QUEUE_DEMO },
  production: {
    db: (e) => e.DB_PRODUCTION,
    algoliaEnv: 'production',
    queue: (e) => e.CACHE_PURGE_QUEUE_PRODUCTION,
  },
};

/** Resolve a `Target` for an env id from the Worker bindings. The Algolia app/key is
 * a SINGLE shared secret — one app whose admin key reaches every `{env}_*` index —
 * so only the bound DB, the Algolia index prefix, and the per-tier cache-purge queue
 * vary per env. */
export function targetFor(env: Env, id: EnvId): Target {
  const { db, algoliaEnv, queue } = DB_AND_ALGOLIA_ENV[id];
  return {
    id,
    db: db(env),
    dbName: dbNameFor(id),
    algoliaEnv,
    algolia: { appId: env.ALGOLIA_APP_ID, apiKey: env.ALGOLIA_ADMIN_KEY },
    queue: queue(env),
  };
}
