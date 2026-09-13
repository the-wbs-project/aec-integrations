/**
 * Unit tests for the AECI-868 arrival-metadata coverage read
 * (`arrival-coverage.ts`) on the in-memory D1 harness. Real `page_views` rows,
 * the real query — the ratio is the whole product here, so a mocked `db` would
 * assert nothing worth asserting.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pageViews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { ARRIVAL_CF_COVERAGE_MIN, readArrivalCfCoverage } from './arrival-coverage';

const NOW = new Date('2026-09-11T04:00:00.000Z');
const WINDOW_START = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
const WINDOW_END = NOW.toISOString();
const IN_WINDOW = '2026-09-10T12:00:00.000Z';
const BEFORE_WINDOW = '2026-09-09T12:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

async function seedView(over: {
  navigation: string | null;
  cfAsn?: number | null;
  createdAt?: string;
}): Promise<void> {
  await t.db.insert(pageViews).values({
    path: '/products/procore',
    navigation: over.navigation,
    cfAsn: over.cfAsn ?? null,
    createdAt: over.createdAt ?? IN_WINDOW,
  });
}

const read = () => readArrivalCfCoverage(t.db, WINDOW_START, WINDOW_END);

describe('readArrivalCfCoverage', () => {
  it('reports full coverage when every arrival carries a cf_asn', async () => {
    await seedView({ navigation: 'arrival', cfAsn: 23700 });
    await seedView({ navigation: 'arrival', cfAsn: 15169 });

    expect(await read()).toEqual({ arrivals: 2, arrivalsWithAsn: 2, coverage: 1 });
  });

  it('reports zero coverage for the AECI-868 outage shape (arrivals present, all NULL)', async () => {
    for (let i = 0; i < 5; i++) await seedView({ navigation: 'arrival', cfAsn: null });

    expect(await read()).toEqual({ arrivals: 5, arrivalsWithAsn: 0, coverage: 0 });
  });

  it('computes a partial ratio', async () => {
    await seedView({ navigation: 'arrival', cfAsn: 23700 });
    await seedView({ navigation: 'arrival', cfAsn: 23700 });
    await seedView({ navigation: 'arrival', cfAsn: 23700 });
    await seedView({ navigation: 'arrival', cfAsn: null });

    expect(await read()).toEqual({ arrivals: 4, arrivalsWithAsn: 3, coverage: 0.75 });
  });

  it('returns coverage 1 on an empty window — no traffic is not a telemetry defect', async () => {
    expect(await read()).toEqual({ arrivals: 0, arrivalsWithAsn: 0, coverage: 1 });
  });

  it('counts only `arrival` rows — `spa` and legacy NULL navigation are out of scope', async () => {
    // The browser tracker's SPA rows came down a different path and kept their
    // metadata throughout the outage, so including them would mask it.
    await seedView({ navigation: 'arrival', cfAsn: null });
    await seedView({ navigation: 'spa', cfAsn: 23700 });
    await seedView({ navigation: 'spa', cfAsn: 23700 });
    await seedView({ navigation: null, cfAsn: 23700 });

    expect(await read()).toEqual({ arrivals: 1, arrivalsWithAsn: 0, coverage: 0 });
  });

  it('honours the half-open window on created_at', async () => {
    await seedView({ navigation: 'arrival', cfAsn: null, createdAt: BEFORE_WINDOW });
    await seedView({ navigation: 'arrival', cfAsn: 23700, createdAt: IN_WINDOW });
    // Exactly `endIso` is excluded (`lt`), exactly `startIso` is included (`gte`).
    await seedView({ navigation: 'arrival', cfAsn: null, createdAt: WINDOW_END });
    await seedView({ navigation: 'arrival', cfAsn: 23700, createdAt: WINDOW_START });

    expect(await read()).toEqual({ arrivals: 2, arrivalsWithAsn: 2, coverage: 1 });
  });
});

describe('ARRIVAL_CF_COVERAGE_MIN', () => {
  it('sits between the observed healthy state and the observed outage', async () => {
    // Production carried ~100% before 2026-09-07 and exactly 0% after, so the
    // floor only has to separate those. Pinned so a future edit is deliberate.
    expect(ARRIVAL_CF_COVERAGE_MIN).toBe(0.95);
    expect(ARRIVAL_CF_COVERAGE_MIN).toBeGreaterThan(0);
    expect(ARRIVAL_CF_COVERAGE_MIN).toBeLessThan(1);
  });
});
