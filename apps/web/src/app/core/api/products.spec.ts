import { describe, expect, it, vi } from 'vitest';

import { ServerApiError, type ServerApiClient } from '../../../server-api-client';

import { fetchProductBySlug } from './products';

function stubClient(impl: ServerApiClient['request']): ServerApiClient {
  return { request: vi.fn(impl) as ServerApiClient['request'] };
}

describe('fetchProductBySlug', () => {
  it('returns the parsed ProductDetail for a 2xx response', async () => {
    const product = { id: 'p1', slug: 'procore', name: 'Procore' } as const;
    const client = stubClient(async () => product as unknown);

    const result = await fetchProductBySlug(client, 'procore');

    expect(result).toEqual(product);
    expect(client.request).toHaveBeenCalledWith('/api/products/procore');
  });

  it('returns null when the API replies with a NOT_FOUND envelope', async () => {
    const client = stubClient(async () => {
      throw new ServerApiError({
        status: 404,
        code: 'NOT_FOUND',
        message: 'product not found: missing',
        traceId: 'trace-xyz',
      });
    });

    const result = await fetchProductBySlug(client, 'missing');

    expect(result).toBeNull();
  });

  it('rethrows non-NOT_FOUND ServerApiError (e.g. 500)', async () => {
    const err = new ServerApiError({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'database unreachable',
    });
    const client = stubClient(async () => {
      throw err;
    });

    await expect(fetchProductBySlug(client, 'procore')).rejects.toBe(err);
  });

  it('rethrows a 404 whose code is NOT NOT_FOUND (defensive — envelope contract)', async () => {
    // If the API ever returns a 404 with a different code (e.g. METHOD_NOT_ALLOWED
    // mis-applied), surface the error rather than silently swallowing it as a
    // missing entity. The shape contract from `apps/api` is that NOT_FOUND is
    // the only 404 code we should see for this endpoint.
    const err = new ServerApiError({
      status: 404,
      code: 'UNKNOWN',
      message: 'something else',
    });
    const client = stubClient(async () => {
      throw err;
    });

    await expect(fetchProductBySlug(client, 'procore')).rejects.toBe(err);
  });

  it('encodes the slug into the URL path', async () => {
    // Defensive: slugs *should* be ASCII-safe (the slug generator at
    // AECI-47 enforces this), but a leaked stray character must not produce
    // a malformed path or accidental traversal.
    const client = stubClient(async () => ({}) as unknown);

    await fetchProductBySlug(client, 'odd slug/with chars');

    expect(client.request).toHaveBeenCalledWith('/api/products/odd%20slug%2Fwith%20chars');
  });
});
