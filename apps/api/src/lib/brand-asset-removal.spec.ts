/**
 * The daily removal job with time travel (AECI-1618, `STAGE_2_5_SPEC.md` §11), against the
 * real-SQLite harness and a fake R2.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  productProposals,
  products,
  productVendors,
  profiles,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeFakeR2Bucket, type FakeR2Bucket } from '../test/fake-r2';
import {
  BRAND_ASSET_RUN_HOUR_UTC,
  brandAssetLimitAt,
  brandAssetNextRunAt,
  logoKeyOf,
  runBrandAssetRemoval,
} from './brand-asset-removal';
import { BRAND_ASSET_REMOVAL_CRON } from './cron-schedules';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const OTHER = u(2);
const PRODUCT = u(11);
const SHARED = u(12);
const hash = (c: string) => c.repeat(64);
const path = (c: string) => `/api/logos/${hash(c)}`;
const ENDED = '2026-11-01T10:00:00.000Z';
const day = (n: number) => new Date(Date.parse(ENDED) + n * 86_400_000);

let t: TestDb;
let bucket: FakeR2Bucket;
let sendBatch: ReturnType<typeof vi.fn>;
let syncOwnership: ReturnType<typeof vi.fn>;

async function store(...chars: string[]) {
  for (const c of chars) await bucket.put(hash(c), new ArrayBuffer(4));
}

const run = (now: Date) =>
  runBrandAssetRemoval(t.db, {
    bucket: bucket as unknown as R2Bucket,
    now,
    purgeQueue: { sendBatch } as unknown as Queue,
    syncOwnership: syncOwnership as never,
    forwardAudits: () => {},
  });

const vendorRow = async (id = VENDOR) =>
  (await t.db.select().from(vendors).where(eq(vendors.id, id)))[0]!;
const productRow = async (id = PRODUCT) =>
  (await t.db.select().from(products).where(eq(products.id, id)))[0]!;
const actions = async () => (await t.db.select().from(auditLog)).map((row) => row.action).sort();

beforeEach(async () => {
  t = await makeTestDb();
  bucket = makeFakeR2Bucket();
  sendBatch = vi.fn(async () => undefined);
  syncOwnership = vi.fn(async () => undefined);
  await t.db.insert(vendors).values([
    {
      id: VENDOR,
      slug: 'acme',
      companyName: 'Acme',
      ownedAt: '2026-01-01T00:00:00.000Z',
      claimEndedAt: ENDED,
      logoUrl: path('a'),
      logoSource: 'vendor',
      sourcedLogoUrl: 'https://cdn.example/acme.png',
    },
    {
      id: OTHER,
      slug: 'other',
      companyName: 'Other',
      ownedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);
  await t.db.insert(products).values([
    { id: PRODUCT, slug: 'widget', name: 'Widget', logoUrl: path('b'), logoSource: 'vendor' },
    { id: SHARED, slug: 'shared', name: 'Shared', logoUrl: path('c'), logoSource: 'vendor' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: PRODUCT, vendorId: VENDOR, isPrimary: true },
    { productId: SHARED, vendorId: VENDOR, isPrimary: true },
    { productId: SHARED, vendorId: OTHER, isPrimary: false },
  ]);
  await t.db.insert(profiles).values({ id: u(101), role: 'vendor_admin', vendorId: OTHER });
  await store('a', 'b', 'c');
});

afterEach(() => t.dispose());

describe('the first run after a claim ends', () => {
  it('restores the AECi logo, deletes the object, audits, purges and stamps', async () => {
    const counts = await run(day(0.25));
    expect(counts).toMatchObject({ due: 1, completed: 1, rowsCleared: 2, failed: 0, raced: 0 });

    expect(await vendorRow()).toMatchObject({
      logoUrl: 'https://cdn.example/acme.png',
      logoSource: null,
      sourcedLogoUrl: null,
      brandAssetsRemovedAt: day(0.25).toISOString(),
      claimEndedAt: ENDED,
    });
    expect(await productRow()).toMatchObject({ logoUrl: null, logoSource: null });
    expect(bucket.keys()).toEqual([hash('c')]);

    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'vendor.brand_assets_removed'));
    expect(row).toMatchObject({ vendorId: VENDOR, entityId: VENDOR, actorType: 'system' });
    expect((row!.metadata as { rows: { id: string }[] }).rows.map((r) => r.id)).toEqual([
      VENDOR,
      PRODUCT,
    ]);
    expect(sendBatch).toHaveBeenCalledWith([
      {
        body: {
          tags: ['vendor:acme', 'product:widget', 'index:products'],
          source: 'scheduled',
        },
      },
    ]);
    expect(syncOwnership).toHaveBeenCalledWith([VENDOR]);
  });

  it('is finished: the next run finds nothing due', async () => {
    await run(day(1));
    sendBatch.mockClear();
    expect(await run(day(2))).toMatchObject({ due: 0, completed: 0 });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('leaves admin logos and promote logos alone', async () => {
    await t.db.update(vendors).set({ logoSource: 'admin' }).where(eq(vendors.id, VENDOR));
    await t.db.update(products).set({ logoSource: null }).where(eq(products.id, PRODUCT));
    expect(await run(day(1))).toMatchObject({ rowsCleared: 0, completed: 1 });
    expect((await vendorRow()).logoUrl).toBe(path('a'));
    expect((await productRow()).logoUrl).toBe(path('b'));
    expect(bucket.keys()).toContain(hash('a'));
  });

  it('clears a linked vendor logo and touches no R2 for it', async () => {
    await t.db
      .update(products)
      .set({ logoUrl: 'https://vendor.example/logo.png' })
      .where(eq(products.id, PRODUCT));
    await run(day(1));
    expect((await productRow()).logoUrl).toBeNull();
    expect(bucket.keys()).toContain(hash('b'));
  });

  it('deletes a replaced upload found in the audit history, and not an AECi before-state', async () => {
    await store('d', 'e');
    await t.db.insert(auditLog).values([
      {
        id: u(201),
        actorType: 'user',
        action: 'product.updated',
        entityType: 'product',
        entityId: PRODUCT,
        beforeState: { logoUrl: path('e'), logoSource: null },
        afterState: { logoUrl: path('d'), logoSource: 'vendor' },
      },
      {
        id: u(202),
        actorType: 'admin',
        action: 'product.updated',
        entityType: 'product',
        entityId: PRODUCT,
        afterState: { logoUrl: path('e'), logoSource: 'admin' },
      },
    ]);
    await run(day(1));
    expect(bucket.keys()).toEqual([hash('c'), hash('e')]);
  });
});

describe('the operator hold', () => {
  beforeEach(async () => {
    await t.db.update(vendors).set({ brandAssetsHoldAt: ENDED }).where(eq(vendors.id, VENDOR));
  });

  it('is respected before the last run inside the 14 days', async () => {
    expect(await run(day(5))).toMatchObject({ due: 0 });
    expect(await run(day(12.9))).toMatchObject({ due: 0 });
    expect((await vendorRow()).logoUrl).toBe(path('a'));
  });

  it('is overridden on day 14, whatever the hour', async () => {
    expect(await run(day(14))).toMatchObject({ due: 1, completed: 1 });
    expect((await vendorRow()).logoSource).toBeNull();
  });

  it('is overridden by the last daily run before the limit, so the 14 days hold', async () => {
    const runAt = day(13.5);
    expect(runAt.getTime()).toBeLessThan(Date.parse(brandAssetLimitAt(ENDED)));
    expect(await run(runAt)).toMatchObject({ due: 1, completed: 1 });
  });
});

describe('races and shared logos', () => {
  it('a re-seat wins: the claim end moved, so nothing is written', async () => {
    const batch = t.db.batch.bind(t.db);
    let first = true;
    vi.spyOn(t.db, 'batch').mockImplementation(((stmts: never) => {
      if (first) {
        first = false;
        t.raw.prepare('UPDATE vendors SET claim_ended_at = NULL WHERE id = ?').run(VENDOR);
      }
      return batch(stmts);
    }) as never);
    const counts = await run(day(1));
    expect(counts).toMatchObject({ raced: 1, completed: 0, rowsCleared: 0 });
    expect((await vendorRow()).logoUrl).toBe(path('a'));
    expect(await actions()).toEqual([]);
    expect(bucket.keys()).toContain(hash('a'));
  });

  it('skips a co-owned product while another joined vendor is claimed', async () => {
    const counts = await run(day(1));
    expect(counts.coOwnedSkipped).toBe(1);
    expect((await productRow(SHARED)).logoUrl).toBe(path('c'));
    expect(bucket.keys()).toContain(hash('c'));
  });

  it('clears a co-owned product once no joined vendor is claimed', async () => {
    await t.db.update(vendors).set({ claimEndedAt: ENDED }).where(eq(vendors.id, OTHER));
    await run(day(1));
    expect((await productRow(SHARED)).logoUrl).toBeNull();
  });

  it.each([
    [
      'another vendor',
      async () =>
        t.db
          .update(vendors)
          .set({ logoUrl: path('b') })
          .where(eq(vendors.id, OTHER)),
    ],
    [
      'a retained copy',
      async () =>
        t.db
          .update(vendors)
          .set({ sourcedLogoUrl: path('b') })
          .where(eq(vendors.id, OTHER)),
    ],
    [
      "another vendor's product",
      async () =>
        t.db
          .insert(products)
          .values({ id: u(13), slug: 'third', name: 'Third', logoUrl: path('b') }),
    ],
    [
      'an open proposal',
      async () =>
        t.db.insert(productProposals).values({
          id: u(301),
          vendorId: OTHER,
          ref: 'k',
          proposedAt: ENDED,
          payload: { logoUrl: path('b') },
        } as never),
    ],
  ])('keeps a hash %s still references', async (_label, seed) => {
    await seed();
    await run(day(1));
    expect(bucket.keys()).toContain(hash('b'));
  });

  it('an R2 failure writes no stamp, and the retry finishes with the purge', async () => {
    bucket.failDelete(new RegExp(hash('b')));
    const failed = await run(day(1));
    expect(failed).toMatchObject({ failed: 1, completed: 0 });
    expect((await vendorRow()).brandAssetsRemovedAt).toBeNull();
    // The D1 half committed: the logo is gone from the page already.
    expect((await productRow()).logoUrl).toBeNull();
    expect(sendBatch).not.toHaveBeenCalled();

    const retryBucket = makeFakeR2Bucket();
    await retryBucket.put(hash('b'), new ArrayBuffer(4));
    bucket = retryBucket;
    const retried = await run(day(1.01));
    expect(retried).toMatchObject({ failed: 0, completed: 1, rowsCleared: 0, objectsDeleted: 2 });
    expect(bucket.keys()).toEqual([]);
    expect((await vendorRow()).brandAssetsRemovedAt).not.toBeNull();
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  it('a failed purge send writes no stamp', async () => {
    sendBatch.mockRejectedValueOnce(new Error('queue down'));
    expect(await run(day(1))).toMatchObject({ failed: 1, completed: 0 });
    expect((await vendorRow()).brandAssetsRemovedAt).toBeNull();
    expect(await run(day(1.01))).toMatchObject({ completed: 1 });
    expect(sendBatch).toHaveBeenCalledTimes(2);
  });
});

describe('the small helpers', () => {
  it('pins the run hour to the cron', () => {
    expect(BRAND_ASSET_REMOVAL_CRON).toBe(`0 ${BRAND_ASSET_RUN_HOUR_UTC} * * *`);
  });

  it('reads a key only from a stored path', () => {
    expect(logoKeyOf(path('a'))).toBe(hash('a'));
    expect(logoKeyOf('https://cdn.example/x.png')).toBeNull();
    expect(logoKeyOf(null)).toBeNull();
  });

  it('names the next run, and with a hold the run the override reaches', () => {
    expect(brandAssetNextRunAt(ENDED, null, day(0))).toBe('2026-11-01T16:00:00.000Z');
    expect(brandAssetNextRunAt(ENDED, ENDED, day(1))).toBe('2026-11-14T16:00:00.000Z');
    expect(brandAssetLimitAt(ENDED)).toBe('2026-11-15T10:00:00.000Z');
  });
});
