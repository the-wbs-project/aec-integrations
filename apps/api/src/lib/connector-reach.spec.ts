/**
 * The reachable-tier read (AECI-892 / `STAGE_1_5_SPEC.md` §13.7), against the
 * in-memory D1 harness.
 *
 * Five of these are regressions against a specific way this number can be wrong
 * while still looking like a number, which is the whole hazard with a derived
 * count nobody can eyeball:
 *
 *  1. **Both sides of the canonical pair resolve.** `connector_pairs` stores
 *     `stub_a_id < stub_b_id`, so roughly half of any product's reach sits on
 *     the b side. A one-branch read returns a plausible, halved number.
 *  2. **No `surface` predicate.** All 669 of Kroo Connector's and Trimble
 *     AppXchange's pairs are `derived`. A `curated` filter leaking into the count
 *     reports both catalogues as reaching nothing, silently.
 *  3. **The gate is provenance, not confidence** — the same assertion
 *     `admin-connectors.spec.ts` calls its most valuable one, restated here
 *     because this read is the second caller of `publishableMappingOn` and the
 *     two are required to share exactly that predicate.
 *  4. **Editions collapse.** One product can map to two stubs in a catalogue, and
 *     it is one reachable partner either way.
 *  5. **A Convention-A catalogue does not reach its own connector.** Without the
 *     exclusion a product that ships a connector on platform C reads as
 *     "reachable via C, partner C" — the reach analogue of the `Via Aquifer →
 *     Aquifer` group `routeIntegrationLane` clause (a) exists to prevent.
 *
 * The delivered subtraction is NOT tested here. It lives in `toProductDetail`,
 * over the two endpoint arrays, and `products.spec.ts` asserts it end to end —
 * deliberately, because the point of putting it there is that it reuses the
 * arrays rather than re-deriving the delivered set.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  connectorCatalogs,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  products,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

import { reachablePartnerProductIds, reachOnlyPartnerCount } from './connector-reach';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CONNECTOR = u(10);
const PAGE = u(11);
const PARTNER = u(12);
const OTHER = u(13);
const CATALOG = 'cat-agave';

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(products).values([
    { id: CONNECTOR, slug: 'agave-erp-sync', name: 'Agave ERP Sync', productRole: 'connector' },
    { id: PAGE, slug: 'procore', name: 'Procore' },
    { id: PARTNER, slug: 'sage-intacct', name: 'Sage Intacct' },
    { id: OTHER, slug: 'acumatica', name: 'Acumatica' },
  ]);
  await t.db
    .insert(connectorCatalogs)
    .values({ id: CATALOG, connectorProductId: CONNECTOR, connectorAuthorship: 'platform' });
});
afterEach(() => t.dispose());

async function seedStub(id: string, catalogId = CATALOG): Promise<void> {
  await t.db.insert(connectorStubs).values({
    id,
    catalogId,
    slug: id,
    label: id.toUpperCase(),
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-13T00:00:00.000Z',
  });
}

/** A publishable mapping by default: human-decided, `mapped`, product set. */
async function seedMapping(
  id: string,
  stubId: string,
  productId: string,
  over: Partial<typeof connectorStubMappings.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(connectorStubMappings).values({
    id,
    stubId,
    catalogId: CATALOG,
    productId,
    status: 'mapped',
    decidedBy: 'chris',
    decidedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  });
}

async function seedPair(
  id: string,
  stubAId: string,
  stubBId: string,
  over: Partial<typeof connectorPairs.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(connectorPairs).values({
    id,
    catalogId: CATALOG,
    stubAId,
    stubBId,
    surface: 'derived',
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    lastSeenAt: '2026-09-13T00:00:00.000Z',
    ...over,
  });
}

/** The page product on `stub-a`, the partner on `stub-b`, one pair between. */
async function seedReachablePair(): Promise<void> {
  await seedStub('stub-a');
  await seedStub('stub-b');
  await seedMapping('m-page', 'stub-a', PAGE);
  await seedMapping('m-partner', 'stub-b', PARTNER);
  await seedPair('p1', 'stub-a', 'stub-b');
}

