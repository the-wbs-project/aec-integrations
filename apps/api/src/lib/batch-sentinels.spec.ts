/**
 * The batch sentinels must raise when the row they guard is GONE (AECI-1005 review).
 *
 * Each used to read `FROM <table> WHERE id = ?`. When the row had been deleted (a
 * promote cross-table move deletes an unclaimed integration, and the FK cascade
 * takes its contests), that source returned zero rows, the CASE never ran, and the
 * batch committed its audit and notification rows for a write that matched nothing.
 * They now read from a one-row constant, so the guard always evaluates once.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { integrationFieldChallenges, integrations, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import type { BatchTuple } from './audit';
import { claimRaceSentinel, isClaimRaceError } from './integration-claims';
import { isOwnerWriteRaceError, ownerWriteSentinel } from './integration-owner-writes';
import {
  contestIntegrationStateSentinel,
  contestStillOpenSentinel,
  isContestRaceError,
} from './integration-contests';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(products).values([
    { id: 'p1', slug: 'a', name: 'A' },
    { id: 'p2', slug: 'b', name: 'B' },
  ]);
  await t.db
    .insert(integrations)
    .values({ id: 'i1', sourceProductId: 'p1', targetProductId: 'p2' });
});
afterEach(() => t.dispose());

const run = (stmts: unknown[]) => t.db.batch(stmts as unknown as BatchTuple);

describe('claimRaceSentinel', () => {
  it('raises when the guarded UPDATE matched nothing because the row is gone', async () => {
    const error = await run([
      t.db.update(integrations).set({ claimedAt: 'x' }).where(eq(integrations.id, 'gone')),
      claimRaceSentinel(t.db, 'gone'),
    ]).catch((e: unknown) => e);
    expect(isClaimRaceError(error)).toBe(true);
  });

  it('passes when the guarded UPDATE changed the row', async () => {
    await expect(
      run([
        t.db.update(integrations).set({ claimedAt: 'x' }).where(eq(integrations.id, 'i1')),
        claimRaceSentinel(t.db, 'i1'),
      ]),
    ).resolves.toBeDefined();
  });
});

describe('contestStillOpenSentinel', () => {
  it('raises when the contest row is gone, not just closed', async () => {
    const error = await run([
      t.db
        .update(integrationFieldChallenges)
        .set({ status: 'accepted' })
        .where(eq(integrationFieldChallenges.id, 'gone')),
      contestStillOpenSentinel(t.db, 'gone'),
    ]).catch((e: unknown) => e);
    expect(isContestRaceError(error)).toBe(true);
  });
});

describe('contestIntegrationStateSentinel', () => {
  it('raises when the integration row is gone', async () => {
    const error = await run([
      contestIntegrationStateSentinel(t.db, 'gone', { claimed: false, ownerVendorId: null }),
    ]).catch((e: unknown) => e);
    expect(isContestRaceError(error)).toBe(true);
  });

  it('raises when the claim state moved, and passes when it matches', async () => {
    await expect(
      run([contestIntegrationStateSentinel(t.db, 'i1', { claimed: false, ownerVendorId: null })]),
    ).resolves.toBeDefined();
    const error = await run([
      contestIntegrationStateSentinel(t.db, 'i1', { claimed: true, ownerVendorId: null }),
    ]).catch((e: unknown) => e);
    expect(isContestRaceError(error)).toBe(true);
  });
});

describe('ownerWriteSentinel (AECI-1006)', () => {
  it('raises when the guarded UPDATE matched nothing because the row is gone', async () => {
    const error = await run([
      t.db.update(integrations).set({ name: 'x' }).where(eq(integrations.id, 'gone')),
      ownerWriteSentinel(t.db),
    ]).catch((e: unknown) => e);
    expect(isOwnerWriteRaceError(error)).toBe(true);
  });

  it('passes when the guarded UPDATE changed the row', async () => {
    await expect(
      run([
        t.db.update(integrations).set({ name: 'x' }).where(eq(integrations.id, 'i1')),
        ownerWriteSentinel(t.db),
      ]),
    ).resolves.toBeDefined();
  });
});
