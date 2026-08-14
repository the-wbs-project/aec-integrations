/**
 * Post-write edge-cache purge for a target env (sibling to the Algolia reindex).
 * A copy or seed changes catalog/ratings site-wide, so we evict every cacheable
 * SSR surface by its route-class tag (CACHE_STRATEGY.md §2): detail, index, and
 * browse pages, plus taxonomy-rendering pages. Four broad tags — well under
 * Cloudflare's 30-tag limit — and no per-entity enumeration needed.
 *
 * Reuses the shared `callCloudflarePurge` transport (the same one the SSR
 * `POST /admin/purge` and the promote hook use). Never throws; a missing token
 * returns `cf_credentials_missing` so the caller surfaces a graceful skip.
 *
 * Caveat: purge-by-tag is zone-scoped and tags are not hostname-namespaced, and
 * staging/demo/production all share the one `aecintegrations.com` zone (a single
 * shared CF_ZONE_ID — see env.ts). So a purge after a write to one tier also evicts
 * the others' matching cached pages — a cache miss, not data loss. (Preview is on
 * `*.workers.dev`, which has no purgeable customer zone, so its purge is a no-op.)
 */
import {
  callCloudflarePurge,
  type CfPurgeCredentials,
  type CfPurgeOutcome,
} from '@aeci/shared/cache-purge';

/**
 * Route-class tags covering every cacheable SSR surface, plus `sitemap`: a copy,
 * seed or prune changes which URLs exist, and the sitemap is tagged separately
 * from the route classes, so omitting it leaves the sitemap advertising pages
 * that now 404 (or missing ones that now resolve).
 */
export const BROAD_CACHE_TAGS = [
  'route:detail',
  'route:index',
  'route:browse',
  'taxonomy',
  'sitemap',
] as const;

export async function purgeEnvCache(
  fetchImpl: typeof fetch,
  creds: CfPurgeCredentials,
): Promise<CfPurgeOutcome> {
  return callCloudflarePurge(fetchImpl, creds, [...BROAD_CACHE_TAGS]);
}
