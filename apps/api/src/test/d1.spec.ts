import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  connectorCatalogs,
  connectorCatalogSurfaces,
  connectorEvidencedPairs,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  integrations,
  productCategories,
  products,
  productTrades,
  productVendors,
  productVersions,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import { auditInsert } from '../lib/audit';
import { productListConfig } from '../lib/drizzle-helpers';
import { makeTestDb, type TestDb } from './d1';

describe('in-memory D1 harness (AECI-253)', () => {
  it('applies the migration: tables exist and start empty', async () => {
    const t = await makeTestDb();
    const rows = await t.db.query.products.findMany();
    expect(rows).toEqual([]);
    t.dispose();
  });

  it('hydrates a product via the relational query builder (vendor + primary category)', async () => {
    const t = await makeTestDb();
    await t.db.insert(vendors).values({ id: 'v1', slug: 'autodesk', companyName: 'Autodesk' });
    await t.db
      .insert(products)
      .values({ id: 'p1', slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await t.db.insert(productVendors).values({ productId: 'p1', vendorId: 'v1', isPrimary: true });
    await t.db
      .insert(taxonomyCategories)
      .values({ id: 'c1', slug: 'bim-authoring', name: 'BIM Authoring', displayOrder: 60 });
    await t.db.insert(productCategories).values({ productId: 'p1', categoryId: 'c1' });

    const [row] = await t.db.query.products.findMany({
      ...productListConfig,
      where: eq(products.id, 'p1'),
    });
    expect(row?.name).toBe('Revit');
    expect(row?.productVendors[0]?.vendor.companyName).toBe('Autodesk');
    expect(row?.productCategories[0]?.category.slug).toBe('bim-authoring');
    t.dispose();
  });

  it('batch() commits all statements atomically (audit-in-tx)', async () => {
    const t = await makeTestDb();
    await t.db.batch([
      t.db
        .insert(products)
        .values({ id: 'p2', slug: 'autocad', name: 'AutoCAD', promotionStatus: 'promoted' }),
      auditInsert(t.db, { actorType: 'system', action: 'product.created', entityId: 'p2' }),
    ]);
    expect((await t.db.select().from(products).where(eq(products.id, 'p2'))).length).toBe(1);
    expect((await t.db.select().from(auditLog)).length).toBe(1);
    t.dispose();
  });

  it('batch() rolls back the whole unit when a statement violates a constraint', async () => {
    const t = await makeTestDb();
    await expect(
      t.db.batch([
        t.db.insert(products).values({
          id: 'p3',
          slug: 'navisworks',
          name: 'Navisworks',
          promotionStatus: 'promoted',
        }),
        // Invalid actor_type → audit_log CHECK violation → the whole batch rolls back.
        auditInsert(t.db, {
          actorType: 'NOT_VALID' as unknown as 'system',
          action: 'product.created',
        }),
      ]),
    ).rejects.toThrow();

    // The state write must NOT have leaked — the §26.1 invariant.
    expect((await t.db.select().from(products).where(eq(products.id, 'p3'))).length).toBe(0);
    t.dispose();
  });
});

// Seed the two products + integration + data_object a claim needs. Returns the
// integration + data_object ids so a test can hang claims off them.
async function seedClaimPrereqs(t: Awaited<ReturnType<typeof makeTestDb>>) {
  await t.db.insert(products).values([
    { id: 'p1', slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: 'p2', slug: 'navisworks', name: 'Navisworks', promotionStatus: 'promoted' },
  ]);
  await t.db
    .insert(integrations)
    .values({ id: 'i1', sourceProductId: 'p1', targetProductId: 'p2' });
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: 'd1', slug: 'rfis', name: 'RFIs', displayOrder: 110, aliases: ['RFI'] });
  return { integrationId: 'i1', dataObjectId: 'd1' };
}

