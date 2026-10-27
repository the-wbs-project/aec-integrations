/**
 * The v2 ownership record (AECI-1413, ADR 0044, `REVIEW_APP_PROMOTE_API.md` §4d): the
 * content the builder projects through the field map, claim-slot selection, the
 * record hash, the `REVIEW_APP_MIRROR_SCHEMA` dispatch and the ledger columns. Real
 * SQLite via the D1 harness; the receiver is a mock `fetch`.
 */

import {
  computeOwnershipRecordHash,
  OwnershipRecordSchema,
  OwnershipRecordV2Schema,
  type OwnershipRecordV2,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrations,
  integrationVendorLinks,
  ownershipSyncDeliveries,
  productCategories,
  productProposals,
  productTrades,
  productVendors,
  productVersions,
  products,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  buildOwnershipRecord,
  buildOwnershipRecordV2,
  deliverOwnershipSync,
} from './ownership-sync';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const V = u(1); // the vendor the record is about, owned
const W = u(2); // co-owns P_SHARED
const X = u(3); // unrelated, unowned
const P_MINE = u(10);
const P_SHARED = u(11);
const P_OTHER = u(12); // X's
const P_CONNECTOR = u(13); // X's
const I_SOURCE = u(20); // P_MINE → P_OTHER
const I_TARGET = u(21); // P_OTHER → P_SHARED
const E_ENDPOINT = u(30); // a = P_MINE, b = P_OTHER, connector P_CONNECTOR
const CAT_CDE = u(50);
const CAT_BIM = u(51);
const TRADE = u(52);
const DO_RFIS = u(53);
const DO_DRAWINGS = u(54);
const VER_1 = u(60);
const VER_2 = u(61);
const C_RFIS = u(70); // I_SOURCE, rfis a_to_b
const C_PAIR = u(71); // E_ENDPOINT, drawings both
const A_LIVE = u(80);
const A_RETRACTED_OLD = u(81);
const A_AECI_OLD = u(82);
const A_AECI_NEW = u(83);
const A_PAIR = u(84);

const OWNED_AT = '2026-10-19T00:00:00.000Z';
const NOW = new Date('2026-10-20T12:00:00.000Z');
const URL_BASE = 'https://review.example/api/ownership';

let t: TestDb;

