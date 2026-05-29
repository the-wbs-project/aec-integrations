import { describe, expect, it, vi } from 'vitest';

import { ServerApiError, type ServerApiClient } from '../../../server-api-client';

import { fetchIntegrationById } from './integrations';

function stubClient(impl: ServerApiClient['request']): ServerApiClient {
  return { request: vi.fn(impl) as ServerApiClient['request'] };
}

describe('fetchIntegrationById', () => {
  it('returns the parsed IntegrationDetail for a 2xx response', async () => {
    const integration = { id: 'i1', name: 'Revit → Navisworks' } as const;
    const client = stubClient(async () => integration as unknown);

    const result = await fetchIntegrationById(client, 'i1');

    expect(result).toEqual(integration);
    expect(client.request).toHaveBeenCalledWith('/api/integrations/i1');
  });

  it('returns null when the API replies with a NOT_FOUND envelope', async () => {
    const client = stubClient(async () => {
      throw new ServerApiError({
        status: 404,
        code: 'NOT_FOUND',
        message: 'integration not found: missing',
        traceId: 'trace-xyz',
      });
    });

    const result = await fetchIntegrationById(client, 'missing');

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

    await expect(fetchIntegrationById(client, 'i1')).rejects.toBe(err);
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

    await expect(fetchIntegrationById(client, 'i1')).rejects.toBe(err);
  });

  it('encodes the id into the URL path', async () => {
    const client = stubClient(async () => ({}) as unknown);

    await fetchIntegrationById(client, 'odd id/with chars');

    expect(client.request).toHaveBeenCalledWith('/api/integrations/odd%20id%2Fwith%20chars');
  });
});
