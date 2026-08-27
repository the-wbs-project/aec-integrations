/**
 * Release a `Response` body the caller will never read (AECI-666).
 *
 * Why this exists: a Worker invocation may hold only a bounded number of open
 * connections, and a `fetch()` whose body is never consumed keeps holding one.
 * When too many pile up, the runtime cancels the stalled responses to break the
 * deadlock ("A stalled HTTP response was canceled to prevent deadlock") — and a
 * cancelled `fetch` promise **never settles**. It neither resolves nor rejects,
 * so a `catch` around it never fires and the failure is completely silent. If
 * the invocation is still waiting on that promise when the event loop empties,
 * the runtime kills it outright ("your Worker's code had hung and would never
 * generate a response").
 *
 * That is exactly what happened to the promote post-commit hooks: every
 * transport below discarded its success-path body, so a bulk promote run parked
 * a dozen-plus connections per invocation, lost an unknown slice of its Algolia
 * upserts / cache purges / IndexNow pings with no log line, and killed ~8% of
 * invocations outright.
 *
 * The rule, from Cloudflare's own guidance: if you do not need the body, cancel
 * it. See https://developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections
 *
 * Call this on **every** response path that does not read the body — including
 * error paths that only look at `res.status`.
 */
export function discardResponseBody(res: Response): void {
  const body = res.body;
  // `body` is null for 204/304/HEAD; `locked` means a reader already owns the
  // stream (someone called `.json()`/`.text()`), and cancelling it would throw.
  if (!body || body.locked) return;
  void body.cancel().catch(() => {
    // Already errored or closed by the runtime — there is nothing left to
    // release, and an observability helper must never throw at its caller.
  });
}