async function seed(db: TestDb['db'], opts: { reverse?: boolean } = {}) {
  const order = <T>(rows: T[]) => (opts.reverse ? [...rows].reverse() : rows);
  await db.insert(vendors).values(
    order([
      {
        id: V,
        slug: 'bentley',
        companyName: 'Bentley',
        website: 'https://bentley.example',
        foundedYear: 1984,
        publicPrivate: 'public',
        ownedAt: OWNED_AT,
        adminNotes: 'review-app only',
      },
      { id: W, slug: 'trimble', companyName: 'Trimble' },
      { id: X, slug: 'autodesk', companyName: 'Autodesk' },
    ]),
  );
  await db.insert(products).values(
    order([
      {
        id: P_MINE,
        slug: 'p-mine',
        name: 'Mine',
        description: 'My product',
        usefulness: {
          audiences: [{ slug: 'gc', name: 'General contractors', points: ['one', 'two'] }],
          phases: [],
        },
        adminNotes: 'review-app only',
      },
      { id: P_SHARED, slug: 'p-shared', name: 'Shared' },
      { id: P_OTHER, slug: 'p-other', name: 'Other' },
      { id: P_CONNECTOR, slug: 'p-connector', name: 'Connector', productRole: 'connector' },
    ]),
  );
  await db.insert(productVendors).values(
    order([
      { productId: P_MINE, vendorId: V, isPrimary: true },
      { productId: P_SHARED, vendorId: V, isPrimary: true },
      { productId: P_SHARED, vendorId: W, isPrimary: false },
      { productId: P_OTHER, vendorId: X, isPrimary: true },
      { productId: P_CONNECTOR, vendorId: X, isPrimary: true },
    ]),
  );
  await db.insert(taxonomyCategories).values(
    order([
      { id: CAT_CDE, slug: 'cde', name: 'CDE' },
      { id: CAT_BIM, slug: 'bim', name: 'BIM' },
    ]),
  );
  await db.insert(taxonomyTrades).values({
    id: TRADE,
    slug: 'electrical',
    name: 'Electrical',
    description: 'Electrical contractors',
  });
  await db.insert(productCategories).values(
    order([
      { productId: P_MINE, categoryId: CAT_CDE },
      { productId: P_MINE, categoryId: CAT_BIM },
    ]),
  );
  await db.insert(productTrades).values({ productId: P_MINE, tradeId: TRADE });
  await db.insert(productVersions).values(
    order([
      { id: VER_1, productId: P_MINE, label: 'v10', sortKey: 10, releasedAt: '2025-01-01' },
      { id: VER_2, productId: P_MINE, label: 'v9', sortKey: 9 },
    ]),
  );
  await db.insert(integrations).values(
    order([
      {
        id: I_SOURCE,
        sourceProductId: P_MINE,
        targetProductId: P_OTHER,
        name: 'Mine to Other',
        mechanismKind: 'native',
        direction: 'a_to_b',
        pricingUrl: 'https://pricing.example',
        notes: 'review-app only',
      },
      { id: I_TARGET, sourceProductId: P_OTHER, targetProductId: P_SHARED },
    ]),
  );
  await db.insert(connectorEvidencedPairs).values({
    id: E_ENDPOINT,
    connectorProductId: P_CONNECTOR,
    productAId: P_MINE,
    productBId: P_OTHER,
  });
  await db.insert(integrationVendorLinks).values(
    order([
      { integrationId: I_SOURCE, productId: P_MINE, kind: 'listing', url: 'https://l.example' },
      { integrationId: I_SOURCE, productId: P_MINE, kind: 'docs', url: 'https://d.example' },
    ]),
  );
  await db.insert(taxonomyDataObjects).values(
    order([
      { id: DO_RFIS, slug: 'rfis', name: 'RFIs' },
      { id: DO_DRAWINGS, slug: 'drawings', name: 'Drawings' },
    ]),
  );
  await db.insert(claims).values(
    order([
      { id: C_RFIS, integrationId: I_SOURCE, dataObjectId: DO_RFIS, direction: 'a_to_b' },
      {
        id: C_PAIR,
        connectorEvidencedPairId: E_ENDPOINT,
        dataObjectId: DO_DRAWINGS,
        direction: 'both',
      },
    ]),
  );
  await db.insert(attestations).values(
    order([
      // vendor_a: a retracted row and the live one that replaced it. The live one wins.
      {
        id: A_RETRACTED_OLD,
        claimId: C_RFIS,
        source: 'vendor_a',
        asserted: false,
        retractedAt: '2026-10-01T00:00:00.000Z',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      {
        id: A_LIVE,
        claimId: C_RFIS,
        source: 'vendor_a',
        asserted: true,
        note: 'since v9',
        introducedVersionId: VER_2,
        createdAt: '2026-10-01T00:00:00.000Z',
      },
      // aeci: two retracted rows and no live one. The latest retraction wins.
      {
        id: A_AECI_OLD,
        claimId: C_RFIS,
        source: 'aeci',
        retractedAt: '2026-08-01T00:00:00.000Z',
      },
      {
        id: A_AECI_NEW,
        claimId: C_RFIS,
        source: 'aeci',
        deprecatedVersionId: VER_1,
        retractedAt: '2026-09-15T00:00:00.000Z',
      },
      { id: A_PAIR, claimId: C_PAIR, source: 'aeci' },
    ]),
  );
}

beforeEach(async () => {
  t = await makeTestDb();
  await seed(t.db);
});
afterEach(() => t.dispose());

const build = async (reason: 'backfill' | 'vendor_edit' = 'backfill', at = NOW) =>
  (await buildOwnershipRecordV2(t.db, V, reason, at))!;

describe('buildOwnershipRecordV2', () => {
  it('parses through OwnershipRecordV2Schema and carries its own recordHash', async () => {
    const record = await build();
    expect(OwnershipRecordV2Schema.parse(record)).toEqual(record);
    expect(OwnershipRecordSchema.parse(record).schemaVersion).toBe(2);
    expect(record.recordHash).toBe(await computeOwnershipRecordHash(record));
    expect(record).toMatchObject({
      schemaVersion: 2,
      vendorId: V,
      owner: 'vendor',
      ownedAt: OWNED_AT,
      version: NOW.getTime(),
      reason: 'backfill',
    });
  });

  it('projects the vendor through the field map, with no research or note column', async () => {
    const { vendor } = await build();
    expect(vendor).toMatchObject({
      companyName: 'Bentley',
      website: 'https://bentley.example',
      foundedYear: 1984,
      publicPrivate: 'public',
      description: null,
      maintainedBy: 'aeci',
    });
    expect(vendor).not.toHaveProperty('adminNotes');
    expect(vendor).not.toHaveProperty('verified');
  });

  it('projects a product: sorted taxonomy slugs, ordered versions, usefulness', async () => {
    const record = await build();
    const mine = record.products.find((p) => p.id === P_MINE)!;
    expect(mine.owner).toBe('vendor');
    expect(mine.content).toMatchObject({
      name: 'Mine',
      slug: 'p-mine',
      productRole: 'application',
      description: 'My product',
      categories: ['bim', 'cde'],
      audiences: [],
      phases: [],
      trades: ['electrical'],
      versions: [
        { label: 'v9', releasedAt: null, sunsetAt: null },
        { label: 'v10', releasedAt: '2025-01-01', sunsetAt: null },
      ],
      usefulness: {
        audiences: [{ slug: 'gc', name: 'General contractors', points: ['one', 'two'] }],
        phases: [],
      },
    });
    expect(mine.content).not.toHaveProperty('adminNotes');
  });

  it('projects an integration with refs, mechanismKind and sorted vendor links', async () => {
    const record = await build();
    const edge = record.integrations.find((i) => i.id === I_SOURCE)!;
    expect(edge.content).toMatchObject({
      name: 'Mine to Other',
      sourceProduct: { supabaseId: P_MINE },
      targetProduct: { supabaseId: P_OTHER },
      builtByVendor: null,
      poweredByProduct: null,
      mechanismKind: 'native',
      direction: 'a_to_b',
      pricingUrl: 'https://pricing.example',
      origin: 'aeci',
      retiredAt: null,
      vendorLinks: [
        { productId: P_MINE, kind: 'docs', url: 'https://d.example' },
        { productId: P_MINE, kind: 'listing', url: 'https://l.example' },
      ],
    });
    expect(edge.content).not.toHaveProperty('notes');
  });

  it('projects a connector-evidenced pair: A/B as endpoints, connector as poweredBy, no mechanismKind', async () => {
    const record = await build();
    const pair = record.integrations.find((i) => i.id === E_ENDPOINT)!;
    expect(pair.table).toBe('connector_evidenced_pairs');
    expect(pair.content).toMatchObject({
      sourceProduct: { supabaseId: P_MINE },
      targetProduct: { supabaseId: P_OTHER },
      poweredByProduct: { supabaseId: P_CONNECTOR },
      vendorLinks: [],
    });
    expect(pair.content).not.toHaveProperty('mechanismKind');
    expect(pair.claims).toEqual([
      {
        dataObject: 'drawings',
        direction: 'both',
        source: 'aeci',
        asserted: true,
        note: null,
        introducedVersion: null,
        deprecatedVersion: null,
        retractedAt: null,
      },
    ]);
  });

  it('sends one claim per slot: the live attestation, else the latest retraction', async () => {
    const record = await build();
    expect(record.integrations.find((i) => i.id === I_SOURCE)!.claims).toEqual([
      {
        dataObject: 'rfis',
        direction: 'a_to_b',
        source: 'aeci',
        asserted: true,
        note: null,
        introducedVersion: null,
        deprecatedVersion: 'v10',
        retractedAt: '2026-09-15T00:00:00.000Z',
      },
      {
        dataObject: 'rfis',
        direction: 'a_to_b',
        source: 'vendor_a',
        asserted: true,
        note: 'since v9',
        introducedVersion: 'v9',
        deprecatedVersion: null,
        retractedAt: null,
      },
    ]);
  });

  it('a slot that never held an attestation is not listed, and an edge with none has []', async () => {
    const record = await build();
    expect(record.integrations.find((i) => i.id === I_TARGET)!.claims).toEqual([]);
  });

  it('an unowned product or edge carries no content; a returned vendor has vendor: null', async () => {
    await t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, V));
    await t.db.update(vendors).set({ ownedAt: OWNED_AT }).where(eq(vendors.id, W));
    const record = await build();
    expect(OwnershipRecordV2Schema.safeParse(record).success).toBe(true);
    expect(record.owner).toBe('aeci');
    expect(record.vendor).toBeNull();
    const mine = record.products.find((p) => p.id === P_MINE)!;
    expect(mine).toEqual({ id: P_MINE, owner: 'aeci', fromProposalRef: null });
    expect(record.products.find((p) => p.id === P_SHARED)!.content).toMatchObject({
      name: 'Shared',
    });
    expect(record.integrations.find((i) => i.id === I_SOURCE)).toEqual({
      id: I_SOURCE,
      table: 'integrations',
      owner: 'aeci',
    });
    // Its target is P_SHARED, which W still owns.
    const target = record.integrations.find((i) => i.id === I_TARGET)!;
    expect(target.owner).toBe('vendor');
    expect(target.content).toBeDefined();
    expect(target.claims).toEqual([]);
  });

  describe('fromProposalRef (AECI-1489)', () => {
    const PROPOSAL_ACCEPTED = u(90);
    const PROPOSAL_DECLINED = u(91);
    const proposal = (
      id: string,
      ref: string,
      decision: 'accepted' | 'declined' | null,
      createdProductId: string | null,
    ) => ({
      id,
      vendorId: V,
      ref,
      payload: {},
      proposedAt: '2026-10-18T00:00:00.000Z',
      decision,
      decidedAt: decision ? '2026-10-19T00:00:00.000Z' : null,
      createdProductId,
    });

    it('carries the accepted proposal ref in every owned vendor record, the co-owner included', async () => {
      // V proposed P_SHARED; W co-owns it and is not the proposer.
      await t.db
        .insert(productProposals)
        .values(proposal(PROPOSAL_ACCEPTED, 'p:recShared', 'accepted', P_SHARED));
      await t.db.update(vendors).set({ ownedAt: OWNED_AT }).where(eq(vendors.id, W));

      const mine = await build();
      const coOwner = (await buildOwnershipRecordV2(t.db, W, 'backfill', NOW))!;
      for (const record of [mine, coOwner]) {
        expect(OwnershipRecordV2Schema.safeParse(record).success).toBe(true);
        expect(record.products.find((p) => p.id === P_SHARED)!.fromProposalRef).toBe('p:recShared');
      }
      // Only the proposer's record lists the proposal itself.
      expect(mine.proposals.map((p) => p.ref)).toEqual(['p:recShared']);
      expect(coOwner.proposals).toEqual([]);
      // A product no proposal created carries null.
      expect(mine.products.find((p) => p.id === P_MINE)!.fromProposalRef).toBeNull();
    });

    it('is null on every product when no proposal created it', async () => {
      const record = await build();
      expect(record.products.map((p) => p.fromProposalRef)).toEqual([null, null]);
    });

    it('is null for a declined proposal, even one that names the product', async () => {
      await t.db
        .insert(productProposals)
        .values([
          proposal(PROPOSAL_DECLINED, 'p:recDeclined', 'declined', P_MINE),
          proposal(u(92), 'p:recOpen', null, P_SHARED),
        ]);
      const record = await build();
      expect(record.products.find((p) => p.id === P_MINE)!.fromProposalRef).toBeNull();
      expect(record.products.find((p) => p.id === P_SHARED)!.fromProposalRef).toBeNull();
    });

    it('is on an AECi-owned product entry too, and moves the hash', async () => {
      const before = await build();
      await t.db
        .insert(productProposals)
        .values(proposal(PROPOSAL_ACCEPTED, 'p:recMine', 'accepted', P_MINE));
      const after = await build();
      expect(after.recordHash).not.toBe(before.recordHash);

      await t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, V));
      const returned = await build();
      expect(returned.products.find((p) => p.id === P_MINE)).toEqual({
        id: P_MINE,
        owner: 'aeci',
        fromProposalRef: 'p:recMine',
      });
    });
  });

  it('returns null for a vendor that does not exist', async () => {
    expect(await buildOwnershipRecordV2(t.db, u(99), 'backfill', NOW)).toBeNull();
  });

  it('defaults asOf to now', async () => {
    const before = Date.now();
    const record = (await buildOwnershipRecordV2(t.db, V, 'backfill'))!;
    expect(record.version).toBeGreaterThanOrEqual(before);
  });
});

