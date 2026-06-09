import { describe, expect, it, vi } from 'vitest';

import { ServerApiError, type ServerApiClient } from '../../../server-api-client';

import { fetchTaxonomyList, fetchTaxonomyTermBySlug } from './taxonomy';
import type { TaxonomyKind } from '../../shared/taxonomy-badge/taxonomy-badge';

function stubClient(impl: ServerApiClient['request']): ServerApiClient {
  return { request: vi.fn(impl) as ServerApiClient['request'] };
}

describe('fetchTaxonomyTermBySlug', () => {
  it.each([
    ['category', '/api/categories/project-management'],
    ['audience', '/api/audiences/structural'],
    ['phase', '/api/phases/design-development'],
  ] as const)('hits the %s endpoint and returns the parsed detail', async (kind, expectedPath) => {
    const slug = expectedPath.split('/').pop()!;
    const term = { id: 't1', slug, name: slug, products: [] } as const;
    const client = stubClient(async () => term as unknown);

    const result = await fetchTaxonomyTermBySlug(client, kind, slug);

    expect(result).toEqual(term);
    expect(client.request).toHaveBeenCalledWith(expectedPath);
  });

  it('returns null when the API replies with a NOT_FOUND envelope', async () => {
    const client = stubClient(async () => {
      throw new ServerApiError({
        status: 404,
        code: 'NOT_FOUND',
        message: 'category not found: missing',
        traceId: 'trace-xyz',
      });
    });

    const result = await fetchTaxonomyTermBySlug(client, 'category', 'missing');

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

    await expect(fetchTaxonomyTermBySlug(client, 'audience', 'structural')).rejects.toBe(err);
  });

  it('rethrows a 404 whose code is NOT NOT_FOUND (defensive — envelope contract)', async () => {
    const err = new ServerApiError({ status: 404, code: 'UNKNOWN', message: 'something else' });
    const client = stubClient(async () => {
      throw err;
    });

    await expect(fetchTaxonomyTermBySlug(client, 'phase', 'design')).rejects.toBe(err);
  });

  it('encodes the slug into the URL path', async () => {
    const client = stubClient(async () => ({}) as unknown);

    await fetchTaxonomyTermBySlug(client, 'category', 'odd slug/with chars');

    expect(client.request).toHaveBeenCalledWith('/api/categories/odd%20slug%2Fwith%20chars');
  });
});

describe('fetchTaxonomyList', () => {
  it.each([
    ['category', '/api/categories'],
    ['audience', '/api/audiences'],
    ['phase', '/api/phases'],
  ] as const)(
    'requests %s list endpoint and returns the parsed list',
    async (kind, expectedPath) => {
      const list = { data: [{ id: 'c1', slug: 'pm', name: 'PM', product_count: 3 }] } as const;
      const client = stubClient(async () => list as unknown);

      const result = await fetchTaxonomyList(client, kind as TaxonomyKind);

      expect(result).toEqual(list);
      expect(client.request).toHaveBeenCalledWith(expectedPath);
    },
  );
});
