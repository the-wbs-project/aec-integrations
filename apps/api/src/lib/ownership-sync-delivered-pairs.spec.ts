/**
 * `deliveredPairs[]` on the v2 ownership record (AECI-2047, `REVIEW_APP_PROMOTE_API.md`
 * §4d): the pairs a vendor delivers as a connector's builder. Real SQLite via the D1
 * harness.
 *
 * The field is additive. It is left out when a vendor delivers no pair, so every
 * existing record, and its hash, is unchanged. An entry is `vendor`-owned, with content
 * and claims, exactly when the pair is claimed or vendor-created: when promote refuses
 * it (§4b).
 */

import {
  computeOwnershipRecordHash,
  OwnershipRecordV2Schema,
  type OwnershipRecordV2,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connectorEvidencedPairs, productVendors, products, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  buildOwnershipRecord,
  buildOwnershipRecordV2,
  resolveMirrorVendorIds,
} from './ownership-sync';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const S = u(1); // the Sync Service vendor, owned
const E = u(2); // an endpoint vendor
const X = u(3); // another connector vendor
const P_SYNC = u(10); // S's connector, a Sync Service
const P_SYNC_APP = u(11); // S's own application product
const P_A = u(12); // E's
const P_B = u(13); // E's
const P_X = u(14); // X's connector
const D_CLAIMED = u(20); // P_SYNC delivers P_A ↔ P_B, built by S, claimed
const D_FREE = u(21); // P_X delivers P_A ↔ P_B, built by S, unclaimed
const D_ENDPOINT = u(22); // P_X delivers P_SYNC_APP ↔ P_A, built by S: an integrations[] entry
const D_OTHER = u(23); // P_SYNC delivers P_SYNC_APP ↔ P_A, built by X: an integrations[] entry

const OWNED_AT = '2026-11-20T00:00:00.000Z';
const NOW = new Date('2026-11-24T12:00:00.000Z');

let t: TestDb;

const sorted = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: S, slug: 'rivets', companyName: 'Rivets', ownedAt: OWNED_AT },
    { id: E, slug: 'procore', companyName: 'Procore' },
    { id: X, slug: 'zapier', companyName: 'Zapier' },
  ]);
  await t.db.insert(products).values([
    {
      id: P_SYNC,
      slug: 'rivets-sync',
      name: 'Rivets Sync',
      productRole: 'connector',
      connectorKind: 'sync_service',
    },
    { id: P_SYNC_APP, slug: 'rivets-app', name: 'Rivets App' },
    { id: P_A, slug: 'procore-pm', name: 'Procore PM' },
    { id: P_B, slug: 'procore-fin', name: 'Procore Fin' },
    { id: P_X, slug: 'zapier', name: 'Zapier', productRole: 'connector' },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_SYNC, vendorId: S, isPrimary: true },
    { productId: P_SYNC_APP, vendorId: S, isPrimary: true },
    { productId: P_A, vendorId: E, isPrimary: true },
    { productId: P_B, vendorId: E, isPrimary: true },
    { productId: P_X, vendorId: X, isPrimary: true },
  ]);
  const [ab1, ab2] = sorted(P_A, P_B);
  const [ea1, ea2] = sorted(P_SYNC_APP, P_A);
  await t.db.insert(connectorEvidencedPairs).values([
    {
      id: D_CLAIMED,
      connectorProductId: P_SYNC,
      productAId: ab1,
      productBId: ab2,
      name: 'Procore PM and Procore Fin',
      builtByVendorId: S,
      claimedAt: OWNED_AT,
      maintainedBy: 'vendor',
    },
    {
      // Unclaimed: still AECi's to promote, so listed without content.
      id: D_FREE,
      connectorProductId: P_X,
      productAId: ab1,
      productBId: ab2,
      name: 'Unclaimed',
      builtByVendorId: S,
    },
    {
      id: D_ENDPOINT,
      connectorProductId: P_X,
      productAId: ea1,
      productBId: ea2,
      builtByVendorId: S,
    },
    {
      id: D_OTHER,
      connectorProductId: P_SYNC,
      productAId: ea1,
      productBId: ea2,
      builtByVendorId: X,
    },
  ]);
});
afterEach(() => t.dispose());

const build = async (vendorId = S) =>
  (await buildOwnershipRecordV2(t.db, vendorId, 'backfill', NOW))!;