describe('recordHash', () => {
  it('ignores reason, version and asOf', async () => {
    const a = await build('backfill', NOW);
    const b = await build('vendor_edit', new Date(NOW.getTime() + 60_000));
    expect(b.recordHash).toBe(a.recordHash);
  });

  it('does not move with key order', async () => {
    const record = await build();
    const reversed = Object.fromEntries(Object.entries(record).reverse()) as OwnershipRecordV2;
    expect(await computeOwnershipRecordHash(reversed)).toBe(record.recordHash);
  });

  it('does not move with the order D1 returns rows in', async () => {
    const forward = await build();
    const other = await makeTestDb();
    try {
      await seed(other.db, { reverse: true });
      const reversed = (await buildOwnershipRecordV2(other.db, V, 'backfill', NOW))!;
      expect(reversed).toEqual(forward);
    } finally {
      other.dispose();
    }
  });

  it('moves when mirrored content moves, and not when an unmirrored column does', async () => {
    const before = await build();
    await t.db.update(products).set({ adminNotes: 'changed' }).where(eq(products.id, P_MINE));
    await t.db.update(products).set({ reviewCount: 7 }).where(eq(products.id, P_MINE));
    expect((await build()).recordHash).toBe(before.recordHash);
    await t.db
      .update(products)
      .set({ description: 'Edited by the vendor' })
      .where(eq(products.id, P_MINE));
    expect((await build()).recordHash).not.toBe(before.recordHash);
  });
});

