import { createHash } from 'node:crypto';
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
  productTrades,
  productVendors,
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