describe('reachablePartnerProductIds — the two union branches', () => {
  it('resolves a partner sitting on the B side of the canonical pair', async () => {
    await seedReachablePair();
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([PARTNER]);
  });

  it('resolves a partner sitting on the A side, which a one-branch read would drop', async () => {
    // Same pair, page product read from the OTHER end. `stub_a_id < stub_b_id` is
    // a CHECK, so which side a product lands on is an accident of its slug —
    // which is exactly why a single `stub_a_id = ?` branch halves the answer
    // rather than failing.
    await seedReachablePair();
    await expect(reachablePartnerProductIds(t.db, PARTNER)).resolves.toEqual([PAGE]);
  });

  it('returns nothing for a product with no mapping at all', async () => {
    await seedReachablePair();
    await expect(reachablePartnerProductIds(t.db, OTHER)).resolves.toEqual([]);
  });

  it('returns nothing when the product is mapped but the pair row is missing', async () => {
    // Kroo Connector and Trimble AppXchange were in exactly this state until
    // AECI-890: stubs and mappings present, zero pairs. Reach is derivable from
    // the mapping graph but this read deliberately requires the pair row,
    // because `surface` is the publication input and lives only there.
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedMapping('m-page', 'stub-a', PAGE);
    await seedMapping('m-partner', 'stub-b', PARTNER);
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([]);
  });
});

