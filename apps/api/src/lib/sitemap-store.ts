/**
 * The `sitemap:*` key space in `TAXONOMY_KV` (AECI-1505, `docs/CACHE_STRATEGY.md` §5).
 *
 * | Key                | Value                                               | Writer |
 * |--------------------|-----------------------------------------------------|--------|
 * | `sitemap:dirty`    | ISO time of the newest write that changed a URL     | `markSitemapDirty` |
 * | `sitemap:built_at` | ISO time the stored build STARTED                   | the rebuild job, the inline build |
 * | `sitemap:xml`      | the catalog `<url>` fragment, metadata below        | the rebuild job, the inline build |
 *
 * A writer that used to purge the `sitemap` edge tag marks the key dirty instead.
 * The `sitemap-rebuild` cron (`7-59/15 * * * *`) rebuilds only when dirty is newer
 * than built_at, then purges the edge once. `built_at` is the START of the build:
 * a write that commits while a build runs then stays newer, and the next tick
 * rebuilds again rather than losing it.
 *
 * These keys are derived state. They carry no `audit_log` row (CLAUDE.md
 * §"Audit logging"). Every key has no TTL: a stored build is replaced, never
 * expired, so a sitemap never falls back to the slow path on its own.
 */
import type { Env } from '../env';

export const SITEMAP_DIRTY_KEY = 'sitemap:dirty';
export const SITEMAP_BUILT_AT_KEY = 'sitemap:built_at';
export const SITEMAP_XML_KEY = 'sitemap:xml';

/** Metadata stored with `sitemap:xml`. KV caps metadata at 1024 bytes. */
export interface SitemapXmlMetadata {
  base: string;
  builtAt: string;
  urlCount: number;
}

/** The tag a writer's purge set carries when it changed a sitemap URL. Senders
 *  strip it and call {@link markSitemapDirty} instead of purging it. */
export const SITEMAP_CACHE_TAG = 'sitemap';

/** How long a dirty mark waits before its one retry. KV accepts one write per key
 *  per second, so a retry sooner than that would hit the same 429. */
export const SITEMAP_DIRTY_RETRY_MS = 1_100;

/**
 * Records that a write changed a sitemap URL. Post-commit and best-effort: the
 * promise never rejects. No binding (a test harness) is a no-op.
 *
 * KV accepts one write per second per key, so a burst of writes 429s on all but
 * the first. A swallowed 429 is NOT harmless on its own: if a rebuild starts
 * between the first mark and this write's commit, `built_at` passes the first mark
 * and this write is never rebuilt. So a failed put retries ONCE, after
 * {@link SITEMAP_DIRTY_RETRY_MS}, with a fresh timestamp. A second failure warns and
 * is swallowed, and the daily backstop covers it.
 */
export async function markSitemapDirty(
  env: Pick<Env, 'TAXONOMY_KV'>,
  deps: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const kv = env.TAXONOMY_KV;
  if (!kv) return;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  try {
    await kv.put(SITEMAP_DIRTY_KEY, new Date().toISOString());
    return;
  } catch {
    // Fall through to the one retry.
  }
  await sleep(SITEMAP_DIRTY_RETRY_MS);
  try {
    await kv.put(SITEMAP_DIRTY_KEY, new Date().toISOString());
  } catch (err) {
    console.warn('[sitemap] could not mark dirty', err);
  }
}

/**
 * Splits a purge set into the tags to send and whether the sitemap is dirty.
 * The sitemap is no longer purged by writers (AECI-1505): the rebuild job purges
 * it once, after it has stored a build that includes the write.
 */
export function splitSitemapTag(tags: readonly string[]): { tags: string[]; dirty: boolean } {
  const rest = tags.filter((t) => t !== SITEMAP_CACHE_TAG);
  return { tags: rest, dirty: rest.length !== tags.length };
}

/** Whether the stored build is older than the newest write that asked for one. */
export async function sitemapNeedsRebuild(kv: KVNamespace): Promise<boolean> {
  const [dirty, builtAt] = await Promise.all([
    kv.get(SITEMAP_DIRTY_KEY),
    kv.get(SITEMAP_BUILT_AT_KEY),
  ]);
  if (!dirty) return false;
  if (!builtAt) return true;
  return dirty > builtAt;
}

/**
 * Stores a build. The fragment goes first, then `built_at`: if the second put
 * fails, the next tick sees the old stamp and rebuilds, which is the safe side.
 */
export async function storeSitemap(
  kv: KVNamespace,
  built: { xml: string; urlCount: number; base: string },
  startedAt: string,
): Promise<void> {
  const metadata: SitemapXmlMetadata = {
    base: built.base,
    builtAt: startedAt,
    urlCount: built.urlCount,
  };
  await kv.put(SITEMAP_XML_KEY, built.xml, { metadata });
  await kv.put(SITEMAP_BUILT_AT_KEY, startedAt);
}
