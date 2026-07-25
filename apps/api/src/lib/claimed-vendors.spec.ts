/**
 * Unit coverage for the "is this vendor claimed?" predicate (AECI-520).
 *
 * The predicate gates the promote claimed-vendor block, so its failure modes are
 * asymmetric: a false negative lets the review app overwrite vendor-owned data,
 * and a false positive silently freezes a vendor out of curation. Both
 * directions are pinned here — especially that a `reviewer` profile pointing at
 * a vendor does NOT claim it, and that a `vendor_admin` with a null `vendor_id`
 * claims nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client';
import { profiles, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { VENDOR_ADMIN_ROLE, loadClaimedVendorIds } from './claimed-vendors';

const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';
const V3 = '33333333-3333-4333-8333-333333333333';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: V1, slug: 'autodesk', companyName: 'Autodesk' },
    { id: V2, slug: 'deltek', companyName: 'Deltek' },
    { id: V3, slug: 'bentley', companyName: 'Bentley' },
  ]);
});
afterEach(() => t.dispose());

const seat = (id: string, role: string, vendorId: string | null) =>
  t.db.insert(profiles).values({ id, role, vendorId });

describe('loadClaimedVendorIds', () => {
  it('returns an empty set for an empty candidate list without touching D1', async () => {
    // Not just an optimization: Drizzle's `inArray` with `[]` emits degenerate
    // SQL, so the short-circuit is load-bearing. A db that throws on any query
    // proves it never runs.
    const exploding = {
      query: {
        profiles: {
          findMany: () => {
            throw new Error('loadClaimedVendorIds queried D1 for an empty candidate list');
          },
        },
      },
    } as unknown as Db;
    expect(await loadClaimedVendorIds(exploding, [])).toEqual(new Set());
  });

  it('reports only vendors that have a vendor_admin seat', async () => {
    await seat('u1', VENDOR_ADMIN_ROLE, V1);
    expect(await loadClaimedVendorIds(t.db, [V1, V2, V3])).toEqual(new Set([V1]));
  });

  it('ignores non-vendor_admin profiles that point at a vendor', async () => {
    await seat('u-reviewer', 'reviewer', V2);
    await seat('u-admin', 'admin', V2);
    expect(await loadClaimedVendorIds(t.db, [V2])).toEqual(new Set());
  });

  it('ignores a vendor_admin with a null vendor_id', async () => {
    await seat('u-halfgrant', VENDOR_ADMIN_ROLE, null);
    expect(await loadClaimedVendorIds(t.db, [V1, V2, V3])).toEqual(new Set());
  });

  it('collapses multiple seats on one vendor (multi-seat, flat)', async () => {
    await seat('u1', VENDOR_ADMIN_ROLE, V1);
    await seat('u2', VENDOR_ADMIN_ROLE, V1);
    await seat('u3', VENDOR_ADMIN_ROLE, V2);
    expect(await loadClaimedVendorIds(t.db, [V1, V2])).toEqual(new Set([V1, V2]));
  });

  it('only reports candidates that were asked about', async () => {
    await seat('u1', VENDOR_ADMIN_ROLE, V1);
    await seat('u2', VENDOR_ADMIN_ROLE, V2);
    expect(await loadClaimedVendorIds(t.db, [V2])).toEqual(new Set([V2]));
  });

  it('de-duplicates the candidate list', async () => {
    await seat('u1', VENDOR_ADMIN_ROLE, V1);
    expect(await loadClaimedVendorIds(t.db, [V1, V1, V1])).toEqual(new Set([V1]));
  });
});
