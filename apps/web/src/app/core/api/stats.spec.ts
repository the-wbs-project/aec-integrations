import { describe, expect, it, vi } from 'vitest';

import type { HomeStatsResponse } from '@aeci/shared';

import { type ServerApiClient } from '../../../server-api-client';

import { fetchHomeStats } from './stats';

function stubClient(impl: ServerApiClient['request']): ServerApiClient {
  return { request: vi.fn(impl) as ServerApiClient['request'] };
}

const SPARSE_STATS: HomeStatsResponse = {
  total_integrations: 0,
  integrations_added_30d: 0,
  total_products: 0,
  total_vendors: 0,
  total_reviews: 0,
  most_integrated_product: null,
  most_active_category: null,
  recent_integrations: [],
  trending_products: [],
  recently_added_products: [],
};

describe('fetchHomeStats', () => {
  it('requests GET /api/stats/home and returns the parsed payload', async () => {
    const client = stubClient(async () => SPARSE_STATS as unknown);

    const result = await fetchHomeStats(client);

    expect(result).toEqual(SPARSE_STATS);
    expect(client.request).toHaveBeenCalledWith('/api/stats/home');
  });

  it('passes a populated snapshot through unchanged (no NOT_FOUND mapping)', async () => {
    const populated: HomeStatsResponse = {
      ...SPARSE_STATS,
      total_integrations: 42,
      integrations_added_30d: 7,
    };
    const client = stubClient(async () => populated as unknown);

    const result = await fetchHomeStats(client);

    expect(result).toEqual(populated);
  });
});
