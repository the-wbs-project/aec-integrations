import { describe, expect, it } from 'vitest';

import {
  OWNERSHIP_RECORD_SCHEMA_VERSION,
  OwnershipRecordSchema,
  OwnershipSyncMessageSchema,
  ownershipRecordUrl,
  type OwnershipRecord,
} from './review-app-ownership';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const owned: OwnershipRecord = {
  schemaVersion: OWNERSHIP_RECORD_SCHEMA_VERSION,
  vendorId: u(1),
  owner: 'vendor',
  ownedAt: '2026-10-19T00:00:00.000Z',
  version: 1_792_000_000_000,
  asOf: '2026-10-20T00:00:00.000Z',
  reason: 'claim_approved',
  products: [{ id: u(2), owner: 'vendor' }],
  integrations: [
    { id: u(3), table: 'integrations', owner: 'vendor' },
    { id: u(4), table: 'connector_evidenced_pairs', owner: 'vendor' },
  ],
  proposals: [
    {
      id: u(5),
      ref: 'p:recAbc123',
      state: 'accepted',
      decidedAt: '2026-10-20T00:00:00.000Z',
      productId: u(6),
    },
  ],
};

describe('OwnershipRecordSchema (REVIEW_APP_PROMOTE_API.md §4d)', () => {
  it('accepts a vendor-owned record', () => {
    expect(OwnershipRecordSchema.parse(owned)).toEqual(owned);
  });

  it('accepts a returned record, with a co-owned product still vendor-owned', () => {
    const returned = {
      ...owned,
      owner: 'aeci',
      ownedAt: null,
      reason: 'records_returned',
      products: [
        { id: u(2), owner: 'aeci' },
        { id: u(7), owner: 'vendor' },
      ],
    };
    expect(OwnershipRecordSchema.safeParse(returned).success).toBe(true);
  });

  it('ties ownedAt to owner in both directions', () => {
    expect(OwnershipRecordSchema.safeParse({ ...owned, ownedAt: null }).success).toBe(false);
    expect(OwnershipRecordSchema.safeParse({ ...owned, owner: 'aeci', products: [] }).success).toBe(
      false,
    );
  });

  it('refuses an AECi-owned product on a vendor-owned vendor (ruling Q3)', () => {
    const bad = { ...owned, products: [{ id: u(2), owner: 'aeci' }] };
    expect(OwnershipRecordSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses an unknown table, an unknown reason and a non-UUID id', () => {
    expect(
      OwnershipRecordSchema.safeParse({
        ...owned,
        integrations: [{ id: u(3), table: 'claims', owner: 'vendor' }],
      }).success,
    ).toBe(false);
    expect(OwnershipRecordSchema.safeParse({ ...owned, reason: 'other' }).success).toBe(false);
    expect(OwnershipRecordSchema.safeParse({ ...owned, vendorId: 'rec123' }).success).toBe(false);
  });

  it('refuses a future schema version', () => {
    expect(OwnershipRecordSchema.safeParse({ ...owned, schemaVersion: 2 }).success).toBe(false);
  });
});

describe('OwnershipSyncMessageSchema', () => {
  it('carries the vendor, the reason and the enqueue time only', () => {
    const msg = { vendorId: u(1), reason: 'backfill', enqueuedAt: '2026-10-20T00:00:00.000Z' };
    expect(OwnershipSyncMessageSchema.parse(msg)).toEqual(msg);
    expect(OwnershipSyncMessageSchema.safeParse({ ...msg, reason: 'x' }).success).toBe(false);
  });
});

describe('ownershipRecordUrl', () => {
  it('joins the base and the vendor path, with or without a trailing slash', () => {
    expect(ownershipRecordUrl('https://review.example/api/ownership', u(1))).toBe(
      `https://review.example/api/ownership/vendors/${u(1)}`,
    );
    expect(ownershipRecordUrl('https://review.example/api/ownership/', u(1))).toBe(
      `https://review.example/api/ownership/vendors/${u(1)}`,
    );
  });
});
