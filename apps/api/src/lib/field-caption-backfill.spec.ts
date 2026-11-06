/**
 * The AECI-1614 backfill (`scripts/ops/2026-11-field-caption-backfill`), run for real
 * against the migrations. `scripts/ops/**` cannot import TypeScript, so this spec is what
 * pins its SQL to the audit shapes the live writers record.
 */

import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  auditLog,
  billingAccounts,
  connectorEvidencedPairs,
  integrations,
  licenses,
  products,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

interface PlanEntry {
  table: string;
  column: string;
  value: string;
  where: string;
}
/** A plain .mjs ops script has no declaration file, so the shape is stated here. */
const script = (await import(
  join(process.cwd(), '../../scripts/ops/2026-11-field-caption-backfill/plan.mjs')
)) as {
  PLAN: PlanEntry[];
  projectionSql: (entry: PlanEntry) => string;
  updateSql: (entry: PlanEntry) => string;
};
const { PLAN: plan, projectionSql, updateSql } = script;

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OLD = '2026-05-01T00:00:00.000Z';
const MID = '2026-06-01T00:00:00.000Z';
const NEW = '2026-07-01T00:00:00.000Z';

let t: TestDb;
let audit = 100;

const row = (over: Partial<typeof auditLog.$inferInsert>) =>
  t.db.insert(auditLog).values({
    id: u(audit++),
    actorType: 'user',
    action: 'product.updated',
    entityType: 'product',
    entityId: u(1),
    createdAt: MID,
    ...over,
  });
const portal = (extra: object = {}) => ({ source: 'vendor-portal', vendorId: u(90), ...extra });

const runAll = () => {
  for (const entry of plan) t.raw.prepare(updateSql(entry)).run();
};
const product = async (id = u(1)) =>
  (await t.db.select().from(products).where(eq(products.id, id)))[0]!;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: u(90), slug: 'acme', companyName: 'Acme' });
  await t.db.insert(products).values([
    { id: u(1), slug: 'one', name: 'One', updatedAt: OLD },
    { id: u(2), slug: 'two', name: 'Two' },
    { id: u(3), slug: 'agave', name: 'Agave', productRole: 'connector' },
  ]);
  await t.db.insert(billingAccounts).values({ id: u(80), vendorId: u(90), name: 'Acme' });
});
afterEach(() => t.dispose());

describe('product stamps', () => {
  it('stamps each group from the vendor audit diff, and leaves updated_at alone', async () => {
    await row({
      beforeState: { description: 'a' },
      afterState: { description: 'b' },
      metadata: portal({ fields: ['description'] }),
    });
    await row({
      createdAt: NEW,
      beforeState: { trade_slugs: [] },
      afterState: { trade_slugs: ['electrical'] },
      metadata: portal({ fields: ['trade_slugs'] }),
    });
    runAll();
    expect(await product()).toMatchObject({
      descriptionEditedAt: MID,
      managedEditedAt: NEW,
      usefulnessEditedAt: null,
      updatedAt: OLD,
    });
  });

  it('ignores an unchanged resend, an AECi write and "Looks right"', async () => {
    await row({
      beforeState: { description: 'same' },
      afterState: { description: 'same' },
      metadata: portal({ fields: ['description'] }),
    });
    await row({
      action: 'product.field_overridden',
      beforeState: { website: 'a' },
      afterState: { website: 'b' },
      metadata: { source: 'admin-moderation' },
    });
    await row({
      action: 'product.updated',
      beforeState: { description: 'a' },
      afterState: { description: 'b' },
      metadata: { source: 'admin-moderation' },
    });
    await row({
      action: 'product.reviewed',
      beforeState: { maintained_by: 'aeci' },
      afterState: { maintained_by: 'vendor' },
      metadata: portal({ reason: 'looks-right' }),
    });
    runAll();
    expect((await product()).descriptionEditedAt).toBeNull();
  });

  it('forgets a usefulness write before a return when no source fences it', async () => {
    await row({
      createdAt: OLD,
      beforeState: { usefulness: null },
      afterState: { usefulness: { audiences: [], phases: [] } },
      metadata: portal(),
    });
    await row({
      beforeState: { maintained_by: 'vendor' },
      afterState: { maintained_by: 'aeci' },
      metadata: { source: 'admin', cause: 'records-returned-to-aeci' },
    });
    runAll();
    expect((await product()).usefulnessEditedAt).toBeNull();
  });

  it('stamps the profile group from website and categories', async () => {
    await row({
      createdAt: OLD,
      beforeState: { website: 'https://a.example' },
      afterState: { website: 'https://b.example' },
      metadata: portal(),
    });
    await row({
      beforeState: { category_slugs: [] },
      afterState: { category_slugs: ['bim'] },
      metadata: portal(),
    });
    runAll();
    expect((await product()).profileEditedAt).not.toBeNull();
    expect((await product()).profileEditedAt).not.toBe(OLD);
  });

  it('forgets writes before a return to AECi, except usefulness behind a source', async () => {
    await t.db
      .update(products)
      .set({ usefulnessSource: 'vendor' })
      .where(eq(products.id, u(1)));
    await row({
      createdAt: OLD,
      beforeState: { description: 'a', usefulness: null },
      afterState: { description: 'b', usefulness: { audiences: [], phases: [] } },
      metadata: portal(),
    });
    await row({
      beforeState: { maintained_by: 'vendor' },
      afterState: { maintained_by: 'aeci' },
      metadata: { source: 'admin', cause: 'records-returned-to-aeci' },
    });
    runAll();
    expect(await product()).toMatchObject({
      descriptionEditedAt: null,
      usefulnessEditedAt: OLD,
    });
  });

  it('never overwrites a live stamp', async () => {
    await t.db
      .update(products)
      .set({ descriptionEditedAt: NEW })
      .where(eq(products.id, u(1)));
    await row({
      beforeState: { description: 'a' },
      afterState: { description: 'b' },
      metadata: portal(),
    });
    runAll();
    expect((await product()).descriptionEditedAt).toBe(NEW);
  });
});

