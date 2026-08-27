import { describe, expect, it } from 'vitest';

import { discardResponseBody } from './response-drain';

/**
 * A `Response` whose underlying stream reports whether it was cancelled — the
 * only observable the connection-release behaviour has.
 */
function trackedResponse(status = 200): { res: Response; wasCancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"ok":true}'));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(stream, { status }), wasCancelled: () => cancelled };
}

/** Settle the microtask queue so the async `cancel()` has run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('discardResponseBody', () => {
  it('cancels an unread body so the connection is released', async () => {
    const { res, wasCancelled } = trackedResponse();

    discardResponseBody(res);
    await flush();

    expect(wasCancelled()).toBe(true);
  });

  it('cancels non-2xx bodies too — an error path holds a connection just the same', async () => {
    const { res, wasCancelled } = trackedResponse(503);

    discardResponseBody(res);
    await flush();

    expect(wasCancelled()).toBe(true);
  });

  it('leaves a body alone once a reader owns it', async () => {
    const { res } = trackedResponse();
    const reader = res.body!.getReader();

    // The stream is locked; cancelling it here would throw a TypeError.
    expect(() => discardResponseBody(res)).not.toThrow();

    await reader.cancel();
  });

  it('no-ops on a bodyless response (204 / HEAD)', () => {
    expect(() => discardResponseBody(new Response(null, { status: 204 }))).not.toThrow();
  });

  it('never throws or rejects when cancel() itself fails', async () => {
    // The runtime can hand back a stream that is already errored — releasing it
    // must stay silent rather than surfacing an unhandled rejection.
    const res = {
      body: { locked: false, cancel: () => Promise.reject(new Error('already errored')) },
    } as unknown as Response;

    expect(() => discardResponseBody(res)).not.toThrow();
    await flush();
  });
});
