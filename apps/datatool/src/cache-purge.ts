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
 * Caveat: purge-by-tag is zone-scoped and tags are not hostname-namespaced, so if
 * two envs share a Cloudflare zone, purging one evicts the other's matching cached
 * pages too (a cache miss, not data loss). Configure CF_ZONE_ID per env.
 */
import {
  callCloudflarePurge,
  type CfPurgeCredentials,
  type CfPurgeOutcome,
} from '@aeci/shared/cache-purge';

/** Route-class tags covering every cacheable SSR surface. */
export const BROAD_CACHE_TAGS = [
  'route:detail',
  'route:index',
  'route:browse',
  'taxonomy',
] as const;

export async function purgeEnvCache(
  fetchImpl: typeof fetch,
  creds: CfPurgeCredentials,
): Promise<CfPurgeOutcome> {
  return callCloudflarePurge(fetchImpl, creds, [...BROAD_CACHE_TAGS]);
}
