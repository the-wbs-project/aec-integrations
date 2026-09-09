/**
 * `callIndexNow` (AECI-236) — IndexNow submission transport. Mirrors
 * `cache-purge.spec.ts`: asserts the request shape and that an IndexNow failure
 * is tolerated (the §20.2 acceptance criterion — never throws).
 *
 * AECI-826 added the bounded retry. Every test here passes an injected `sleep`,
 * because the real backoff is 1 s + 4 s and a suite that actually waits it out
 * would blow the 5 s default timeout — which is exactly what happened when the
 * retry first landed. `sleeps` doubles as the assertion surface for the schedule.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  callIndexNow,
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_RETRIES,
  INDEXNOW_MAX_URLS,
  retryAfterMs,
} from './indexnow';

const SUBMISSION = {
  host: 'aecintegrations.com',
  key: 'a1b2c3d4e5f6a7b8',
  keyLocation: 'https://aecintegrations.com/a1b2c3d4e5f6a7b8.txt',
  urlList: ['https://aecintegrations.com/products/revit', 'https://aecintegrations.com/products'],
};

function ok(status = 200): Response {
  return new Response('', { status });
}

/** A submission with a recording, instant sleep. */
function withSleep(overrides: Partial<typeof SUBMISSION> = {}) {
  const sleeps: number[] = [];
  const submission = {
    ...SUBMISSION,
    ...overrides,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { submission, sleeps };
}

describe('callIndexNow', () => {
  it('POSTs the IndexNow endpoint with the host/key/keyLocation/urlList body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());

    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, SUBMISSION);

    expect(outcome).toEqual({ ok: true, status: 200, attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(INDEXNOW_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toContain('application/json');
    expect(JSON.parse(init.body as string)).toEqual({
      host: 'aecintegrations.com',
      key: 'a1b2c3d4e5f6a7b8',
      keyLocation: 'https://aecintegrations.com/a1b2c3d4e5f6a7b8.txt',
      urlList: SUBMISSION.urlList,
    });
  });

  it('treats 202 (received, pending validation) as success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok(202));
    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, SUBMISSION);
    expect(outcome).toEqual({ ok: true, status: 202, attempts: 1 });
  });

  it('no-ops to a structured outcome (no fetch) when the key is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, {
      ...SUBMISSION,
      key: '',
    });
    expect(outcome).toEqual({
      ok: false,
      status: 0,
      message: 'indexnow_config_missing',
      attempts: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops to a structured outcome (no fetch) when the url list is empty', async () => {
    const fetchMock = vi.fn();
    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, {
      ...SUBMISSION,
      urlList: [],
    });
    expect(outcome).toEqual({ ok: false, status: 0, message: 'indexnow_no_urls', attempts: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the status + body message on a non-2xx response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('Forbidden: key not valid', { status: 403 }));
    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, SUBMISSION);
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ status: 403 });
    expect((outcome as { message: string }).message).toContain('key not valid');
  });

  it('falls back to statusText when the error body is empty', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 422, statusText: 'Unprocessable Entity' }));
    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, SUBMISSION);
    expect(outcome).toEqual({
      ok: false,
      status: 422,
      message: 'Unprocessable Entity',
      attempts: 1,
    });
  });

  it('never throws on a network error — returns a structured outcome', async () => {
    const { submission, sleeps } = withSleep();
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, submission);
    expect(outcome).toEqual({ ok: false, status: 0, message: 'network down', attempts: 3 });
    expect(sleeps).toEqual([1_000, 4_000]);
  });

  it('exposes the per-request URL ceiling', () => {
    expect(INDEXNOW_MAX_URLS).toBe(10_000);
  });

  it('releases the response body on success (AECI-666)', async () => {
    const { res, drained } = trackedResponse(200);
    const fetchMock = vi.fn().mockResolvedValue(res);

    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, SUBMISSION);

    expect(outcome).toEqual({ ok: true, status: 200, attempts: 1 });
    await new Promise((r) => setTimeout(r, 0));
    expect(drained()).toBe(true);
  });
});