// The harness applies the REAL migration files, so this exercises the hand-authored
// `ALTER … ADD … CHECK` bodies in 0018 rather than a Drizzle-side approximation of them.
describe('maintenance marker columns (AECI-616)', () => {
  const seeds = [
    { table: 'vendors', row: { id: 'v1', slug: 'autodesk', companyName: 'Autodesk' } },
    { table: 'products', row: { id: 'p1', slug: 'revit', name: 'Revit' } },
  ] as const;

  it('defaults maintained_by to aeci and leaves last_reviewed_at NULL on insert', async () => {
    const t = await makeTestDb();
    await t.db.insert(vendors).values(seeds[0].row);
    await t.db.insert(products).values(seeds[1].row);
    await t.db.insert(products).values({ id: 'p2', slug: 'navisworks', name: 'Navisworks' });
    await t.db
      .insert(integrations)
      .values({ id: 'i1', sourceProductId: 'p1', targetProductId: 'p2' });

    // The unreviewed baseline: attribution with no date. NOTHING is backfilled from
    // `created_at` / `updated_at` / `promoted_at` — that is the point of the column.
    const rows = [
      (await t.db.select().from(vendors).where(eq(vendors.id, 'v1')))[0],
      (await t.db.select().from(products).where(eq(products.id, 'p1')))[0],
      (await t.db.select().from(integrations).where(eq(integrations.id, 'i1')))[0],
    ];
    for (const row of rows) {
      expect(row?.maintainedBy).toBe('aeci');
      expect(row?.lastReviewedAt).toBeNull();
    }
    t.dispose();
  });

  it('rejects an out-of-vocabulary maintained_by on all three tables', async () => {
    const t = await makeTestDb();
    await t.db.insert(products).values({ id: 'p2', slug: 'navisworks', name: 'Navisworks' });

    await expect(
      (async () => t.db.insert(vendors).values({ ...seeds[0].row, maintainedBy: 'partner' }))(),
    ).rejects.toThrow();
    await expect(
      (async () => t.db.insert(products).values({ ...seeds[1].row, maintainedBy: 'partner' }))(),
    ).rejects.toThrow();
    await t.db.insert(products).values(seeds[1].row);
    await expect(
      (async () =>
        t.db.insert(integrations).values({
          id: 'i1',
          sourceProductId: 'p1',
          targetProductId: 'p2',
          maintainedBy: 'partner',
        }))(),
    ).rejects.toThrow();
    t.dispose();
  });

  it('does not restamp last_reviewed_at on an unrelated write (no $onUpdate)', async () => {
    const t = await makeTestDb();
    const reviewed = '2026-03-04T00:00:00.000Z';
    // `updated_at` is pinned to a fixed past value rather than left at insert time:
    // `$onUpdate` stamps `Date.now()`, so an insert and update landing in the same
    // millisecond would produce identical strings and make the contrast below flaky.
    const staleUpdatedAt = '2020-01-01T00:00:00.000Z';
    await t.db
      .insert(products)
      .values({ ...seeds[1].row, lastReviewedAt: reviewed, updatedAt: staleUpdatedAt });

    // `updated_at` IS declared `$onUpdate`, so this write moves it. If
    // `last_reviewed_at` moved too, the marker would advertise a review that never
    // happened — which is the entire failure mode AECI-616 exists to prevent.
    await t.db.update(products).set({ name: 'Revit 2026' }).where(eq(products.id, 'p1'));
    const after = (await t.db.select().from(products).where(eq(products.id, 'p1')))[0];

    expect(after?.name).toBe('Revit 2026');
    expect(String(after?.updatedAt) > staleUpdatedAt).toBe(true);
    expect(after?.lastReviewedAt).toBe(reviewed);
    t.dispose();
  });
});

