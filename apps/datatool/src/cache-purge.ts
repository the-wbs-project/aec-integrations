/**
 * Post-write edge-cache purge for a target env (sibling to the Algolia reindex).
 * A copy is a full replace-mirror and a seed rewrites the whole review corpus, so
 * the destination's cached SSR HTML is stale site-wide — we evict it all.
 *
 * WC-7 (AECI-321): the datatool can't reach the SSR Worker's native Workers Cache
 * directly (it's a different Worker), and the old zone-level HTTP purge
 * (`callCloudflarePurge`) is inert against Workers Cache (ADR 0020 §1). So instead we
 * enqueue a `{ purgeEverything: true, source: 'datatool' }` message onto the target
 * tier's `aeci-cache-purge-{env}` Queue (WC-5); that tier's own SSR Worker consumes
 * it and calls `ctx.cache.purge({ purgeEverything: true })`. `purgeEverything` — not a
 * tag list — because a clone/seed invalidates everything and it avoids any tag-coverage
 * gap on native-cached responses.
 *
 * No cross-tier bleed: each env's SSR Worker has its own Workers Cache and its own
 * queue, so a purge after a write to one tier evicts ONLY that tier (the former
 * shared-`aecintegrations.com`-zone caveat is moot under per-Worker caches).
 *
 * Best-effort / graceful skip, unchanged: `preview` (and any unbound tier) has no
 * queue producer → returns `{ enqueued: false }` without sending; a `queue.send()`
 * failure is caught and returned, never thrown, so a purge hiccup never fails the
 * copy/seed itself.
 */
import type { CachePurgeMessage } from '@aeci/shared/cache-purge';

export type PurgeEnqueueOutcome = {
  ok: boolean;
  /** Whether a message was actually enqueued (false = graceful skip / send failed). */
  enqueued: boolean;
  message?: string;
};

export async function purgeEnvCache(
  queue: Queue<CachePurgeMessage> | undefined,
): Promise<PurgeEnqueueOutcome> {
  // No queue for this tier (preview / unbound) → graceful no-op.
  if (!queue) {
    return { ok: false, enqueued: false, message: 'cache_purge_queue_unconfigured' };
  }
  try {
    await queue.send({ purgeEverything: true, source: 'datatool' });
    return { ok: true, enqueued: true };
  } catch (error) {
    return {
      ok: false,
      enqueued: false,
      message: error instanceof Error ? error.message : 'cache_purge_enqueue_failed',
    };
  }
}
