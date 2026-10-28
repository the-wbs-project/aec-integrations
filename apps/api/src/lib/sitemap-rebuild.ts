/**
 * The `sitemap-rebuild` cron job (AECI-1505, `docs/CACHE_STRATEGY.md` §5).
 *
 * `7-59/15 * * * *` enqueues a `sitemap_rebuild` message on `RECONCILE_QUEUE`; the
 * consumer runs {@link runSitemapRebuild} under `withJobRun`. A clean tick is two KV
 * reads and a `skipped` row. A dirty tick builds the catalog fragment in one D1
 * batch, stores it, then purges the `sitemap` edge tag ONCE, so every colo's next
 * miss reads the fresh copy. A throw propagates: `withJobRun` records `failed` and
 * the queue retries. Nothing is stored or purged on that path, so the old build
 * keeps serving.
 */
import type { CachePurgeMessage } from '@aeci/shared';

import type { Db } from '../db/client';
import type { Env } from '../env';
import type { JobRunReport } from './job-runs';
import { publicSiteBase } from './public-urls';
import { type CatalogSitemap, buildCatalogSitemap } from './sitemap-build';
import { SITEMAP_CACHE_TAG, sitemapNeedsRebuild, storeSitemap } from './sitemap-store';

/**
 * The origin every catalog `<loc>` is built on: the env's `PUBLIC_SITE_URL`. Local
 * dev sets none, so it falls back to the primary workspace's SSR port. The e2e
 * spec matches any origin, so an agent workspace on another port still passes.
 */
export function sitemapBase(env: Pick<Env, 'PUBLIC_SITE_URL'>): string {
  return publicSiteBase(env) ?? 'http://localhost:8788';
}

/** The liveness heartbeat, emitted on every run by the `scheduled.ts` shell.
 *  `observability/posthog/project-config.json` watches it. */
export const SITEMAP_REBUILD_RUN_METRIC = 'aeci.sitemap.rebuild.run';

export interface SitemapRebuildDeps {
  db: Db;
  now?: () => Date;
}

/** Builds against the env's base and stores the result. Returns the build. */
export async function buildAndStoreSitemap(
  env: Pick<Env, 'PUBLIC_SITE_URL' | 'TAXONOMY_KV'>,
  db: Db,
  startedAt: string,
): Promise<CatalogSitemap> {
  const built = await buildCatalogSitemap(db, sitemapBase(env));
  if (env.TAXONOMY_KV) await storeSitemap(env.TAXONOMY_KV, built, startedAt);
  return built;
}

export async function runSitemapRebuild(
  env: Pick<Env, 'PUBLIC_SITE_URL' | 'TAXONOMY_KV' | 'CACHE_PURGE_QUEUE'>,
  deps: SitemapRebuildDeps,
): Promise<JobRunReport> {
  const kv = env.TAXONOMY_KV;
  if (!kv) {
    return { outcome: 'skipped', detail: { job: 'sitemap-rebuild', reason: 'no_kv_binding' } };
  }
  if (!(await sitemapNeedsRebuild(kv))) {
    return { outcome: 'skipped', detail: { job: 'sitemap-rebuild', reason: 'not_dirty' } };
  }

  const now = deps.now ?? (() => new Date());
  const start = now();
  const builtAt = start.toISOString();
  const built = await buildAndStoreSitemap(env, deps.db, builtAt);

  // Purge only after the store: a miss between the two must read the new copy.
  // A failed send is not a failed run. The stored build is right, and the edge
  // copy ages out within its hour.
  const purge: CachePurgeMessage = { tags: [SITEMAP_CACHE_TAG], source: 'scheduled' };
  try {
    await env.CACHE_PURGE_QUEUE?.send(purge);
  } catch (error) {
    console.warn('[sitemap] edge purge enqueue failed', error);
  }

  return {
    outcome: 'ok',
    detail: {
      job: 'sitemap-rebuild',
      builtAt,
      urlCount: built.urlCount,
      bytes: new TextEncoder().encode(built.xml).byteLength,
      durationMs: now().getTime() - start.getTime(),
      base: built.base,
    },
  };
}
