import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  integrations,
  productCategories,
  products,
  productVendors,
  taxonomyCategories,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { auditInsert } from '../lib/audit';
import { productListConfig } from '../lib/drizzle-helpers';
import { makeTestDb } from './d1';

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