// ─── Retry (AECI-826) ────────────────────────────────────────────────────────
//
// The retry handles an ISOLATED throttle. It is explicitly NOT the fix for the
// burst that produced 23 consecutive 429s in production — that is the
// `indexnow_queue` buffer plus the twenty-minute drain cron. These tests pin the
// bound so a future change cannot quietly turn a retry into a second burst.

describe('callIndexNow retry', () => {
  it('retries a 429 and succeeds on the second attempt', async () => {
    const { submission, sleeps } = withSleep();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"errorCode":"TooManyRequests"}', { status: 429 }))
      .mockResolvedValueOnce(ok(200));

    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, submission);

    expect(outcome).toEqual({ ok: true, status: 200, attempts: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([1_000]);
  });

  it('gives up after INDEXNOW_MAX_RETRIES and returns the last failure', async () => {
    const { submission, sleeps } = withSleep();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"errorCode":"TooManyRequests"}', { status: 429 }));

    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, submission);

    expect(fetchMock).toHaveBeenCalledTimes(INDEXNOW_MAX_RETRIES + 1);
    expect(outcome).toMatchObject({ ok: false, status: 429, attempts: 3 });
    expect(sleeps).toHaveLength(INDEXNOW_MAX_RETRIES);
  });

  it('retries a 503 — an upstream blip is the same class of transient', async () => {
    const { submission } = withSleep();
    const fetchMock = vi.fn().mockResolvedValueOnce(ok(503)).mockResolvedValueOnce(ok(200));

    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, submission);

    expect(outcome).toEqual({ ok: true, status: 200, attempts: 2 });
  });

  it('does NOT retry a 403 — a bad key is not fixed by asking again', async () => {
    const { submission, sleeps } = withSleep();
    const fetchMock = vi.fn().mockResolvedValue(new Response('bad key', { status: 403 }));

    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, submission);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ status: 403, attempts: 1 });
    expect(sleeps).toEqual([]);
  });

  it('honours a Retry-After header over the default backoff', async () => {
    const { submission, sleeps } = withSleep();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
      )
      .mockResolvedValueOnce(ok(200));

    await callIndexNow(fetchMock as unknown as typeof fetch, submission);

    expect(sleeps).toEqual([3_000]);
  });

  it('drains every failed attempt (AECI-666) — a retry loop must not hold connections', async () => {
    // The failure path reads the body for its message, and reading IS releasing.
    // Asserted because a retry loop is precisely the shape that accumulates held
    // connections: three attempts that each leave a body unread is three
    // connections out of a budget of about six.
    const first = new Response('{"errorCode":"TooManyRequests"}', { status: 429 });
    const { submission } = withSleep();
    const fetchMock = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(ok(200));

    await callIndexNow(fetchMock as unknown as typeof fetch, submission);

    expect(first.bodyUsed).toBe(true);
  });
});

describe('retryAfterMs', () => {
  const now = Date.parse('2026-09-09T12:00:00.000Z');

  it('parses delta seconds', () => {
    expect(retryAfterMs('5', now)).toBe(5_000);
  });

  it('parses an HTTP date', () => {
    expect(retryAfterMs('Wed, 09 Sep 2026 12:00:04 GMT', now)).toBe(4_000);
  });

  it('ignores an absent or unparseable header', () => {
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs('  ', now)).toBeUndefined();
    expect(retryAfterMs('soon', now)).toBeUndefined();
  });

  it('ignores a window longer than the cap — the drain cron is the long backoff', () => {
    // Waiting out a minute inside the Worker burns the invocation for a
    // submission the next twenty-minute tick retries anyway.
    expect(retryAfterMs('60', now)).toBeUndefined();
  });

  it('ignores a past date', () => {
    expect(retryAfterMs('Wed, 09 Sep 2026 11:59:00 GMT', now)).toBeUndefined();
  });
});

/**
 * A `Response` whose stream reports cancellation. An unread body keeps holding
 * its connection open, and enough of those get the runtime to cancel the
 * response into a `fetch` promise that never settles (AECI-666).
 */
function trackedResponse(status: number): { res: Response; drained: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{}'));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(stream, { status }), drained: () => cancelled };
}
