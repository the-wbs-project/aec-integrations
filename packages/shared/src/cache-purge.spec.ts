import { describe, expect, it, vi } from 'vitest';

import { callCloudflarePurge, CF_PURGE_MAX_TAGS } from './cache-purge';

const CREDS = { apiToken: 'cf-token', zoneId: 'zone-1' };
const CF_URL = 'https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache';

function ok(): Response {
  return new Response(JSON.stringify({ success: true }), { status: 200 });
}

function cfError(status: number, message: string): Response {
  return new Response(JSON.stringify({ success: false, errors: [{ message }] }), { status });
}

describe('callCloudflarePurge', () => {
  it('POSTs the zone purge-by-tag URL with the token + tags body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());

    const outcome = await callCloudflarePurge(fetchMock as unknown as typeof fetch, CREDS, [
      'product:revit',
      'index:products',
    ]);

    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(CF_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cf-token');
    expect(JSON.parse(init.body as string)).toEqual({ tags: ['product:revit', 'index:products'] });
  });

  it('returns cf_credentials_missing without calling fetch when the token is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await callCloudflarePurge(
      fetchMock as unknown as typeof fetch,
      { apiToken: undefined, zoneId: 'zone-1' },
      ['product:revit'],
    );
    expect(outcome).toEqual({ ok: false, status: 0, message: 'cf_credentials_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns cf_credentials_missing without calling fetch when the zone is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await callCloudflarePurge(
      fetchMock as unknown as typeof fetch,
      { apiToken: 'cf-token', zoneId: undefined },
      ['product:revit'],
    );
    expect(outcome).toEqual({ ok: false, status: 0, message: 'cf_credentials_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the CF error message on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(cfError(429, 'too many requests'));
    const outcome = await callCloudflarePurge(fetchMock as unknown as typeof fetch, CREDS, ['t']);
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ status: 429 });
    expect((outcome as { message: string }).message).toContain('too many requests');
  });

  it('falls back to statusText when the error body is not JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503, statusText: 'Service Unavailable' }));
    const outcome = await callCloudflarePurge(fetchMock as unknown as typeof fetch, CREDS, ['t']);
    expect(outcome).toEqual({ ok: false, status: 503, message: 'Service Unavailable' });
  });

  it('never throws on a network error — returns a structured outcome', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const outcome = await callCloudflarePurge(fetchMock as unknown as typeof fetch, CREDS, ['t']);
    expect(outcome).toEqual({ ok: false, status: 0, message: 'network down' });
  });

  it('exposes the Pro-plan per-call tag ceiling', () => {
    expect(CF_PURGE_MAX_TAGS).toBe(30);
  });

  it('releases the response body on success (AECI-666)', async () => {
    const { res, drained } = trackedResponse(200);
    const fetchMock = vi.fn().mockResolvedValue(res);

    const outcome = await callCloudflarePurge(fetchMock as unknown as typeof fetch, CREDS, ['t']);

    expect(outcome).toEqual({ ok: true, status: 200 });
    await new Promise((r) => setTimeout(r, 0));
    expect(drained()).toBe(true);
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