describe('reachablePartnerProductIds — the predicates', () => {
  it('counts a `derived` pair, because the count carries NO surface filter', async () => {
    // The single most load-bearing assertion in the file. Every one of the 669
    // pairs upstream wrote for Kroo Connector and Trimble AppXchange is
    // `derived`, so a `curated` filter here reports both as reaching nothing and
    // logs nothing. §13.7: publication filters to `curated`, the count does not.
    await seedReachablePair();
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([PARTNER]);
  });

  it('counts every other surface too', async () => {
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedStub('stub-c');
    await seedStub('stub-d');
    await seedMapping('m-page', 'stub-a', PAGE);
    await seedMapping('m-partner', 'stub-b', PARTNER);
    await seedMapping('m-other', 'stub-c', OTHER);
    await seedMapping('m-conn', 'stub-d', CONNECTOR);
    await seedPair('p-curated', 'stub-a', 'stub-b', { surface: 'curated' });
    await seedPair('p-generated', 'stub-a', 'stub-c', { surface: 'generated' });
    await seedPair('p-unknown', 'stub-a', 'stub-d', { surface: 'unknown' });
    const ids = await reachablePartnerProductIds(t.db, PAGE);
    // `stub-d` maps to the catalogue's own connector, excluded below.
    expect([...ids].sort()).toEqual([OTHER, PARTNER].sort());
  });

  it('skips a tombstoned pair (`removed_at`)', async () => {
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedMapping('m-page', 'stub-a', PAGE);
    await seedMapping('m-partner', 'stub-b', PARTNER);
    await seedPair('p1', 'stub-a', 'stub-b', { removedAt: '2026-09-12T00:00:00.000Z' });
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([]);
  });

  it('gates on PROVENANCE, not confidence, at both ends of the pair', async () => {
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedStub('stub-c');
    // Page side: low confidence but human-decided. Publishable.
    await seedMapping('m-page', 'stub-a', PAGE, { confidence: 'low' });
    // Partner: high confidence, machine-decided. NOT publishable.
    await seedMapping('m-auto', 'stub-b', PARTNER, {
      confidence: 'high',
      decidedBy: 'auto-name-match',
    });
    // Partner: human-decided. Publishable.
    await seedMapping('m-human', 'stub-c', OTHER, { confidence: 'low' });
    await seedPair('p-auto', 'stub-a', 'stub-b');
    await seedPair('p-human', 'stub-a', 'stub-c');
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([OTHER]);
  });

  it('skips a mapping that is decided but not `mapped`', async () => {
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedMapping('m-page', 'stub-a', PAGE);
    await seedMapping('m-ruled-out', 'stub-b', PARTNER, { status: 'ruled_out' });
    await seedPair('p1', 'stub-a', 'stub-b');
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([]);
  });

  it('never reports the page product as its own partner', async () => {
    // Two stubs, both mapped to the SAME product — a vendor listing two editions
    // of one tool. The pair between them is real and says nothing.
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedMapping('m-1', 'stub-a', PAGE);
    await seedMapping('m-2', 'stub-b', PAGE);
    await seedPair('p1', 'stub-a', 'stub-b');
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([]);
  });

  it("never reports the catalogue's own connector as a partner", async () => {
    // Convention A: "product X ships a connector on platform C" — the reach
    // analogue of `routeIntegrationLane` clause (a). Without the exclusion the
    // page reads "reachable via Agave, partner Agave".
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedMapping('m-page', 'stub-a', PAGE);
    await seedMapping('m-conn', 'stub-b', CONNECTOR);
    await seedPair('p1', 'stub-a', 'stub-b');
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([]);
  });

  it('collapses editions: one partner product mapped to two stubs counts ONCE', async () => {
    // The reason the unit is COUNT(DISTINCT partner product) and not a row count.
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedStub('stub-c');
    await seedMapping('m-page', 'stub-a', PAGE);
    await seedMapping('m-partner-1', 'stub-b', PARTNER);
    await seedMapping('m-partner-2', 'stub-c', PARTNER);
    await seedPair('p1', 'stub-a', 'stub-b');
    await seedPair('p2', 'stub-a', 'stub-c');
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([PARTNER]);
  });

  it('does not pair a mapping from one catalogue with a stub from another', async () => {
    // Both mappings must sit in the pair's OWN catalogue. Without that clause a
    // product mapped in Agave and a product mapped in Zapier would join through
    // whichever pair row happened to name their stubs.
    const OTHER_CATALOG = 'cat-aquifer';
    const OTHER_CONNECTOR = u(14);
    await t.db
      .insert(products)
      .values({ id: OTHER_CONNECTOR, slug: 'aquifer', name: 'Aquifer', productRole: 'connector' });
    await t.db.insert(connectorCatalogs).values({
      id: OTHER_CATALOG,
      connectorProductId: OTHER_CONNECTOR,
      connectorAuthorship: 'platform',
    });
    await seedStub('stub-a');
    await seedStub('stub-b', OTHER_CATALOG);
    await seedMapping('m-page', 'stub-a', PAGE);
    await t.db.insert(connectorStubMappings).values({
      id: 'm-partner',
      stubId: 'stub-b',
      catalogId: OTHER_CATALOG,
      productId: PARTNER,
      status: 'mapped',
      decidedBy: 'chris',
    });
    await seedPair('p1', 'stub-a', 'stub-b');
    await expect(reachablePartnerProductIds(t.db, PAGE)).resolves.toEqual([]);
  });
});

describe('reachOnlyPartnerCount', () => {
  it('subtracts the delivered partners, so "N MORE" means more', () => {
    expect(reachOnlyPartnerCount([PARTNER, OTHER], new Set([PARTNER]))).toBe(1);
  });

  it('is zero when every reachable partner is already delivered', () => {
    expect(reachOnlyPartnerCount([PARTNER, OTHER], new Set([PARTNER, OTHER]))).toBe(0);
  });

  it('ignores delivered partners that are not reachable', () => {
    expect(reachOnlyPartnerCount([PARTNER], new Set([OTHER]))).toBe(1);
  });

  it('is zero for an empty reach set', () => {
    expect(reachOnlyPartnerCount([], new Set([PARTNER]))).toBe(0);
  });
});
