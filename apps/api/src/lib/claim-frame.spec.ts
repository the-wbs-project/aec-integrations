/**
 * AECI-996 — the reframe planner and its two renderers.
 *
 * Promote runs the Drizzle renderer; the one-time repair runs `renderReframeSql`. Both
 * consume the same ops, and this spec is what holds them to the same end state against
 * a real migrated schema, on the two collisions a naive flip cannot survive.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  attestations,
  claims,
  connectorEvidencedPairs,
  products,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { planClaimReframe, renderReframeSql } from './claim-frame';
import { loadReframeClaims, reframeStatements } from './promote-claims';

const u = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const PAIR = u(50);
const RETRACTED = '2026-09-01T00:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await seed(t);
});
afterEach(() => t.dispose());

async function seed(db: TestDb) {
  await db.db.insert(products).values([
    { id: u(1), slug: 'a', name: 'A', promotionStatus: 'promoted' },
    { id: u(2), slug: 'b', name: 'B', promotionStatus: 'promoted' },
    { id: u(3), slug: 'c', name: 'C', promotionStatus: 'promoted', productRole: 'connector' },
  ]);
  await db.db.insert(vendors).values([
    { id: u(6), slug: 'v6', companyName: 'V6', promotionStatus: 'promoted' },
    { id: u(7), slug: 'v7', companyName: 'V7', promotionStatus: 'promoted' },
  ]);
  await db.db.insert(taxonomyDataObjects).values([
    { id: u(20), slug: 'rfis', name: 'RFIs' },
    { id: u(21), slug: 'drawings', name: 'Drawings' },
  ]);
  await db.db.insert(connectorEvidencedPairs).values({
    id: PAIR,
    connectorProductId: u(3),
    productAId: u(1),
    productBId: u(2),
  });
  await db.db.insert(claims).values([
    // rfis: both one-way claims (collision); X is vendor-origin so contents differ.
    {
      id: u(30),
      connectorEvidencedPairId: PAIR,
      dataObjectId: u(20),
      direction: 'a_to_b',
      origin: 'vendor',
      createdByVendorId: u(6),
    },
    { id: u(31), connectorEvidencedPairId: PAIR, dataObjectId: u(20), direction: 'b_to_a' },
    // drawings: a lone one-way claim and a `both`.
    { id: u(32), connectorEvidencedPairId: PAIR, dataObjectId: u(21), direction: 'b_to_a' },
    { id: u(33), connectorEvidencedPairId: PAIR, dataObjectId: u(21), direction: 'both' },
  ]);
  await db.db.insert(attestations).values([
    { id: u(40), claimId: u(30), source: 'aeci' },
    { id: u(41), claimId: u(30), source: 'vendor_a', attestedByVendorId: u(6), note: 'x-a' },
    {
      id: u(42),
      claimId: u(30),
      source: 'vendor_b',
      attestedByVendorId: u(7),
      retractedAt: RETRACTED,
    },
    { id: u(43), claimId: u(31), source: 'aeci', asserted: false },
    // Both live vendor slots on one claim: the `attestations_slot_key` collision.
    { id: u(44), claimId: u(32), source: 'vendor_a', attestedByVendorId: u(6), note: 'd-a' },
    { id: u(45), claimId: u(32), source: 'vendor_b', attestedByVendorId: u(7), note: 'd-b' },
  ]);
}

/** Meaning, not row ids: what each (data object, direction) asserts, and who attests. */
async function meaning(db: TestDb) {
  const rows = await loadReframeClaims(db.db, PAIR);
  return rows
    .map((c) => ({
      key: `${c.dataObjectId}|${c.direction}`,
      origin: c.origin,
      createdByVendorId: c.createdByVendorId,
      attestations: c.attestations
        .map((a) => [a.source, a.attestedByVendorId, a.note, a.asserted, a.retractedAt].join('|'))
        .sort(),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const flipKey = (key: string) =>
  key.replace(/\|(a_to_b|b_to_a)$/, (_, d: string) => `|${d === 'a_to_b' ? 'b_to_a' : 'a_to_b'}`);
const flipSlot = (row: string) =>
  row.replace(/^vendor_(a|b)\|/, (_, s: string) => `vendor_${s === 'a' ? 'b' : 'a'}|`);

async function applyWithDrizzle(db: TestDb) {
  const plan = planClaimReframe(await loadReframeClaims(db.db, PAIR));
  const [first, ...rest] = reframeStatements(db.db, plan.ops).statements;
  await db.db.batch([first!, ...rest]);
  return plan;
}

describe('planClaimReframe (AECI-996)', () => {
  it('reports every collision it resolves by swapping contents', async () => {
    const plan = planClaimReframe(await loadReframeClaims(t.db, PAIR));
    expect(plan.collisions).toEqual([
      { kind: 'claim', dataObjectId: u(20), claimIds: [u(30), u(31)] },
      // The two rfis claims each hold a live `aeci` slot, so their contents trade too.
      { kind: 'attestation', claimId: u(30), attestationIds: [u(40), u(43)] },
      { kind: 'attestation', claimId: u(32), attestationIds: [u(44), u(45)] },
    ]);
  });

  it('lands the same meaning through the Drizzle renderer and the SQL renderer', async () => {
    const expected = (await meaning(t))
      .map((c) => ({
        ...c,
        key: flipKey(c.key),
        attestations: c.attestations.map(flipSlot).sort(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    await applyWithDrizzle(t);
    expect(await meaning(t)).toEqual(expected);

    const other = await makeTestDb();
    try {
      await seed(other);
      const plan = planClaimReframe(await loadReframeClaims(other.db, PAIR));
      // One statement at a time, the way SQLite checks the unique indexes.
      for (const stmt of renderReframeSql(plan.ops, '2026-09-18T00:00:00.000Z')) {
        other.raw.prepare(stmt).run();
      }
      expect(await meaning(other)).toEqual(expected);
    } finally {
      other.dispose();
    }
  });

  it('keeps every row id, and the database matches the plan’s own `after`', async () => {
    const snapshot = await loadReframeClaims(t.db, PAIR);
    const plan = await applyWithDrizzle(t);
    const strip = (rows: typeof snapshot) =>
      rows
        .map((c) => ({
          id: c.id,
          direction: c.direction,
          origin: c.origin,
          attestations: c.attestations
            .map((a) => `${a.id}|${a.source}|${a.attestedByVendorId}|${a.retractedAt}`)
            .sort(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(strip(await loadReframeClaims(t.db, PAIR))).toEqual(strip(plan.after));
    expect(strip(plan.after).map((c) => c.id)).toEqual(strip(snapshot).map((c) => c.id));
  });

  it('is its own inverse', async () => {
    const before = await meaning(t);
    await applyWithDrizzle(t);
    await applyWithDrizzle(t);
    expect(await meaning(t)).toEqual(before);
  });
});
