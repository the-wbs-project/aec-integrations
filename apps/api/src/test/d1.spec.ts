import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import {
  auditLog,
  productCategories,
  products,
  productVendors,
  taxonomyCategories,
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
