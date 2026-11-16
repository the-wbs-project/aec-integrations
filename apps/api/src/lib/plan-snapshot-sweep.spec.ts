/**
 * The plan-change snapshot sweep (AECI-1621, ADR 0056). It writes only due rows, writes
 * R2 before it stamps D1, never overwrites an object (the bucket lock refuses it), and a
 * failure stays due with its count.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { planChangeSnapshots, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeFakeR2Bucket, type FakeR2Bucket } from '../test/fake-r2';
import { followupDueAt } from './plan-change-ledger';
import { runPlanSnapshotSweep } from './plan-snapshot-sweep';

const EVENT_AT = '2026-11-16T09:00:00.000Z';
const NOW = new Date('2026-11-16T09:11:00.000Z');
const P1 = 'p-1';

let t: TestDb;
let bucket: FakeR2Bucket;
beforeEach(async () => {
  t = await makeTestDb();
  bucket = makeFakeR2Bucket();
  await t.db
    .insert(products)
    .values({ id: P1, slug: 'acme-one', name: 'Acme One', promotionStatus: 'promoted' });
  const base = {
    productId: P1,
    kind: 'start' as const,
    licenseId: 'l-1',
    cause: 'license.assigned',
    eventAt: EVENT_AT,
  };
  await t.db.insert(planChangeSnapshots).values([
    { ...base, id: 'ev', phase: 'event', dueAt: EVENT_AT },
    { ...base, id: 'fu', phase: 'followup', dueAt: followupDueAt(EVENT_AT) },
  ]);
});
afterEach(() => t.dispose());

const rowOf = async (id: string) =>
  (await t.db.select().from(planChangeSnapshots).where(eq(planChangeSnapshots.id, id)))[0]!;
const sweep = (now = NOW) => runPlanSnapshotSweep(t.db, bucket, { now, commitSha: 'abc123' });
const KEY_EV = `evidence/plan-snapshots/product=${P1}/${EVENT_AT}-start-event-ev.json`;
const KEY_FU = `evidence/plan-snapshots/product=${P1}/${EVENT_AT}-start-followup-fu.json`;

describe('runPlanSnapshotSweep', () => {
  it('writes only the due row, then stamps it', async () => {
    expect(await sweep()).toEqual({ due: 1, written: 1, adopted: 0, failed: 0 });
    expect(bucket.keys()).toEqual([KEY_EV]);
    expect(await rowOf('ev')).toMatchObject({
      r2Key: KEY_EV,
      writtenAt: NOW.toISOString(),
      attempts: 0,
    });
    expect((await rowOf('fu')).r2Key).toBeNull();
  });

  it('stores the snapshot JSON with its hash, then confirms it with head', async () => {
    await sweep();
    const object = await bucket.get(KEY_EV);
    const body = JSON.parse(new TextDecoder().decode(await object!.arrayBuffer()));
    expect(body).toMatchObject({ snapshot_id: 'ev', product_id: P1, phase: 'event' });
    expect(object!.customMetadata).toMatchObject({
      schema: '1',
      product_id: P1,
      kind: 'start',
      phase: 'event',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('the follow-up waits 30 days, then goes', async () => {
    await sweep();
    expect(await sweep(new Date('2026-12-16T08:59:59.000Z'))).toMatchObject({ due: 0 });
    expect(await sweep(new Date('2026-12-16T09:00:00.000Z'))).toMatchObject({
      due: 1,
      written: 1,
    });
    expect(bucket.keys()).toEqual([KEY_EV, KEY_FU]);
  });

  it('a written row is not due again: a second run writes nothing', async () => {
    await sweep();
    expect(await sweep()).toEqual({ due: 0, written: 0, adopted: 0, failed: 0 });
    expect(bucket.puts).toEqual([KEY_EV]);
  });

  it('a refused put records the attempt and the error, and leaves the row due', async () => {
    bucket.failPut(/-event-/);
    expect(await sweep()).toEqual({ due: 1, written: 0, adopted: 0, failed: 1 });
    expect(await rowOf('ev')).toMatchObject({
      r2Key: null,
      attempts: 1,
      lastError: expect.stringContaining('fake R2 put failed'),
    });
  });

  it('a head that does not match stamps nothing', async () => {
    bucket.corruptHead(/-event-/);
    expect(await sweep()).toMatchObject({ written: 0, failed: 1 });
    expect(await rowOf('ev')).toMatchObject({
      r2Key: null,
      attempts: 1,
      lastError: expect.stringContaining('head_mismatch'),
    });
  });

  it('adopts an object an earlier run wrote, without overwriting it (the bucket lock)', async () => {
    // An earlier run wrote the object, then its D1 stamp failed.
    await bucket.put(KEY_EV, new TextEncoder().encode('{}\n').buffer as ArrayBuffer, {
      customMetadata: { sha256: 'x' },
    });
    expect(await sweep()).toEqual({ due: 1, written: 0, adopted: 1, failed: 0 });
    expect(bucket.puts).toEqual([KEY_EV]);
    expect((await rowOf('ev')).r2Key).toBe(KEY_EV);
  });

  it('a failing row cannot starve the rest: fewest attempts go first', async () => {
    await t.db
      .update(planChangeSnapshots)
      .set({ attempts: 5 })
      .where(eq(planChangeSnapshots.id, 'ev'));
    await t.db.insert(planChangeSnapshots).values({
      id: 'ev2',
      productId: P1,
      kind: 'end',
      licenseId: 'l-1',
      cause: 'license.lapsed',
      eventAt: EVENT_AT,
      phase: 'event',
      dueAt: '2026-11-16T09:05:00.000Z',
    });
    await runPlanSnapshotSweep(t.db, bucket, { now: NOW, commitSha: 'abc', limit: 1 });
    expect((await rowOf('ev2')).r2Key).not.toBeNull();
    expect((await rowOf('ev')).r2Key).toBeNull();
  });

  it('a retracted product still gets its snapshot, saying so', async () => {
    await t.db.delete(products).where(eq(products.id, P1));
    await sweep();
    const object = await bucket.get(KEY_EV);
    const body = JSON.parse(new TextDecoder().decode(await object!.arrayBuffer()));
    expect(body).toMatchObject({ product: null, reason: 'product_missing' });
  });
});