describe('deliveredPairs[] (AECI-2047)', () => {
  it('lists the pairs the vendor builds and holds no endpoint of, sorted by id', async () => {
    const record = await build();
    expect(OwnershipRecordV2Schema.parse(record)).toEqual(record);
    expect(record.deliveredPairs?.map((p) => p.id)).toEqual([D_CLAIMED, D_FREE].sort());
    // The pair with one of the vendor's own products is the existing rule's.
    expect(record.integrations.map((i) => i.id)).toEqual([D_ENDPOINT, D_OTHER].sort());
  });

  it('carries content and claims exactly for a claimed pair', async () => {
    const record = await build();
    const byId = new Map(record.deliveredPairs!.map((p) => [p.id, p]));
    const claimed = byId.get(D_CLAIMED)!;
    expect(claimed).toMatchObject({
      table: 'connector_evidenced_pairs',
      owner: 'vendor',
      claims: [],
    });
    expect(claimed.content).toMatchObject({
      name: 'Procore PM and Procore Fin',
      poweredByProduct: { supabaseId: P_SYNC },
      builtByVendor: { supabaseId: S },
      maintainedBy: 'vendor',
    });
    expect(claimed.content).not.toHaveProperty('mechanismKind');
    expect(byId.get(D_FREE)).toEqual({
      id: D_FREE,
      table: 'connector_evidenced_pairs',
      owner: 'aeci',
    });
  });

  it('is left out, not empty, for a vendor that delivers no pair', async () => {
    const record = await build(E);
    expect('deliveredPairs' in record).toBe(false);
  });

  it('does not change the hash of a record without delivered pairs', async () => {
    const record = await build(E);
    const withEmpty = { ...record, deliveredPairs: undefined } as OwnershipRecordV2;
    expect(await computeOwnershipRecordHash(withEmpty)).toBe(record.recordHash);
  });

  it("moves the hash when the owner edits its claimed pair, not when AECi's unclaimed one changes", async () => {
    const before = (await build()).recordHash;
    await t.db
      .update(connectorEvidencedPairs)
      .set({ name: 'Renamed by AECi' })
      .where(eq(connectorEvidencedPairs.id, D_FREE));
    expect((await build()).recordHash).toBe(before);
    await t.db
      .update(connectorEvidencedPairs)
      .set({ name: 'Renamed by the owner' })
      .where(eq(connectorEvidencedPairs.id, D_CLAIMED));
    expect((await build()).recordHash).not.toBe(before);
  });

  it('never reaches the frozen v1 record', async () => {
    const v1 = (await buildOwnershipRecord(t.db, S, 'backfill', NOW))!;
    expect(v1.schemaVersion).toBe(1);
    expect('deliveredPairs' in v1).toBe(false);
  });
});

describe('the mirror re-send reaches the builder (AECI-2047)', () => {
  it('resolves an edit of a delivered pair to its owned builder', async () => {
    const ids = await resolveMirrorVendorIds(t.db, {
      vendorIds: [],
      productIds: [],
      edgeIds: [D_CLAIMED],
    });
    expect(ids).toEqual([S]);
  });

  it('does not resolve to a builder that is not owned', async () => {
    await t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, S));
    const ids = await resolveMirrorVendorIds(t.db, {
      vendorIds: [],
      productIds: [],
      edgeIds: [D_CLAIMED],
    });
    expect(ids).toEqual([]);
  });
});

describe('OwnershipRecordV2Schema deliveredPairs rules', () => {
  it('refuses a delivered pair also listed in integrations', async () => {
    const record = await build();
    const dup = {
      ...record,
      integrations: [
        ...record.integrations,
        { id: D_FREE, table: 'connector_evidenced_pairs', owner: 'aeci' },
      ],
    };
    expect(OwnershipRecordV2Schema.safeParse(dup).success).toBe(false);
  });

  it('refuses a delivered pair from the integrations table', async () => {
    const record = await build();
    const wrong = {
      ...record,
      deliveredPairs: [{ id: D_FREE, table: 'integrations', owner: 'aeci' }],
    };
    expect(OwnershipRecordV2Schema.safeParse(wrong).success).toBe(false);
  });

  it('refuses an owned delivered pair with no content', async () => {
    const record = await build();
    const wrong = {
      ...record,
      deliveredPairs: [{ id: D_CLAIMED, table: 'connector_evidenced_pairs', owner: 'vendor' }],
    };
    expect(OwnershipRecordV2Schema.safeParse(wrong).success).toBe(false);
  });
});
