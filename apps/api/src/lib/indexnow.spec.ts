/**
 * `callIndexNow` (AECI-236) — IndexNow submission transport. Mirrors
 * `cache-purge.spec.ts`: asserts the request shape and that an IndexNow failure
 * is tolerated (the §20.2 acceptance criterion — never throws).
 */

import { describe, expect, it, vi } from 'vitest';

import { callIndexNow, INDEXNOW_ENDPOINT, INDEXNOW_MAX_URLS } from './indexnow';

const SUBMISSION = {
  host: 'aecintegrations.com',
  key: 'a1b2c3d4e5f6a7b8',
  keyLocation: 'https://aecintegrations.com/a1b2c3d4e5f6a7b8.txt',
  urlList: ['https://aecintegrations.com/products/revit', 'https://aecintegrations.com/products'],
};

function ok(status = 200): Response {
  return new Response('', { status });
}

describe('callIndexNow', () => {
  it('POSTs the IndexNow endpoint with the host/key/keyLocation/urlList body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());

    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, SUBMISSION);

    expect(outcome).toEqual({ ok: true, status: 200 });
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
    expect(outcome).toEqual({ ok: true, status: 202 });
  });

  it('no-ops to a structured outcome (no fetch) when the key is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, {
      ...SUBMISSION,
      key: '',
    });
    expect(outcome).toEqual({ ok: false, status: 0, message: 'indexnow_config_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-ops to a structured outcome (no fetch) when the url list is empty', async () => {
    const fetchMock = vi.fn();
    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, {
      ...SUBMISSION,
      urlList: [],
    });
    expect(outcome).toEqual({ ok: false, status: 0, message: 'indexnow_no_urls' });
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
    expect(outcome).toEqual({ ok: false, status: 422, message: 'Unprocessable Entity' });
  });

  it('never throws on a network error — returns a structured outcome', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const outcome = await callIndexNow(fetchMock as unknown as typeof fetch, SUBMISSION);
    expect(outcome).toEqual({ ok: false, status: 0, message: 'network down' });
  });

  it('exposes the per-request URL ceiling', () => {
    expect(INDEXNOW_MAX_URLS).toBe(10_000);
  });
});