describe('claims / attestations spine (AECI-293)', () => {
  it('hydrates claim → dataObject + attestations, and defaults asserted=true', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' });
    // `asserted` omitted → schema default true; only `aeci` is ever written in 1.5.
    await t.db.insert(attestations).values({ id: 'at1', claimId: 'c1', source: 'aeci' });

    const [row] = await t.db.query.claims.findMany({
      where: eq(claims.id, 'c1'),
      with: { dataObject: true, attestations: true, integration: true },
    });
    expect(row?.direction).toBe('a_to_b');
    expect(row?.dataObject.slug).toBe('rfis');
    expect(row?.dataObject.aliases).toEqual(['RFI']);
    expect(row?.integration.id).toBe('i1');
    expect(row?.attestations).toHaveLength(1);
    expect(row?.attestations[0]?.source).toBe('aeci');
    expect(row?.attestations[0]?.asserted).toBe(true);
    t.dispose();
  });

  it('enforces the (integration_id, data_object_id, direction) claim identity', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' });
    // Same identity, different id → the unique index rejects (the promote upsert target).
    await expect(
      (async () =>
        t.db
          .insert(claims)
          .values({ id: 'c2', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' }))(),
    ).rejects.toThrow();
    // A different direction on the same pair IS a distinct claim.
    await t.db
      .insert(claims)
      .values({ id: 'c3', integrationId: 'i1', dataObjectId: 'd1', direction: 'both' });
    expect((await t.db.select().from(claims)).length).toBe(2);
    t.dispose();
  });

  it('rejects out-of-vocabulary direction and attestation source (CHECK constraints)', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await expect(
      (async () =>
        t.db
          .insert(claims)
          .values({ id: 'cx', integrationId: 'i1', dataObjectId: 'd1', direction: 'sideways' }))(),
    ).rejects.toThrow();
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' });
    await expect(
      (async () =>
        t.db.insert(attestations).values({ id: 'atx', claimId: 'c1', source: 'vendor_c' }))(),
    ).rejects.toThrow();
    t.dispose();
  });

  it('cascades claim→attestations and integration→claims; restricts data_object deletes', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' });
    await t.db.insert(attestations).values({ id: 'at1', claimId: 'c1', source: 'aeci' });

    // A data_object with claims cannot be deleted (onDelete: restrict).
    await expect(
      (async () => t.db.delete(taxonomyDataObjects).where(eq(taxonomyDataObjects.id, 'd1')))(),
    ).rejects.toThrow();

    // Deleting the anchor integration cascades to its claims, and each claim
    // cascades to its attestations.
    await t.db.delete(integrations).where(eq(integrations.id, 'i1'));
    expect((await t.db.select().from(claims)).length).toBe(0);
    expect((await t.db.select().from(attestations)).length).toBe(0);
    t.dispose();
  });

  it('defaults claims.origin to aeci and rejects an out-of-vocabulary origin (AECI-603)', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    // Every claim in D1 today came from promote, so the default IS the backfill.
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' });
    const [row] = await t.db.select().from(claims).where(eq(claims.id, 'c1'));
    expect(row?.origin).toBe('aeci');
    expect(row?.createdByVendorId).toBeNull();

    await expect(
      (async () =>
        t.db.insert(claims).values({
          id: 'cx',
          integrationId: 'i1',
          dataObjectId: 'd1',
          direction: 'both',
          origin: 'partner',
        }))(),
    ).rejects.toThrow();
    t.dispose();
  });

  it('allows one LIVE attestation per (claim, source) and permits retract-then-insert (AECI-603)', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' });
    await t.db.insert(attestations).values({ id: 'at1', claimId: 'c1', source: 'vendor_a' });

    // Second live row in the same slot → the partial unique index rejects. This is what
    // makes two accounts on one vendor last-write-wins instead of stacking votes.
    await expect(
      (async () =>
        t.db.insert(attestations).values({ id: 'at2', claimId: 'c1', source: 'vendor_a' }))(),
    ).rejects.toThrow();
    // The OTHER slot on the same claim is unaffected.
    await t.db.insert(attestations).values({ id: 'at3', claimId: 'c1', source: 'vendor_b' });

    // Supersession is retract-then-insert, never UPDATE — history stays append-only for
    // the §9 timeline, and any number of retracted rows may share a slot.
    await t.db
      .update(attestations)
      .set({ retractedAt: '2026-08-14T00:00:00.000Z' })
      .where(eq(attestations.id, 'at1'));
    await t.db.insert(attestations).values({ id: 'at4', claimId: 'c1', source: 'vendor_a' });
    await t.db
      .update(attestations)
      .set({ retractedAt: '2026-08-15T00:00:00.000Z' })
      .where(eq(attestations.id, 'at4'));
    await t.db.insert(attestations).values({ id: 'at5', claimId: 'c1', source: 'vendor_a' });
    expect((await t.db.select().from(attestations)).length).toBe(4);
    t.dispose();
  });

  it('does NOT gate the slot index on the deprecated_at version stamp (AECI-603)', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' });
    // `deprecated_at` says "this flow existed until v6" (STAGE_1_5_SPEC.md §3.3) — it is
    // a version stamp, not retirement. Stamping it must NOT free the slot, or AECI-303's
    // timeline would lose the row the moment a vendor recorded a deprecation.
    await t.db.insert(attestations).values({
      id: 'at1',
      claimId: 'c1',
      source: 'vendor_a',
      deprecatedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(
      (async () =>
        t.db.insert(attestations).values({ id: 'at2', claimId: 'c1', source: 'vendor_a' }))(),
    ).rejects.toThrow();
    t.dispose();
  });

  it('nulls the vendor provenance FKs on vendor delete rather than losing the row (AECI-603)', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db.insert(vendors).values({ id: 'v1', slug: 'acme', companyName: 'Acme' });
    await t.db.insert(claims).values({
      id: 'c1',
      integrationId: 'i1',
      dataObjectId: 'd1',
      direction: 'a_to_b',
      origin: 'vendor',
      createdByVendorId: 'v1',
    });
    await t.db.insert(attestations).values({
      id: 'at1',
      claimId: 'c1',
      source: 'vendor_a',
      attestedByVendorId: 'v1',
    });

    // ON DELETE SET NULL, not cascade: losing the vendor row must not delete the claim
    // or erase its historical assertion. AECi re-curates the orphan.
    await t.db.delete(vendors).where(eq(vendors.id, 'v1'));
    const [claim] = await t.db.select().from(claims).where(eq(claims.id, 'c1'));
    const [attestation] = await t.db.select().from(attestations).where(eq(attestations.id, 'at1'));
    expect(claim?.createdByVendorId).toBeNull();
    expect(claim?.origin).toBe('vendor');
    expect(attestation?.attestedByVendorId).toBeNull();
    t.dispose();
  });

  it('seed/data-objects.sql materialises exactly the 20-term vocabulary from the JSON mirror', async () => {
    const t = await makeTestDb();
    // Applying the real seed also proves it is valid against the migrated schema.
    const seedSql = readFileSync(join(process.cwd(), 'seed', 'data-objects.sql'), 'utf8');
    t.raw.exec(seedSql);

    const vocab = JSON.parse(
      readFileSync(join(process.cwd(), '..', '..', 'docs', 'data-object-vocabulary.json'), 'utf8'),
    ) as { terms: Array<{ slug: string }> };
    const expected = vocab.terms.map((term) => term.slug).sort();

    const seeded = (await t.db.select().from(taxonomyDataObjects)).map((row) => row.slug).sort();
    expect(seeded).toEqual(expected);
    expect(seeded).toHaveLength(20);
    t.dispose();
  });
});

