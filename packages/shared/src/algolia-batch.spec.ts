import { describe, expect, it, vi } from 'vitest';

import { ALGOLIA_BATCH_MAX, callAlgoliaBatch, type AlgoliaBatchRequest } from './algolia-batch';

const CREDS = { appId: 'APP123', apiKey: 'write-key' };
const BATCH_URL = 'https://APP123.algolia.net/1/indexes/staging_products/batch';

const SAVE: AlgoliaBatchRequest = {
  action: 'updateObject',
  body: { objectID: 'rec-1', name: 'Procore' },
};
const DELETE: AlgoliaBatchRequest = { action: 'deleteObject', body: { objectID: 'rec-2' } };

function ok(taskID = 42): Response {
  return new Response(JSON.stringify({ taskID, objectIDs: ['rec-1'] }), { status: 200 });
}

describe('callAlgoliaBatch', () => {
  it('POSTs the index batch URL with the app-id/api-key headers and a requests body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());

    const outcome = await callAlgoliaBatch(
      fetchMock as unknown as typeof fetch,
      CREDS,
      'staging_products',
      [SAVE, DELETE],
    );

    expect(outcome).toEqual({ ok: true, status: 200, taskID: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(BATCH_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-algolia-application-id']).toBe('APP123');
    expect(headers['x-algolia-api-key']).toBe('write-key');
    expect(JSON.parse(init.body as string)).toEqual({ requests: [SAVE, DELETE] });
  });

  it('url-encodes the index name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await callAlgoliaBatch(fetchMock as unknown as typeof fetch, CREDS, 'staging_products_es', [
      SAVE,
    ]);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://APP123.algolia.net/1/indexes/staging_products_es/batch');
  });

  it('is a no-op (ok, no fetch) when there are no requests', async () => {
    const fetchMock = vi.fn();
    const outcome = await callAlgoliaBatch(fetchMock as unknown as typeof fetch, CREDS, 'i', []);
    expect(outcome).toEqual({ ok: true, status: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns algolia_credentials_missing without calling fetch when appId is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await callAlgoliaBatch(
      fetchMock as unknown as typeof fetch,
      { appId: undefined, apiKey: 'k' },
      'i',
      [SAVE],
    );
    expect(outcome).toEqual({ ok: false, status: 0, message: 'algolia_credentials_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns algolia_credentials_missing without calling fetch when apiKey is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await callAlgoliaBatch(
      fetchMock as unknown as typeof fetch,
      { appId: 'APP123', apiKey: undefined },
      'i',
      [SAVE],
    );
    expect(outcome).toEqual({ ok: false, status: 0, message: 'algolia_credentials_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the Algolia error message on a non-2xx response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'Invalid Application-ID' }), { status: 403 }),
      );
    const outcome = await callAlgoliaBatch(fetchMock as unknown as typeof fetch, CREDS, 'i', [
      SAVE,
    ]);
    expect(outcome).toEqual({ ok: false, status: 403, message: 'Invalid Application-ID' });
  });

  it('falls back to statusText when the error body is not JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503, statusText: 'Service Unavailable' }));
    const outcome = await callAlgoliaBatch(fetchMock as unknown as typeof fetch, CREDS, 'i', [
      SAVE,
    ]);
    expect(outcome).toEqual({ ok: false, status: 503, message: 'Service Unavailable' });
  });

  it('succeeds even when a 2xx body is not JSON (taskID undefined)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const outcome = await callAlgoliaBatch(fetchMock as unknown as typeof fetch, CREDS, 'i', [
      SAVE,
    ]);
    expect(outcome).toEqual({ ok: true, status: 200, taskID: undefined });
  });

  it('never throws on a network error — returns a structured outcome', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const outcome = await callAlgoliaBatch(fetchMock as unknown as typeof fetch, CREDS, 'i', [
      SAVE,
    ]);
    expect(outcome).toEqual({ ok: false, status: 0, message: 'network down' });
  });

  it('exposes a conservative per-call op ceiling', () => {
    expect(ALGOLIA_BATCH_MAX).toBe(500);
  });
});
