/**
 * Cross-Worker cache-purge queue contract (WC-5 / ADR 0020 §3).
 *
 * Single source of truth for the typed message that crosses the
 * `aeci-cache-purge-{env}` Cloudflare Queue. Native Workers Cache made the old
 * zone-level HTTP purge (`POST https://api.cloudflare.com/.../zones/{zone}/purge_cache`)
 * **inert against the SSR cache** — `ctx.cache.purge()` is entrypoint-scoped and "no
 * zone configuration for caching applies to Workers Caching". So a writer in the API
 * Worker can no longer invalidate SSR HTML cached in front of the SSR Worker by calling
 * Cloudflare directly. Instead, API-Worker producers (`POST /api/promote`, review
 * moderation) and the datatool enqueue a typed message onto `aeci-cache-purge-{env}`,
 * and a `queue()` consumer on the SSR Worker issues `ctx.cache.purge()` from its own
 * cache.
 *
 * The historical HTTP transport (`callCloudflarePurge` + `CF_PURGE_MAX_TAGS`) and its
 * `CF_PURGE_API_TOKEN` secret were retired in WC-10 (AECI-324) once every caller had
 * moved to native/queue purge. See `docs/adr/0020-workers-cache-and-queue-purge.md` §3
 * and `docs/CACHE_STRATEGY.md` §5.
 */

/** Which producer enqueued a purge — carried on the message so the SSR consumer can
 *  tag its `aeci.cache.purge{source:…}` metric (the metric moved off the producers to
 *  the consumer in WC-5). `manual` = SSR `/admin/purge` (WC-6), `datatool` = WC-7. */
export type CachePurgeSource = 'promote' | 'moderation' | 'manual' | 'datatool';

/**
 * The typed payload on the `aeci-cache-purge-{env}` Cloudflare Queue. Its purge
 * fields mirror Cloudflare's `CachePurgeOptions` (`ctx.cache.purge(options)`), so the
 * SSR consumer can forward them straight through. WC-5 producers only ever send
 * `{ tags, source }`; `pathPrefixes` / `purgeEverything` are ADR-0020 room for the
 * datatool broad purge (WC-7) and future callers.
 */
export type CachePurgeMessage = {
  tags?: string[];
  pathPrefixes?: string[];
  purgeEverything?: boolean;
  source: CachePurgeSource;
};

/**
 * Max `Cache-Tag`s a single Cloudflare Queue message can carry. The queue's limit is
 * 1000 tags per `ctx.cache.purge()` call, so queue producers do **not** batch — a
 * promote's tag set fits in one message. (The retired Pro-plan HTTP purge capped a call
 * at 30 tags, which forced batching; the queue path removed that constraint.)
 */
export const CACHE_PURGE_QUEUE_MAX_TAGS = 1000;
