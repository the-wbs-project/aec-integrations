/**
 * Unit coverage for `verifyTurnstile()` (AECI-1457).
 *
 * The contract under test: the call never throws, makes no fetch without a secret,
 * maps siteverify's answer onto pass / fail / unknown, and releases every response
 * body it does not read. Global `fetch` is stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SITEVERIFY_URL, mapSiteverify, verifyTurnstile } from './turnstile';

const ENV = { TURNSTILE_SECRET_KEY: 'test-secret' };
const RAY = '8c1a2b3c4d5e6f70-IAD';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.restoreAllMocks());

describe('verifyTurnstile', () => {
  it('returns null and makes no fetch when no secret is configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await verifyTurnstile({}, 'tok')).toBeNull();
    expect(await verifyTurnstile({ TURNSTILE_SECRET_KEY: '' }, 'tok')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs a url-encoded form with secret, response and remoteip, under a timeout', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ success: true }));
    await verifyTurnstile(ENV, 'tok', { remoteIp: '203.0.113.9' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(SITEVERIFY_URL);
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = init?.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(Object.fromEntries(body)).toEqual({
      secret: 'test-secret',
      response: 'tok',
      remoteip: '203.0.113.9',
    });
  });

  it('omits remoteip when none is known', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ success: true }));
    await verifyTurnstile(ENV, 'tok', { remoteIp: null });
    const body = fetchSpy.mock.calls[0]![1]?.body as URLSearchParams;
    expect(body.has('remoteip')).toBe(false);
  });

  it('pass: success true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ success: true }));
    expect(await verifyTurnstile(ENV, 'tok')).toBe('pass');
  });

  it('pass: success true with the expected cdata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ success: true, cdata: RAY }));
    expect(await verifyTurnstile(ENV, 'tok', { expectedCData: RAY })).toBe('pass');
  });

  it('fail: success true but cdata names a different ray', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ success: true, cdata: '0000000000000000-LHR' }),
    );
    expect(await verifyTurnstile(ENV, 'tok', { expectedCData: RAY })).toBe('fail');
  });

  it('unknown, never fail: success true but no cdata when one is expected', async () => {
    // Cloudflare's test secrets answer exactly this.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ success: true }));
    expect(await verifyTurnstile(ENV, 'tok', { expectedCData: RAY })).toBe('unknown');
  });

  it('unknown: success true with a null cdata when one is expected', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ success: true, cdata: null }));
    expect(await verifyTurnstile(ENV, 'tok', { expectedCData: RAY })).toBe('unknown');
  });

  it('fail: success true with an empty-string cdata that differs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ success: true, cdata: '' }));
    expect(await verifyTurnstile(ENV, 'tok', { expectedCData: RAY })).toBe('fail');
  });

  it('fail: success false with invalid-input-response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({ success: false, 'error-codes': ['invalid-input-response'] }),
    );
    expect(await verifyTurnstile(ENV, 'tok')).toBe('fail');
  });

  it.each([['timeout-or-duplicate'], ['internal-error'], ['invalid-input-secret']])(
    'unknown: success false with %s',
    async (code) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        json({ success: false, 'error-codes': [code] }),
      );
      expect(await verifyTurnstile(ENV, 'tok')).toBe('unknown');
    },
  );

  it('unknown: a timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );
    expect(await verifyTurnstile(ENV, 'tok')).toBe('unknown');
  });

  it('unknown: a network error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    expect(await verifyTurnstile(ENV, 'tok')).toBe('unknown');
  });

  it('unknown: a non-2xx, and the unread body is released', async () => {
    const res = new Response('upstream sad', { status: 503 });
    const cancel = vi.spyOn(res.body!, 'cancel');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    expect(await verifyTurnstile(ENV, 'tok')).toBe('unknown');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('unknown: a 2xx whose body is not JSON, and the body is consumed', async () => {
    const res = new Response('<html>nope</html>', { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);

    expect(await verifyTurnstile(ENV, 'tok')).toBe('unknown');
    expect(res.bodyUsed).toBe(true);
  });
});

describe('mapSiteverify', () => {
  it.each([
    [null, 'unknown'],
    [{}, 'unknown'],
    [{ success: 'true' }, 'unknown'],
    [{ success: false }, 'unknown'],
    [{ success: false, 'error-codes': 'invalid-input-response' }, 'unknown'],
  ] as const)('maps %j to %s', (data, verdict) => {
    expect(mapSiteverify(data)).toBe(verdict);
  });
});
