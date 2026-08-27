/**
 * Bounded fan-out for outbound calls from a single Worker invocation (AECI-666).
 *
 * A Worker invocation may hold only {@link WORKER_CONNECTION_LIMIT} connections
 * waiting for response headers. Exceeding that is not itself fatal — the runtime
 * queues the excess — but it becomes fatal in combination with a response whose
 * body is never released: the runtime then cancels stalled responses to break the
 * deadlock, and a cancelled `fetch` returns a promise that **never settles**. The
 * work vanishes with no error, and the invocation is eventually killed as hung.
 *
 * So the two rules are a pair, and this module is half of it:
 *   1. Release bodies you do not read — {@link discardResponseBody}.
 *   2. Do not open an unbounded number of connections at once — this.
 *
 * Reach for this whenever the request count scales with the payload (one call per
 * URL, per user id, per row) *and* the upstream has no batch endpoint. When the
 * upstream **does** take a batch — Datadog's logs intake, Algolia's `batch`,
 * Cloudflare's `purge_cache` — send one request instead; batching beats bounding.
 *
 * @see https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
 */

/**
 * Connections a Worker invocation may have simultaneously waiting for response
 * headers. Cloudflare-defined, not a tuning knob — `fetch`, KV, R2, Cache API,
 * Queues `send()`, and outbound WebSockets all count against it.
 */
export const WORKER_CONNECTION_LIMIT = 6;

/**
 * Map `items` through `fn` in waves of at most `limit` concurrent calls.
 *
 * Never rejects: results come back as `PromiseSettledResult`s in input order, so
 * a caller tallying success/failure keeps the never-throw semantics every one of
 * our post-commit transports depends on.
 *
 * Waves, not a rolling pool: a pool would keep the pipe marginally fuller, but at
 * these sizes (tens of items, not thousands) the difference is noise and the wave
 * boundary is far easier to reason about when reading a stack trace.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const width = Math.max(1, Math.floor(limit));
  const out: PromiseSettledResult<R>[] = [];
  for (let start = 0; start < items.length; start += width) {
    const wave = items.slice(start, start + width);
    out.push(...(await Promise.allSettled(wave.map((item, i) => fn(item, start + i)))));
  }
  return out;
}
