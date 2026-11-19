import { beforeEach, describe, expect, it } from 'vitest';

import { claimThreadAcknowledgments } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { threadAcknowledgmentState } from './claim-threads';

/** AECI-1641: only a row at or after the material version counts (§15.17). */
describe('threadAcknowledgmentState', () => {
  const VENDOR = 'v-a';
  const OTHER = 'v-b';
  const INTEGRATION = 'i-1';
  let t: TestDb;
  let seq = 0;

  beforeEach(async () => {
    t = await makeTestDb();
  });

  const seed = (textVersion: string, otherVendorId = OTHER) =>
    t.db.insert(claimThreadAcknowledgments).values({
      id: `ack-${++seq}`,
      vendorId: VENDOR,
      integrationId: INTEGRATION,
      otherVendorId,
      profileId: null,
      textVersion,
      acknowledgedAt: '2026-11-01T00:00:00.000Z',
    });
  const state = (materialSince: string) =>
    threadAcknowledgmentState(t.db, VENDOR, INTEGRATION, OTHER, materialSince);

  it('reports no acknowledgment and no version with no row', async () => {
    await seed('5', 'v-someone-else');
    expect(await state('1')).toEqual({ acknowledged: false, latestVersion: null });
  });

  it('does not count a row older than the material version', async () => {
    await seed('1');
    expect(await state('2')).toEqual({ acknowledged: false, latestVersion: '1' });
  });

  it('counts a row at or after the material version', async () => {
    await seed('2');
    expect(await state('2')).toEqual({ acknowledged: true, latestVersion: '2' });
    expect(await state('1')).toEqual({ acknowledged: true, latestVersion: '2' });
  });

  it('reads the newest row, comparing versions as integers', async () => {
    await seed('9');
    await seed('10');
    expect(await state('10')).toEqual({ acknowledged: true, latestVersion: '10' });
  });
});
