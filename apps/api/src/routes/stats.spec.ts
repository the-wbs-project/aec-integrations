/**
 * GET /api/stats/home on the Drizzle/D1 path (ADR 0016 / AECI-253), against the
 * in-memory D1 harness. Reads the `home.*` keys from `stats_cache`; missing /
 * drifted values fall back rather than 500.
 */

import { HomeStatsResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { statsCache } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createStatsHomeHandler } from './stats';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const get = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/stats/home',
    handler: createStatsHomeHandler(t.factory),
  }).request('/api/stats/home', {}, TEST_ENV, fakeExecutionContext());

describe('GET /api/stats/home', () => {
  it('reads cached values and falls back for absent keys', async () => {
    await t.db.insert(statsCache).values([
      { key: 'home.total_integrations', value: 7 },
      // AECI-271 coverage counts flow through the same read path.
      { key: 'home.total_products', value: 43 },
      { key: 'home.total_vendors', value: 33 },
      { key: 'home.total_reviews', value: 12 },
    ]);

    const res = await get();
    expect(res.status).toBe(200);
    const body = HomeStatsResponseSchema.parse(await res.json());
    expect(body.total_integrations).toBe(7);
    expect(body.total_products).toBe(43);
    expect(body.total_vendors).toBe(33);
    expect(body.total_reviews).toBe(12);
    // absent keys fall back without 500ing
    expect(body.integrations_added_30d).toBe(0);
    expect(body.most_integrated_product).toBeNull();
    expect(body.recent_integrations).toEqual([]);
  });

  it('returns all defaults on an empty cache', async () => {
    const body = HomeStatsResponseSchema.parse(await (await get()).json());
    expect(body.total_integrations).toBe(0);
    // AECI-271 coverage counts default to 0 on a sparse cache (no "0 reviews"
    // suppression here — that is the UI's job).
    expect(body.total_products).toBe(0);
    expect(body.total_vendors).toBe(0);
    expect(body.total_reviews).toBe(0);
    expect(body.trending_products).toEqual([]);
  });
});
