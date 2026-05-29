import { describe, expect, it, vi } from 'vitest';

import { ServerApiError, type ServerApiClient } from '../../../server-api-client';

import { fetchVendorBySlug } from './vendors';

function stubClient(impl: ServerApiClient['request']): ServerApiClient {
  return { request: vi.fn(impl) as ServerApiClient['request'] };
}

describe('fetchVendorBySlug', () => {
  it('returns the parsed VendorDetail for a 2xx response', async () => {
    const vendor = { id: 'v1', slug: 'procore', company_name: 'Procore Technologies' } as const;
    const client = stubClient(async () => vendor as unknown);

    const result = await fetchVendorBySlug(client, 'procore');

    expect(result).toEqual(vendor);
    expect(client.request).toHaveBeenCalledWith('/api/vendors/procore');
  });

  it('returns null when the API replies with a NOT_FOUND envelope', async () => {
    const client = stubClient(async () => {
      throw new ServerApiError({
        status: 404,
        code: 'NOT_FOUND',
        message: 'vendor not found: missing',
        traceId: 'trace-xyz',
      });
    });

    const result = await fetchVendorBySlug(client, 'missing');

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

    await expect(fetchVendorBySlug(client, 'procore')).rejects.toBe(err);
  });

  it('rethrows a 404 whose code is NOT NOT_FOUND (defensive — envelope contract)', async () => {
    const err = new ServerApiError({
      status: 404,
      code: 'UNKNOWN',
      message: 'something else',
    });
    const client = stubClient(async () => {
      throw err;
    });

    await expect(fetchVendorBySlug(client, 'procore')).rejects.toBe(err);
  });

  it('encodes the slug into the URL path', async () => {
    const client = stubClient(async () => ({}) as unknown);

    await fetchVendorBySlug(client, 'odd slug/with chars');

    expect(client.request).toHaveBeenCalledWith('/api/vendors/odd%20slug%2Fwith%20chars');
  });
});
