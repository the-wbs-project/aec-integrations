/**
 * `lib/vendor-snapshot.ts` (AECI-1210): each count against fixture rows on the
 * in-memory D1 harness, the activated-vendor scope, and the same-day rerun.
 */

import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestations,
  claims,
  integrationFieldChallenges,
  integrations,
  productVendors,
  products,
  profiles,
  taxonomyDataObjects,
  userActivityDaily,
  vendorActivityDaily,
  vendorEntitlements,
  vendorSeatInvites,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  computeVendorSnapshot,
  runVendorSnapshot,
  snapshotDayFor,
  UPSERT_ROWS_PER_STATEMENT,
  writeVendorSnapshot,
  type VendorSnapshotRow,
} from './vendor-snapshot';

/** The run instant: 00:30 UTC, so the snapshot day is the day before. */
const NOW = new Date('2026-10-02T00:30:00.000Z');
const DAY = '2026-10-01';

const ACME = 'v-acme';
const GLOBEX = 'v-globex';
/** A catalog vendor with products but no seat, no plan row and no invite. */
const INITECH = 'v-initech';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: ACME, slug: 'acme', companyName: 'Acme' },
    { id: GLOBEX, slug: 'globex', companyName: 'Globex' },
    { id: INITECH, slug: 'initech', companyName: 'Initech' },
  ]);
});
afterEach(() => t.dispose());

async function snapshot(): Promise<Map<string, VendorSnapshotRow>> {
  const rows = await computeVendorSnapshot(t.db, DAY, NOW);
  return new Map(rows.map((r) => [r.vendorId, r]));
}

async function seat(id: string, vendorId: string, over: { bannedAt?: string } = {}) {
  await t.db.insert(profiles).values({
    id,
    role: 'vendor_admin',
    vendorId,
    bannedAt: over.bannedAt ?? null,
  });
}

async function activity(userId: string, vendorId: string, day: string, role = 'vendor_admin') {
  await t.db.insert(userActivityDaily).values({
    userId,
    day,
    role,
    vendorId,
    firstSeenAt: `${day}T09:00:00.000Z`,
    lastSeenAt: `${day}T09:00:00.000Z`,
  });
}

describe('snapshotDayFor', () => {
  it('is the prior UTC day', () => {
    expect(snapshotDayFor(NOW)).toBe(DAY);
    expect(snapshotDayFor(new Date('2026-01-01T00:30:00.000Z'))).toBe('2025-12-31');
  });
});

describe('computeVendorSnapshot — scope', () => {
  it('gives an unactivated catalog vendor no row', async () => {
    await t.db.insert(products).values({ id: 'p1', slug: 'p1', name: 'P1' });
    await t.db.insert(productVendors).values({ productId: 'p1', vendorId: INITECH });
    await seat('u1', ACME);

    const rows = await snapshot();
    expect([...rows.keys()]).toEqual([ACME]);
  });

  it('activates a vendor by a seat, an entitlement row, or a live invite', async () => {
    await seat('u1', ACME);
    await t.db.insert(vendorEntitlements).values({ vendorId: GLOBEX, status: 'expired' });
    await t.db.insert(vendorSeatInvites).values({
      vendorId: INITECH,
      email: 'a@initech.test',
      expiresAt: '2026-10-10T00:00:00.000Z',
    });

    const rows = await snapshot();
    expect([...rows.keys()].sort()).toEqual([ACME, GLOBEX, INITECH]);
  });

  it('does not activate a vendor whose only seat is banned', async () => {
    await seat('u1', ACME, { bannedAt: '2026-09-01T00:00:00.000Z' });
    expect((await snapshot()).size).toBe(0);
  });

  it('writes nothing on a platform with no activated vendor', async () => {
    expect(await runVendorSnapshot(t.db, NOW)).toEqual({ day: DAY, vendors: 0 });
    expect(await t.db.select().from(vendorActivityDaily)).toEqual([]);
  });
});