// ── Dispatch and the ledger ────────────────────────────────────────────────────

const CONFIGURED: Env = {
  ...TEST_ENV,
  REVIEW_APP_OWNERSHIP_URL: URL_BASE,
  REVIEW_APP_OWNERSHIP_TOKEN: 'tok-review',
};

async function deliver(env: Env) {
  const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  const message = {
    id: 'msg-1',
    timestamp: NOW,
    body: { vendorId: V, reason: 'vendor_edit', enqueuedAt: NOW.toISOString() },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown>;
  await deliverOwnershipSync(env, fakeExecutionContext(), message, {
    fetch: fetchMock as unknown as typeof fetch,
    now: () => NOW,
    dbFor: t.factory,
  });
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const ledger = await t.db.select().from(ownershipSyncDeliveries);
  return { body: init.body as string, ledger };
}

/** The v1 body exactly as AECI-1418 sends it, key order included. */
const V1_BODY = JSON.stringify({
  schemaVersion: 1,
  vendorId: V,
  owner: 'vendor',
  ownedAt: OWNED_AT,
  version: NOW.getTime(),
  asOf: NOW.toISOString(),
  reason: 'vendor_edit',
  products: [
    { id: P_MINE, owner: 'vendor' },
    { id: P_SHARED, owner: 'vendor' },
  ],
  integrations: [
    { id: I_SOURCE, table: 'integrations', owner: 'vendor' },
    { id: I_TARGET, table: 'integrations', owner: 'vendor' },
    { id: E_ENDPOINT, table: 'connector_evidenced_pairs', owner: 'vendor' },
  ],
  proposals: [],
});

describe('REVIEW_APP_MIRROR_SCHEMA dispatch', () => {
  it.each([
    ['unset', undefined],
    ['"1"', '1'],
    ['a typo', 'two'],
  ])('sends the v1 body byte for byte when the flag is %s', async (_, flag) => {
    const { body, ledger } = await deliver({ ...CONFIGURED, REVIEW_APP_MIRROR_SCHEMA: flag });
    expect(body).toBe(V1_BODY);
    expect(ledger[0]).toMatchObject({ schemaVersion: 1, recordHash: null });
  });

  it('buildOwnershipRecord defaults to v1 and builds v2 when asked', async () => {
    expect(JSON.stringify(await buildOwnershipRecord(t.db, V, 'vendor_edit', NOW))).toBe(V1_BODY);
    expect(await buildOwnershipRecord(t.db, V, 'vendor_edit', NOW, 2)).toEqual(
      await buildOwnershipRecordV2(t.db, V, 'vendor_edit', NOW),
    );
  });

  it('sends v2 when the flag is "2" and records schema_version 2 with the hash', async () => {
    const { body, ledger } = await deliver({ ...CONFIGURED, REVIEW_APP_MIRROR_SCHEMA: '2' });
    const sent = OwnershipRecordV2Schema.parse(JSON.parse(body));
    expect(sent.recordHash).toBe(await computeOwnershipRecordHash(sent));
    expect(ledger).toEqual([
      expect.objectContaining({
        vendorId: V,
        reason: 'vendor_edit',
        outcome: 'delivered',
        schemaVersion: 2,
        recordHash: sent.recordHash,
        productCount: 2,
        integrationCount: 3,
      }),
    ]);
  });
});
