/**
 * `readPairCounterpartSlugs` — the four orientations (AECI-944).
 *
 * Two INVARIANTS, both of which fail silently:
 *
 *   1. **Both delivered-tier tables are read.** 19 production pairs live only in
 *      `connector_evidenced_pairs` (§13.1 / AECI-721). A reader that queried
 *      `integrations` alone would return a short list, the caller would announce
 *      fewer pages than it purged, and nothing would report the gap.
 *   2. **Both orientations of each table are read.** `integrations` stores the
 *      edge either way round, and `connector_evidenced_pairs` is canonical by
 *      CHECK — so the product we hold can be on either side of that ordering
 *      too. Missing one orientation loses roughly half the pages, silently.
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { connectorEvidencedPairs, integrations, products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

import { readPairCounterpartSlugs } from './product-pair-slugs';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Ids are ordered on purpose: `connector_evidenced_pairs` CHECKs
// `product_a_id < product_b_id`, so a fixture has to respect it.
const SUBJECT = u(50);
const LOWER = u(10);
const HIGHER = u(90);
const CONNECTOR = u(99);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(products).values([
    { id: SUBJECT, slug: 'procore', name: 'Procore' },
    { id: LOWER, slug: 'autodesk-build', name: 'Autodesk Build' },
    { id: HIGHER, slug: 'sage-300', name: 'Sage 300' },
    { id: CONNECTOR, slug: 'agave', name: 'Agave' },
  ]);
});
afterEach(() => t.dispose());

describe('readPairCounterpartSlugs', () => {
  it('finds an `integrations` edge in either orientation', async () => {
    await t.db.insert(integrations).values([
      { id: u(1), sourceProductId: SUBJECT, targetProductId: LOWER },
      { id: u(2), sourceProductId: HIGHER, targetProductId: SUBJECT },
    ]);

    const slugs = await readPairCounterpartSlugs(t.db, SUBJECT);
    expect(slugs.sort()).toEqual(['autodesk-build', 'sage-300']);
  });

  it('finds a `connector_evidenced_pairs` edge from either side of the canonical order', async () => {
    await t.db.insert(connectorEvidencedPairs).values([
      // SUBJECT is the B side here (LOWER < SUBJECT).
      { id: u(3), connectorProductId: CONNECTOR, productAId: LOWER, productBId: SUBJECT },
      // …and the A side here (SUBJECT < HIGHER).
      { id: u(4), connectorProductId: CONNECTOR, productAId: SUBJECT, productBId: HIGHER },
    ]);

    const slugs = await readPairCounterpartSlugs(t.db, SUBJECT);
    expect(slugs.sort()).toEqual(['autodesk-build', 'sage-300']);
  });

  it('collapses a counterpart reachable through both tables to one slug', async () => {
    // One page, two storage rows. Announcing it twice would be one wasted
    // worklist row, and the `url` unique index would merge them anyway.
    await t.db
      .insert(integrations)
      .values({ id: u(5), sourceProductId: SUBJECT, targetProductId: HIGHER });
    await t.db.insert(connectorEvidencedPairs).values({
      id: u(6),
      connectorProductId: CONNECTOR,
      productAId: SUBJECT,
      productBId: HIGHER,
    });

    expect(await readPairCounterpartSlugs(t.db, SUBJECT)).toEqual(['sage-300']);
  });

  it('collapses several `integrations` edges between the same two products', async () => {
    await t.db.insert(integrations).values([
      { id: u(7), sourceProductId: SUBJECT, targetProductId: LOWER, name: 'REST' },
      { id: u(8), sourceProductId: LOWER, targetProductId: SUBJECT, name: 'Webhook' },
    ]);

    expect(await readPairCounterpartSlugs(t.db, SUBJECT)).toEqual(['autodesk-build']);
  });

  it('returns an empty list for a product on no pair page', async () => {
    expect(await readPairCounterpartSlugs(t.db, SUBJECT)).toEqual([]);
  });

  it('never returns the subject itself', async () => {
    await t.db
      .insert(integrations)
      .values({ id: u(9), sourceProductId: SUBJECT, targetProductId: LOWER });

    expect(await readPairCounterpartSlugs(t.db, SUBJECT)).not.toContain('procore');
  });
});