describe('computeVendorSnapshot — counts', () => {
  it('counts unbanned vendor_admin seats only', async () => {
    await seat('u1', ACME);
    await seat('u2', ACME);
    await seat('u3', ACME, { bannedAt: '2026-09-01T00:00:00.000Z' });
    // A reviewer carrying a vendor_id is not a seat.
    await t.db.insert(profiles).values({ id: 'u4', role: 'reviewer', vendorId: ACME });

    expect((await snapshot()).get(ACME)?.seats).toBe(2);
  });

  it('counts live invites only: not accepted, not revoked, not expired at run time', async () => {
    await seat('u1', ACME);
    const base = { vendorId: ACME, expiresAt: '2026-10-10T00:00:00.000Z' };
    await t.db.insert(vendorSeatInvites).values([
      { ...base, email: 'live@acme.test' },
      { ...base, email: 'accepted@acme.test', acceptedAt: '2026-09-30T00:00:00.000Z' },
      { ...base, email: 'revoked@acme.test', revokedAt: '2026-09-30T00:00:00.000Z' },
      { ...base, email: 'expired@acme.test', expiresAt: '2026-10-02T00:29:59.000Z' },
    ]);

    expect((await snapshot()).get(ACME)?.pendingInvites).toBe(1);
  });

  it('records a Free vendor with no entitlement row as null raw plan and unclaimed', async () => {
    await seat('u1', ACME);
    expect((await snapshot()).get(ACME)).toMatchObject({
      entitlementTier: null,
      entitlementStatus: null,
      effectiveTier: 'unclaimed',
    });
  });

  it('records the raw plan row and the tier tierFor() derives from it', async () => {
    await t.db.insert(vendorEntitlements).values([
      { vendorId: ACME, tier: 'verified', status: 'active' },
      { vendorId: GLOBEX, tier: 'verified', status: 'expired' },
    ]);
    const rows = await snapshot();
    expect(rows.get(ACME)).toMatchObject({
      entitlementTier: 'verified',
      entitlementStatus: 'active',
      effectiveTier: 'verified',
    });
    // A lapsed plan keeps its raw row but is Free.
    expect(rows.get(GLOBEX)).toMatchObject({
      entitlementTier: 'verified',
      entitlementStatus: 'expired',
      effectiveTier: 'unclaimed',
    });
  });

  it('counts distinct active vendor users over 1, 7 and 30 days ending on the snapshot day', async () => {
    await seat('u1', ACME);
    // On the day itself: u1 twice would be a PK clash, so one row a day per user.
    await activity('u1', ACME, DAY);
    await activity('u1', ACME, '2026-09-30');
    // 7-day edge: 2026-09-25 is day -6, inside. 2026-09-24 is day -7, outside.
    await activity('u2', ACME, '2026-09-25');
    await activity('u3', ACME, '2026-09-24');
    // 30-day edge: 2026-09-02 is day -29, inside. 2026-09-01 is day -30, outside.
    await activity('u4', ACME, '2026-09-02');
    await activity('u5', ACME, '2026-09-01');
    // After the snapshot day: never counted.
    await activity('u6', ACME, '2026-10-02');
    // An operator or reviewer row carrying the vendor id is not vendor use.
    await activity('admin', ACME, DAY, 'admin');

    expect((await snapshot()).get(ACME)).toMatchObject({
      activeUsers1d: 1,
      activeUsers7d: 2,
      activeUsers30d: 4,
    });
  });

  it('counts open contests twice: as the owner and as the filer', async () => {
    await seat('u1', ACME);
    await seat('u2', GLOBEX);
    await t.db.insert(products).values([
      { id: 'pa', slug: 'pa', name: 'PA' },
      { id: 'pb', slug: 'pb', name: 'PB' },
    ]);
    await t.db.insert(integrations).values({
      id: 'i1',
      sourceProductId: 'pa',
      targetProductId: 'pb',
      mechanismKind: 'native',
      mechanismName: 'Bridge',
      direction: 'a_to_b',
    });
    // One OPEN contest per (integration, field, submitter), so each row takes its own field.
    const contest = { integrationId: 'i1', reason: 'wrong', routedTo: 'owner' };
    await t.db.insert(integrationFieldChallenges).values([
      { ...contest, field: 'name', submitterVendorId: GLOBEX, ownerVendorId: ACME },
      { ...contest, field: 'direction', submitterVendorId: GLOBEX, ownerVendorId: ACME },
      {
        ...contest,
        field: 'website',
        submitterVendorId: GLOBEX,
        ownerVendorId: ACME,
        status: 'declined',
      },
      { ...contest, field: 'name', submitterVendorId: ACME, ownerVendorId: GLOBEX },
      {
        ...contest,
        field: 'direction',
        submitterVendorId: ACME,
        ownerVendorId: null,
        routedTo: 'aeci',
      },
    ]);

    const rows = await snapshot();
    expect(rows.get(ACME)).toMatchObject({ openContestsOwned: 2, openContestsFiled: 2 });
    expect(rows.get(GLOBEX)).toMatchObject({ openContestsOwned: 1, openContestsFiled: 2 });
  });

  it('counts live attestations by the vendor; a retracted one is not a confirmation', async () => {
    await seat('u1', ACME);
    await t.db.insert(products).values([
      { id: 'pa', slug: 'pa', name: 'PA' },
      { id: 'pb', slug: 'pb', name: 'PB' },
    ]);
    await t.db.insert(integrations).values({
      id: 'i1',
      sourceProductId: 'pa',
      targetProductId: 'pb',
      mechanismKind: 'native',
      mechanismName: 'Bridge',
      direction: 'a_to_b',
    });
    await t.db
      .insert(taxonomyDataObjects)
      .values({ id: 'do1', slug: 'rfis', name: 'RFIs', displayOrder: 1 });
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'do1', direction: 'a_to_b' });
    await t.db.insert(attestations).values([
      { claimId: 'c1', source: 'vendor_a', attestedByVendorId: ACME },
      { claimId: 'c1', source: 'vendor_b', attestedByVendorId: ACME },
      {
        claimId: 'c1',
        source: 'vendor_a',
        attestedByVendorId: ACME,
        retractedAt: '2026-09-01T00:00:00.000Z',
      },
      { claimId: 'c1', source: 'aeci', attestedByVendorId: null },
    ]);

    expect((await snapshot()).get(ACME)?.dataFlowsConfirmed).toBe(2);
  });

  it('counts owned products, and confirmed ones by the checklist predicate', async () => {
    await seat('u1', ACME);
    await t.db.insert(products).values([
      // Confirmed: vendor-maintained and reviewed.
      {
        id: 'p1',
        slug: 'p1',
        name: 'P1',
        maintainedBy: 'vendor',
        lastReviewedAt: '2026-09-20T00:00:00.000Z',
      },
      {
        id: 'p2',
        slug: 'p2',
        name: 'P2',
        maintainedBy: 'vendor',
        lastReviewedAt: '2026-09-21T00:00:00.000Z',
      },
      // Vendor-maintained but never reviewed.
      { id: 'p3', slug: 'p3', name: 'P3', maintainedBy: 'vendor' },
      // Reviewed but still AECi-maintained.
      {
        id: 'p4',
        slug: 'p4',
        name: 'P4',
        maintainedBy: 'aeci',
        lastReviewedAt: '2026-09-22T00:00:00.000Z',
      },
      { id: 'p5', slug: 'p5', name: 'P5' },
    ]);
    await t.db
      .insert(productVendors)
      .values(['p1', 'p2', 'p3', 'p4'].map((productId) => ({ productId, vendorId: ACME })));
    await t.db.insert(productVendors).values({ productId: 'p5', vendorId: GLOBEX });

    const acme = (await snapshot()).get(ACME);
    expect(acme).toMatchObject({ productsTotal: 4, productsConfirmed: 2 });
  });

  it('stamps every row with the snapshot day and the run instant', async () => {
    await seat('u1', ACME);
    expect((await snapshot()).get(ACME)).toMatchObject({
      day: DAY,
      computedAt: NOW.toISOString(),
    });
  });
});

