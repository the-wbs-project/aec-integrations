/**
 * SSR Worker Cloudflare Queue consumer — cross-Worker cache purge (WC-5 / AECI-319 /
 * ADR 0020 §3).
 *
 * Producers in the **API Worker** (`POST /api/promote`, review moderation) enqueue a
 * {@link CachePurgeMessage} onto `aeci-cache-purge-{env}` because their own zone-HTTP
 * purge is INERT against native Workers Cache (`ctx.cache.purge()` is entrypoint-scoped,
 * and the writer lives in a different Worker). This consumer runs on the SSR Worker and
 * issues `ctx.cache.purge()` against ITS OWN cache — the only entrypoint that can evict
 * the SSR HTML cached in front of it. It emits `aeci.cache.purge{source,outcome}` (the
 * metric moved here off the producers in WC-5) and retries on `!success`.
 *
 * **Failure / retry**: `ctx.cache.purge()` returns `{ success, errors }`. On `!success`
 * (or a thrown error) the message is `retry()`-ed — redelivered up to the queue's
 * `max_retries` (`apps/web/wrangler.jsonc`), then dropped. A successful purge (or an env
 * with no cache to purge) is `ack()`-ed so it never redelivers.
 *
 * **WC-4 follow-up (load-bearing)**: `ctx.cache.purge()` is entrypoint-scoped. Today the
 * SSR cache lives on the Worker's single **default** entrypoint (WC-3 enabled
 * `cache.enabled` at the env level), so purging from this default-export `queue()` handler
 * hits the right namespace. When WC-4 splits the Worker into a gateway + a named
 * `Renderer` `WorkerEntrypoint` (cache moves to `Renderer`), this purge MUST be relocated
 * into the `Renderer` entrypoint or it will silently no-op. See ADR 0020 §2.
 */

import type { CachePurgeMessage } from '@aeci/shared';

import type { WebEnv } from '../env';
import { logToDatadog, submitCount } from '../server-datadog';

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

  // No cache on this entrypoint/env — e.g. demo/production before WC-6/WC-8 flip
  // `cache.enabled` on (the queue + consumer are provisioned there ahead of the cache),
  // or a misconfig. There is nothing to purge, so ack; do not retry forever.
  if (!ctx.cache) {
    submitCount(ctx, env, request, 'aeci.cache.purge', 1, [sourceTag, 'outcome:no_cache']);
    message.ack();
    return;
  }

  try {
    const result = await ctx.cache.purge(options);
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