/**
 * Constraint coverage for Stage 2 migration 2 (AECI-607 / §8.2). These run
 * against the REAL migration files, which is the point: `0017_slim_iron_lad.sql`
 * carries a **hand-authored** body because `drizzle-kit generate` emitted the two
 * `ALTER TABLE attestations ADD … REFERENCES product_versions(id)` statements
 * with no `ON DELETE` clause at all, silently dropping the SET NULL. The
 * "degrades the stamp" case below is the only thing that would catch a
 * regeneration quietly reverting that.
 */
describe('product versions (AECI-607)', () => {
  it('enforces label identity per product, but not across products', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db.insert(productVersions).values({
      id: 'pv1',
      productId: 'p1',
      label: '2026.1',
      sortKey: 20_260_000_100_000,
    });

    // Same label on the SAME product — rejected by product_versions_label_key.
    await expect(
      (async () =>
        t.db
          .insert(productVersions)
          .values({ id: 'pv2', productId: 'p1', label: '2026.1', sortKey: 1 }))(),
    ).rejects.toThrow();

    // Same label on a DIFFERENT product — fine. Two products may both ship a 2026.1.
    await t.db
      .insert(productVersions)
      .values({ id: 'pv3', productId: 'p2', label: '2026.1', sortKey: 20_260_000_100_000 });
    expect(await t.db.select().from(productVersions)).toHaveLength(2);
    t.dispose();
  });

  it('requires sort_key — ordering can never fall back to the label', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    // Raw SQL: the Drizzle types make the omission unrepresentable, and the
    // NOT NULL is what has to hold at the DB layer.
    expect(() =>
      t.raw
        .prepare(
          `INSERT INTO product_versions (id, product_id, label, created_at, updated_at)
           VALUES ('pv1', 'p1', '2026.1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
    t.dispose();
  });

  it('cascades product delete to its versions', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db
      .insert(productVersions)
      .values({ id: 'pv1', productId: 'p1', label: '2026.1', sortKey: 1 });

    await t.db.delete(products).where(eq(products.id, 'p1'));
    expect(await t.db.select().from(productVersions)).toEqual([]);
    t.dispose();
  });

  it('degrades an attestation version stamp to NULL on version delete, keeping the row', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db.insert(productVersions).values([
      { id: 'pv1', productId: 'p1', label: '2026.1', sortKey: 20_260_000_100_000 },
      { id: 'pv2', productId: 'p1', label: '2026.2', sortKey: 20_260_000_200_000 },
    ]);
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' });
    await t.db.insert(attestations).values({
      id: 'at1',
      claimId: 'c1',
      source: 'vendor_a',
      introducedAt: '2026-01-15',
      introducedVersionId: 'pv1',
      deprecatedVersionId: 'pv2',
    });

    // ON DELETE SET NULL — neither cascade nor restrict. Deleting a version must
    // not be rejected and must not erase the vendor's assertion: the attestation
    // survives and falls back to the coarse ISO date stamps (§8.2). Deleting a
    // version is not a back door to deleting an attestation.
    await t.db.delete(productVersions).where(eq(productVersions.id, 'pv1'));

    const [row] = await t.db.select().from(attestations).where(eq(attestations.id, 'at1'));
    expect(row?.introducedVersionId).toBeNull();
    expect(row?.introducedAt).toBe('2026-01-15');
    // The untouched stamp still points at its version.
    expect(row?.deprecatedVersionId).toBe('pv2');
    t.dispose();
  });

  it('hydrates both version stamps through their disambiguated relations', async () => {
    const t = await makeTestDb();
    await seedClaimPrereqs(t);
    await t.db.insert(productVersions).values([
      { id: 'pv1', productId: 'p1', label: '2026.1', sortKey: 20_260_000_100_000 },
      { id: 'pv2', productId: 'p1', label: '2026.2', sortKey: 20_260_000_200_000 },
    ]);
    await t.db
      .insert(claims)
      .values({ id: 'c1', integrationId: 'i1', dataObjectId: 'd1', direction: 'a_to_b' });
    await t.db.insert(attestations).values({
      id: 'at1',
      claimId: 'c1',
      source: 'vendor_a',
      introducedVersionId: 'pv1',
      deprecatedVersionId: 'pv2',
    });

    // Two FKs into one table: without the `relationName` disambiguation these
    // two would collapse into the same relation.
    const [row] = await t.db.query.attestations.findMany({
      where: eq(attestations.id, 'at1'),
      with: { introducedVersion: true, deprecatedVersion: true },
    });
    expect(row?.introducedVersion?.label).toBe('2026.1');
    expect(row?.deprecatedVersion?.label).toBe('2026.2');
    t.dispose();
  });
});

// ---------------------------------------------------------------------------
// Trades facet (AECI-538 / AECI-540)
// ---------------------------------------------------------------------------

/** Apply a real reference-data seed file to the harness DB (multi-statement SQL). */
function applySeedFile(t: TestDb, file: string): void {
  const runSql = t.raw.exec.bind(t.raw);
  runSql(readFileSync(join(process.cwd(), 'seed', file), 'utf8'));
}

/**
 * RFC 9562 §5.5 UUIDv5 (SHA-1, name-based). The executable reference for the id
 * convention documented in the `seed/trades.sql` header: a term's id is
 * `uuidv5(slug, TRADE_NAMESPACE)`, and the namespace itself is
 * `uuidv5('https://aecintegrations.com/vocabulary/trade', URL_NS)` — the same
 * construction `seed/data-objects.sql` uses, one vocabulary path along.
 */
function uuidv5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const digest = createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  const b = Buffer.from(digest.subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // version 5
  b[8] = (b[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const TRADE_NAMESPACE = uuidv5('https://aecintegrations.com/vocabulary/trade', URL_NAMESPACE);

interface TradeTerm {
  slug: string;
  name: string;
  description: string;
  display_order: number;
  aliases: string[];
}

describe('taxonomy_trades / product_trades (AECI-540)', () => {
  it('derives the namespace pinned in the seed header', () => {
    // Pinned literally so a bad refactor of `uuidv5()` cannot silently re-mint every id.
    expect(TRADE_NAMESPACE).toBe('af0d33bc-5814-524f-9c6c-cac49b84d5f0');
  });

  it('seed/trades.sql materialises the 34-term vocabulary verbatim from the JSON mirror', async () => {
    const t = await makeTestDb();
    // Applying the real seed also proves it is valid against the migrated schema.
    applySeedFile(t, 'trades.sql');

    const vocab = JSON.parse(
      readFileSync(join(process.cwd(), '..', '..', 'docs', 'trades-vocabulary.json'), 'utf8'),
    ) as { terms: TradeTerm[] };
    expect(vocab.terms).toHaveLength(34);

    const seeded = await t.db.select().from(taxonomyTrades);
    expect(seeded).toHaveLength(34);

    // Every field round-trips, not just the slug: `description` is part of the contract
    // (SEO landing copy) and `aliases` drives find-only promote resolution + Algolia
    // recall, so drift in either is a real defect rather than a cosmetic one.
    const bySlug = new Map(seeded.map((row) => [row.slug, row]));
    for (const term of vocab.terms) {
      const row = bySlug.get(term.slug);
      expect(row, `missing seeded trade: ${term.slug}`).toBeDefined();
      expect(row!.id).toBe(uuidv5(term.slug, TRADE_NAMESPACE));
      expect(row!.name).toBe(term.name);
      expect(row!.description).toBe(term.description);
      expect(row!.displayOrder).toBe(term.display_order);
      expect(row!.aliases).toEqual(term.aliases);
    }
    t.dispose();
  });

  it('re-applying the seed is idempotent (upsert on slug — never duplicates, never deletes)', async () => {
    const t = await makeTestDb();
    applySeedFile(t, 'trades.sql');
    const first = await t.db.select().from(taxonomyTrades);
    applySeedFile(t, 'trades.sql');
    const second = await t.db.select().from(taxonomyTrades);

    expect(second).toHaveLength(first.length);
    expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
    t.dispose();
  });

  it('hydrates product → trade and cascades the taxonomy FK', async () => {
    const t = await makeTestDb();
    await t.db
      .insert(products)
      .values({ id: 'p1', slug: 'revit', name: 'Revit', promotionStatus: 'promoted' });
    await t.db.insert(taxonomyTrades).values({
      id: 't1',
      slug: 'electrical',
      name: 'Electrical',
      description: 'Power distribution, lighting, and electrical systems installation.',
      displayOrder: 80,
      aliases: ['Electric', 'Electrician'],
    });
    await t.db.insert(productTrades).values({ productId: 'p1', tradeId: 't1' });

    const [row] = await t.db.query.products.findMany({
      where: eq(products.id, 'p1'),
      with: { productTrades: { with: { trade: true } } },
    });
    expect(row?.productTrades[0]?.trade.slug).toBe('electrical');
    expect(row?.productTrades[0]?.trade.aliases).toEqual(['Electric', 'Electrician']);

    // Deleting a term cascades its join rows away — which is precisely why the seed
    // is upsert-only and never deletes (TRADES_VOCABULARY.md §3).
    await t.db.delete(taxonomyTrades).where(eq(taxonomyTrades.id, 't1'));
    expect((await t.db.select().from(productTrades)).length).toBe(0);
    t.dispose();
  });
});

// ---------------------------------------------------------------------------
// Connector lane (AECI-714) — the constraints that exist ONLY in SQL.
//
// Everything here is unreachable from a Zod schema or a TypeScript type: partial
// indexes, CHECK expressions, and the ON DELETE actions drizzle-kit is known to drop
// silently on ADD COLUMN (docs/migrations.md §0). The harness applies the real
// migration files, so these assert the shipped DDL rather than the schema literal.
// ---------------------------------------------------------------------------
describe('connector lane (AECI-714)', () => {
  /** A promoted product + a catalogue hanging off it, the minimum this lane needs. */
  async function seedCatalog(t: TestDb, opts: { catalogId?: string } = {}) {
    const catalogId = opts.catalogId ?? 'cat1';
    await t.db
      .insert(products)
      .values({ id: 'conn1', slug: 'mindcloud', name: 'MindCloud', productRole: 'connector' });
    await t.db.insert(connectorCatalogs).values({ id: catalogId, connectorProductId: 'conn1' });
    return catalogId;
  }

  const stubStamps = {
    firstSeenAt: '2026-08-27T06:10:37.867Z',
    lastSeenAt: '2026-08-27T06:11:54.977Z',
  };

  it('defaults managed_by to review — every catalogue starts review-authored (AECI-720)', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    const [row] = await t.db.select().from(connectorCatalogs);
    expect(row?.managedBy).toBe('review');
    t.dispose();
  });

  it('scopes stub identity to the catalogue — `adp` on two iPaaS are two listings', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await t.db
      .insert(products)
      .values({ id: 'conn2', slug: 'zapier', name: 'Zapier', productRole: 'connector' });
    await t.db.insert(connectorCatalogs).values({ id: 'cat2', connectorProductId: 'conn2' });

    await t.db
      .insert(connectorStubs)
      .values({ id: 's1', catalogId: 'cat1', slug: 'adp', ...stubStamps });
    // Same slug, different catalogue — allowed, and the whole reason the unique index
    // is (catalog_id, slug) rather than slug alone.
    await t.db
      .insert(connectorStubs)
      .values({ id: 's2', catalogId: 'cat2', slug: 'adp', ...stubStamps });
    expect((await t.db.select().from(connectorStubs)).length).toBe(2);

    await expect(
      t.db
        .insert(connectorStubs)
        .values({ id: 's3', catalogId: 'cat1', slug: 'adp', ...stubStamps }),
    ).rejects.toThrow();
    t.dispose();
  });

  it('allows many mapped products per stub, but only ONE stub-level decision', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await t.db
      .insert(connectorStubs)
      .values({ id: 's1', catalogId: 'cat1', slug: 'procore', ...stubStamps });
    await t.db.insert(products).values([
      { id: 'pm', slug: 'procore-pm', name: 'Procore Project Management' },
      { id: 'pf', slug: 'procore-financials', name: 'Procore Project Financials' },
    ]);

    // Many-to-many is the point of AECI-719: one listing, several of our SKUs.
    await t.db.insert(connectorStubMappings).values([
      {
        id: 'm1',
        stubId: 's1',
        catalogId: 'cat1',
        productId: 'pm',
        status: 'mapped',
        decidedBy: 'chris',
      },
      {
        id: 'm2',
        stubId: 's1',
        catalogId: 'cat1',
        productId: 'pf',
        status: 'mapped',
        decidedBy: 'chris',
      },
    ]);
    expect((await t.db.select().from(connectorStubMappings)).length).toBe(2);

    // SQLite treats NULLs as DISTINCT, so the (stub_id, product_id) unique index does
    // NOT make the decision a singleton — the partial index does.
    await t.db
      .insert(connectorStubs)
      .values({ id: 's2', catalogId: 'cat1', slug: 'acme', ...stubStamps });
    await t.db
      .insert(connectorStubMappings)
      .values({ id: 'm3', stubId: 's2', catalogId: 'cat1', status: 'no_record' });
    await expect(
      t.db
        .insert(connectorStubMappings)
        .values({ id: 'm4', stubId: 's2', catalogId: 'cat1', status: 'ambiguous_parked' }),
    ).rejects.toThrow();
    t.dispose();
  });

  it('lets a product be deleted even when two mapped rows point at it (the SET NULL trap)', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await t.db
      .insert(connectorStubs)
      .values({ id: 's1', catalogId: 'cat1', slug: 'procore', ...stubStamps });
    await t.db.insert(products).values({ id: 'pm', slug: 'procore-pm', name: 'Procore PM' });
    await t.db
      .insert(connectorStubs)
      .values({ id: 's2', catalogId: 'cat1', slug: 'procore-2', ...stubStamps });
    await t.db.insert(connectorStubMappings).values([
      {
        id: 'm1',
        stubId: 's1',
        catalogId: 'cat1',
        productId: 'pm',
        status: 'mapped',
        decidedBy: 'chris',
      },
      {
        id: 'm2',
        stubId: 's2',
        catalogId: 'cat1',
        productId: 'pm',
        status: 'mapped',
        decidedBy: 'chris',
      },
    ]);

    // THIS is why the decision index is keyed on `status` and not on `product_id IS
    // NULL`: ON DELETE SET NULL nulls both rows at once, and a null-keyed partial
    // index would collide and make the product delete fail outright.
    await t.db.delete(products).where(eq(products.id, 'pm'));
    const rows = await t.db.select().from(connectorStubMappings);
    expect(rows.length).toBe(2);
    // The decision trail outlives the product — visible as an orphan, not tidied away.
    expect(rows.every((r) => r.productId === null && r.status === 'mapped')).toBe(true);
    t.dispose();
  });

  it('enforces the canonical pair ordering rather than trusting the caller', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await t.db.insert(connectorStubs).values([
      { id: 'sa', catalogId: 'cat1', slug: 'acumatica', ...stubStamps },
      { id: 'sb', catalogId: 'cat1', slug: 'procore', ...stubStamps },
    ]);
    await t.db
      .insert(connectorPairs)
      .values({ id: 'pr1', catalogId: 'cat1', stubAId: 'sa', stubBId: 'sb', ...stubStamps });

    // The vendor publishes both directions as separate pages; without the CHECK the
    // reversed row inserts happily and the unique index never sees the collision.
    await expect(
      t.db
        .insert(connectorPairs)
        .values({ id: 'pr2', catalogId: 'cat1', stubAId: 'sb', stubBId: 'sa', ...stubStamps }),
    ).rejects.toThrow();
    expect((await t.db.select().from(connectorPairs))[0]?.surface).toBe('unknown');
    t.dispose();
  });

  it('cascades a catalogue delete through stubs, mappings and pairs', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await t.db.insert(connectorCatalogSurfaces).values({
      id: 'sf1',
      catalogId: 'cat1',
      surfaceRole: 'apps',
      indexKind: 'sitemap',
      indexUrl: 'https://mindcloud.co/apps/sitemap.xml',
    });
    await t.db.insert(connectorStubs).values([
      { id: 'sa', catalogId: 'cat1', slug: 'acumatica', ...stubStamps },
      { id: 'sb', catalogId: 'cat1', slug: 'procore', ...stubStamps },
    ]);
    await t.db
      .insert(connectorPairs)
      .values({ id: 'pr1', catalogId: 'cat1', stubAId: 'sa', stubBId: 'sb', ...stubStamps });
    await t.db
      .insert(connectorStubMappings)
      .values({ id: 'm1', stubId: 'sa', catalogId: 'cat1', status: 'out_of_scope' });

    await t.db.delete(connectorCatalogs).where(eq(connectorCatalogs.id, 'cat1'));
    expect((await t.db.select().from(connectorCatalogSurfaces)).length).toBe(0);
    expect((await t.db.select().from(connectorStubs)).length).toBe(0);
    expect((await t.db.select().from(connectorPairs)).length).toBe(0);
    expect((await t.db.select().from(connectorStubMappings)).length).toBe(0);
    t.dispose();
  });

  it('rejects every out-of-vocabulary connector-lane enum value', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await t.db
      .insert(connectorStubs)
      .values({ id: 's1', catalogId: 'cat1', slug: 'adp', ...stubStamps });

    await expect(
      t.db
        .update(connectorCatalogs)
        .set({ managedBy: 'partner' })
        .where(eq(connectorCatalogs.id, 'cat1')),
    ).rejects.toThrow();
    await expect(
      t.db
        .insert(connectorStubMappings)
        .values({ id: 'm1', stubId: 's1', catalogId: 'cat1', status: 'pending' }),
    ).rejects.toThrow();
    await expect(
      t.db.insert(connectorStubMappings).values({
        id: 'm2',
        stubId: 's1',
        catalogId: 'cat1',
        status: 'mapped',
        confidence: 'certain',
      }),
    ).rejects.toThrow();
    t.dispose();
  });

  it('deliberately ACCEPTS unfamiliar scraper vocabulary — those columns are uncontrained', async () => {
    const t = await makeTestDb();
    await seedCatalog(t);
    await t.db
      .insert(connectorStubs)
      .values({ id: 's1', catalogId: 'cat1', slug: 'adp', ...stubStamps });

    // The inverse of the test above, and the more valuable half: `surface_role`,
    // `index_kind` and `direction_role` carry NO CHECK, on purpose. They are scraper
    // vocabulary with a demonstrated history of moving (the review app added `all`
    // only after the 2026-08-27 Aquifer/Kroo survey), and a CHECK change on D1 is a
    // destructive table recreate. If someone "tightens" these later, this test is
    // what tells them it was a decision rather than an omission.
    await t.db.insert(connectorCatalogSurfaces).values({
      id: 'sf',
      catalogId: 'cat1',
      surfaceRole: 'partner-directory',
      indexKind: 'graphql',
    });
    await t.db
      .update(connectorStubs)
      .set({ directionRole: 'inbound' })
      .where(eq(connectorStubs.id, 's1'));
    expect((await t.db.select().from(connectorCatalogSurfaces))[0]?.surfaceRole).toBe(
      'partner-directory',
    );
    t.dispose();
  });

  it('refuses an evidenced pair whose connector is one of its own endpoints (§13.2a)', async () => {
    const t = await makeTestDb();
    await t.db.insert(products).values([
      { id: 'aqu', slug: 'aquifer', name: 'Aquifer', productRole: 'connector' },
      { id: 'zzz', slug: 'sage-300', name: 'Sage 300' },
    ]);

    // Review-side Convention A stores "product X ships a connector on platform C" as
    // ONE edge whose powered_by IS an endpoint — ~152 of the 308 iPaaS rows. Those
    // stay in the DIRECT list; letting one in renders "Via Aquifer → Aquifer".
    await expect(
      t.db.insert(connectorEvidencedPairs).values({
        id: 'e1',
        connectorProductId: 'aqu',
        productAId: 'aqu',
        productBId: 'zzz',
      }),
    ).rejects.toThrow();
    t.dispose();
  });

  it('canonicalises the evidenced pair and keeps orientation on `direction`', async () => {
    const t = await makeTestDb();
    await t.db.insert(products).values([
      { id: 'aaa', slug: 'acumatica', name: 'Acumatica' },
      { id: 'bbb', slug: 'procore', name: 'Procore' },
      { id: 'ccc', slug: 'agave', name: 'Agave', productRole: 'connector' },
    ]);

    await t.db.insert(connectorEvidencedPairs).values({
      id: 'e1',
      connectorProductId: 'ccc',
      productAId: 'aaa',
      productBId: 'bbb',
      direction: 'a_to_b',
      listingUrl: 'https://useagave.com/integrations/procore',
    });
    const [row] = await t.db.select().from(connectorEvidencedPairs);
    expect(row?.maintainedBy).toBe('aeci');
    expect(row?.lastReviewedAt).toBeNull();

    // Reversed endpoints would defeat per-connector pair uniqueness.
    await expect(
      t.db
        .insert(connectorEvidencedPairs)
        .values({ id: 'e2', connectorProductId: 'ccc', productAId: 'bbb', productBId: 'aaa' }),
    ).rejects.toThrow();
    // Same pair, same connector — the uniqueness this table exists to express.
    await expect(
      t.db
        .insert(connectorEvidencedPairs)
        .values({ id: 'e3', connectorProductId: 'ccc', productAId: 'aaa', productBId: 'bbb' }),
    ).rejects.toThrow();
    // `direction` reuses claims' vocabulary rather than inventing a second one.
    await expect(
      t.db.insert(connectorEvidencedPairs).values({
        id: 'e4',
        connectorProductId: 'ccc',
        productAId: 'aaa',
        productBId: 'bbb',
        direction: 'one-way',
      }),
    ).rejects.toThrow();
    t.dispose();
  });
});
