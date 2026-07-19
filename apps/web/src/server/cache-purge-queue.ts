/**
 * SSR Worker Cloudflare Queue consumer — cross-Worker cache purge (WC-5 / AECI-319 /
 * ADR 0020 §3).
 *
 * Producers in the **API Worker** (`POST /api/promote`, review moderation) enqueue a
 * {@link CachePurgeMessage} onto `aeci-cache-purge-{env}` because their own zone-HTTP
 * purge is INERT against native Workers Cache (`ctx.cache.purge()` is entrypoint-scoped,
 * and the writer lives in a different Worker). This consumer runs on the SSR Worker's
 * **default export** (the queue routes there — wrangler `queues.consumers` has no
 * entrypoint field) and evicts the SSR HTML from the cached `Renderer` entrypoint. It
 * emits `aeci.cache.purge{source,outcome}` (the metric moved here off the producers in
 * WC-5) and retries on `!success`.
 *
 * **Purge from `Renderer` (WC-4 / ADR 0020 §2, load-bearing)**: `ctx.cache.purge()` is
 * entrypoint-scoped, and WC-4 moved `cache.enabled` onto the named `Renderer` entrypoint
 * (the default export is a cache-OFF gateway). So this handler does NOT call
 * `ctx.cache.purge()` on its own (gateway) ctx — that cache is disabled and the purge
 * would silently no-op. It delegates to `Renderer.purgeCache()` over the `ctx.exports`
 * loopback, which runs the purge in `Renderer`'s cache namespace and returns `null` on
 * an env with no cache (demo/production until WC-8).
 *
 * **Failure / retry**: `purgeCache()` returns `{ success, errors }` (or `null` for "no
 * cache on this env"). On `!success` (or a thrown error) the message is `retry()`-ed —
 * redelivered up to the queue's `max_retries` (`apps/web/wrangler.jsonc`), then dropped.
 * A successful purge (or an env with no cache to purge) is `ack()`-ed so it never
 * redelivers.
 */

import type { CachePurgeMessage } from '@aeci/shared';

import type { WebEnv } from '../env';
import { logToDatadog, submitCount } from '../server-datadog';

/**
 * The cached `Renderer` entrypoint reached over the `ctx.exports` loopback. WC-4 put
 * `cache.enabled` on `Renderer` (the default export is a cache-OFF gateway), so the
 * purge MUST originate there — `Renderer.purgeCache()` calls `ctx.cache.purge()` in the
 * right namespace and returns `null` when the env has no cache. Kept as a minimal local
 * shape (rather than importing the `Renderer` class from `server.ts`) to avoid an import
 * cycle. See ADR 0020 §2/§3.
 */
type CachePurgeLoopback = {
  Renderer: { purgeCache(options: CachePurgeOptions): Promise<CachePurgeResult | null> };
};

/** Queue handlers have no inbound `Request`, but `submitCount` derives its host tag
 *  from one. Synthesize a minimal request so the metric resolves a stable host — mirrors
 *  `cronRequest` in `apps/api/src/scheduled.ts`. */
function purgeMetricRequest(): Request {
  return new Request('https://aeci-web/queue/cache-purge');
}

/** Build the Cloudflare `CachePurgeOptions` from a message. WC-5 producers send `tags`;
 *  `pathPrefixes` / `purgeEverything` are ADR-0020 room for datatool (WC-7) / future
 *  callers. Returns `null` when the message carries no purge directive (defensive — a
 *  producer always sets `tags`). */
function purgeOptionsFromMessage(body: CachePurgeMessage): CachePurgeOptions | null {
  const options: CachePurgeOptions = {};
  if (body.tags?.length) options.tags = body.tags;
  if (body.pathPrefixes?.length) options.pathPrefixes = body.pathPrefixes;
  if (body.purgeEverything) options.purgeEverything = true;
  if (!options.tags && !options.pathPrefixes && !options.purgeEverything) return null;
  return options;
}

async function handleMessage(
  message: Message<CachePurgeMessage>,
  env: WebEnv,
  ctx: ExecutionContext,
): Promise<void> {
  const body = message.body;
  const sourceTag = `source:${body.source}`;
  const request = purgeMetricRequest();

  const options = purgeOptionsFromMessage(body);
  if (!options) {
    // Nothing to purge (malformed / empty message) — ack so it doesn't redeliver forever.
    submitCount(ctx, env, request, 'aeci.cache.purge', 1, [sourceTag, 'outcome:noop']);
    message.ack();
    return;
  }

  // Delegate into the cached `Renderer` entrypoint (WC-4): `ctx.cache.purge()` is
  // entrypoint-scoped and the cache lives on `Renderer`, not this default-export gateway
  // ctx. `purgeCache()` returns `null` when the env has no cache — e.g. demo/production
  // before WC-8 flips `cache.enabled` on (the queue + consumer are provisioned ahead of
  // the cache). Nothing to purge then, so ack; do not retry forever.
  const { Renderer } = ctx.exports as unknown as CachePurgeLoopback;
  try {
    const result = await Renderer.purgeCache(options);
    if (result === null) {
      submitCount(ctx, env, request, 'aeci.cache.purge', 1, [sourceTag, 'outcome:no_cache']);
      message.ack();
      return;
    }
    if (result.success) {
      submitCount(ctx, env, request, 'aeci.cache.purge', 1, [sourceTag, 'outcome:ok']);
      message.ack();
      return;
    }
    submitCount(ctx, env, request, 'aeci.cache.purge', 1, [sourceTag, 'outcome:purge_failed']);
    logToDatadog(ctx, env, request, {
      level: 'warn',
      message: 'aeci.cache.purge.failed',
      source: 'cache-purge-queue',
      purge_source: body.source,
      reason: result.errors.map((e) => `${e.code}: ${e.message}`).join('; ') || 'unknown',
      ...(body.tags?.length ? { tags: body.tags.join(',') } : {}),
    });
    message.retry();
  } catch (error) {
    submitCount(ctx, env, request, 'aeci.cache.purge', 1, [sourceTag, 'outcome:purge_failed']);
    logToDatadog(ctx, env, request, {
      level: 'error',
      message: 'aeci.cache.purge.crashed',
      source: 'cache-purge-queue',
      purge_source: body.source,
      reason: error instanceof Error ? error.message : String(error),
    });
    message.retry();
  }
}

/**
 * Factory for the SSR Worker's `queue()` handler. Registered on the default export in
 * `server.ts`; the consumer binding is wired per-env in `apps/web/wrangler.jsonc`
 * (staging / demo / production only — no queue on preview/local, a graceful no-op). Each
 * message is handled independently so one failure retries only that message (the
 * consumer runs with `max_batch_size: 1`).
 */
export function createCachePurgeQueueHandler(): ExportedHandlerQueueHandler<
  WebEnv,
  CachePurgeMessage
> {
  return async (batch, env, ctx) => {
    for (const message of batch.messages) {
      await handleMessage(message, env, ctx);
    }
  };
}