describe('writeVendorSnapshot / runVendorSnapshot', () => {
  it('writes one row per activated vendor', async () => {
    await seat('u1', ACME);
    await seat('u2', GLOBEX);

    expect(await runVendorSnapshot(t.db, NOW)).toEqual({ day: DAY, vendors: 2 });
    const rows = await t.db
      .select()
      .from(vendorActivityDaily)
      .orderBy(asc(vendorActivityDaily.vendorId));
    expect(rows.map((r) => [r.day, r.vendorId, r.seats])).toEqual([
      [DAY, ACME, 1],
      [DAY, GLOBEX, 1],
    ]);
  });

  it('a same-day rerun replaces the rows and adds none', async () => {
    await seat('u1', ACME);
    await runVendorSnapshot(t.db, NOW);

    await seat('u2', ACME);
    const later = new Date('2026-10-02T03:00:00.000Z');
    expect(await runVendorSnapshot(t.db, later)).toEqual({ day: DAY, vendors: 1 });

    const rows = await t.db.select().from(vendorActivityDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seats: 2, computedAt: later.toISOString() });
  });

  it('chunks the upsert under the D1 bound-parameter cap', async () => {
    const n = UPSERT_ROWS_PER_STATEMENT * 2 + 1;
    const rows: VendorSnapshotRow[] = Array.from({ length: n }, (_, i) => ({
      day: DAY,
      vendorId: `v-${String(i).padStart(2, '0')}`,
      seats: 1,
      pendingInvites: 0,
      activeUsers1d: 0,
      activeUsers7d: 0,
      activeUsers30d: 0,
      entitlementTier: null,
      entitlementStatus: null,
      effectiveTier: 'unclaimed',
      openContestsOwned: 0,
      openContestsFiled: 0,
      dataFlowsConfirmed: 0,
      productsTotal: 0,
      productsConfirmed: 0,
      computedAt: NOW.toISOString(),
    }));
    // 16 columns per row: the chunk must stay at or under D1's 100 bound parameters.
    expect(UPSERT_ROWS_PER_STATEMENT * 16).toBeLessThanOrEqual(100);

    await writeVendorSnapshot(t.db, rows);
    expect(await t.db.select().from(vendorActivityDaily)).toHaveLength(n);
  });
});