describe('row stamps', () => {
  const owned = {
    id: u(10),
    sourceProductId: u(1),
    targetProductId: u(2),
    builtByVendorId: u(90),
    claimedAt: OLD,
  };
  const rowAudit = (over: Partial<typeof auditLog.$inferInsert>) =>
    row({ action: 'integration.updated', entityType: 'integration', entityId: u(10), ...over });
  const stamp = async () =>
    (
      await t.db
        .select()
        .from(integrations)
        .where(eq(integrations.id, u(10)))
    )[0]!.vendorEditedAt;

  it('reads an owner edit, an owner accept and a create', async () => {
    await t.db.insert(integrations).values(owned);
    await rowAudit({ metadata: portal({ reason: 'owner-edit', fields: ['name'] }) });
    await rowAudit({ createdAt: NEW, metadata: portal({ reason: 'contest-accepted' }) });
    runAll();
    expect(await stamp()).toBe(NEW);
  });

  it('reads the holder’s link, and not another vendor’s or a stranded removal', async () => {
    await t.db.insert(integrations).values(owned);
    await rowAudit({
      action: 'integration.link_set',
      beforeState: { url: null },
      afterState: { url: 'https://a.example' },
      metadata: { source: 'vendor-portal', vendorId: u(91) },
    });
    await rowAudit({
      action: 'integration.link_removed',
      beforeState: { url: 'https://a.example' },
      afterState: { url: null },
      metadata: portal({ connectorPowered: true }),
    });
    runAll();
    expect(await stamp()).toBeNull();
  });

  it('ignores an AECi accept, and any write on an unheld row', async () => {
    await t.db.insert(integrations).values(owned);
    await rowAudit({ metadata: { source: 'admin-moderation', reason: 'contest-accepted' } });
    runAll();
    expect(await stamp()).toBeNull();

    await t.db
      .update(integrations)
      .set({ claimedAt: null })
      .where(eq(integrations.id, u(10)));
    await rowAudit({ metadata: portal({ reason: 'owner-edit', fields: ['name'] }) });
    runAll();
    expect(await stamp()).toBeNull();
  });

  it('forgets writes from before the row last changed hands', async () => {
    await t.db.insert(integrations).values(owned);
    await rowAudit({
      createdAt: OLD,
      metadata: portal({ reason: 'owner-edit', fields: ['name'] }),
    });
    await rowAudit({ metadata: { source: 'admin-moderation', reason: 'owner-approved' } });
    runAll();
    expect(await stamp()).toBeNull();
  });

  it('stamps an evidenced pair from its own entity type', async () => {
    const [a, b] = [u(1), u(2)].sort() as [string, string];
    await t.db.insert(connectorEvidencedPairs).values({
      id: u(11),
      productAId: a,
      productBId: b,
      connectorProductId: u(3),
      builtByVendorId: u(90),
      claimedAt: OLD,
    });
    await row({
      action: 'integration.updated',
      entityType: 'connector_evidenced_pair',
      entityId: u(11),
      metadata: portal({ reason: 'owner-edit', fields: ['name'] }),
    });
    runAll();
    const [pair] = await t.db.select().from(connectorEvidencedPairs);
    expect(pair!.vendorEditedAt).toBe(MID);
  });
});

describe('the mirrors', () => {
  const license = (id: number, over: Partial<typeof licenses.$inferInsert>) =>
    t.db.insert(licenses).values({
      id: u(id),
      billingAccountId: u(80),
      source: 'invoice',
      startsAt: OLD,
      ...over,
    });
  const vendor = async () => (await t.db.select().from(vendors))[0]!;

  it('sets both from the latest ended license when nothing is live', async () => {
    await license(20, { assignedProductId: u(1), endedAt: MID, endReason: 'lapsed' });
    await license(21, { assignedProductId: u(1), endedAt: NEW, endReason: 'lapsed' });
    runAll();
    expect((await product()).managedEndedAt).toBe(NEW);
    expect((await vendor()).planEndedAt).toBe(NEW);
  });

  it('leaves both empty while a license is live, and on a never-licensed record', async () => {
    await license(20, { assignedProductId: u(1), endedAt: MID, endReason: 'lapsed' });
    await license(21, { assignedProductId: u(1) });
    runAll();
    expect((await product()).managedEndedAt).toBeNull();
    expect((await product(u(2))).managedEndedAt).toBeNull();
    expect((await vendor()).planEndedAt).toBeNull();
  });

  it('dates an early unassign from its audit row', async () => {
    await license(20, {});
    await row({
      action: 'license.release_approved',
      entityType: 'billing_account',
      entityId: u(80),
      productId: u(1),
      beforeState: { assigned_product_id: u(1) },
      afterState: { assigned_product_id: null },
      metadata: { source: 'admin-license' },
    });
    runAll();
    expect((await product()).managedEndedAt).toBe(MID);
    expect((await vendor()).planEndedAt).toBeNull();
  });
});

describe('the dry run', () => {
  it('reports what the update would write, and writes nothing', async () => {
    await row({
      beforeState: { description: 'a' },
      afterState: { description: 'b' },
      metadata: portal(),
    });
    const entry = plan.find((e) => e.column === 'description_edited_at')!;
    const result = t.raw.prepare(projectionSql(entry)).get() as {
      would_write: number;
      latest: string;
    };
    expect(result).toMatchObject({ would_write: 1, latest: MID });
    expect((await product()).descriptionEditedAt).toBeNull();
  });
});
