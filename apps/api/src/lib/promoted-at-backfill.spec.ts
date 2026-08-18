/**
 * `scripts/ops/backfill-products-promoted-at.sql` (AECI-581 / §13 D6) against the
 * in-memory D1 harness — the same engine and migrations a deployed D1 runs.
 *
 * The backfill is EXACT rather than approximate, and §4's correction is why:
 * `POST /api/promote` is D1's only INSERT path into `products`, it sets
 * `promotion_status='promoted'` on both branches, and retraction is a hard
 * delete — so `created_at` IS the first-promote timestamp for every row that
 * exists. These specs hold that claim to its consequences: every row ends up
 * stamped, the stamp equals `created_at`, and a re-run cannot disturb a product
 * promoted in between.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { products } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const BACKFILL_SQL = readFileSync(
  join(process.cwd(), '../../scripts/ops/backfill-products-promoted-at.sql'),
  'utf8',
);

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function runBackfill(): void {
  t.raw
    .prepare(
      BACKFILL_SQL.split('\n')
        .filter((l) => !l.startsWith('--'))
        .join('\n'),
    )
    .run();
}

async function seedLegacyProducts(count: number): Promise<void> {
  await t.db.insert(products).values(
    Array.from({ length: count }, (_, i) => ({
      id: u(i + 1),
      slug: `p${i + 1}`,
      name: `Product ${i + 1}`,
      promotionStatus: 'promoted',
      createdAt: `2026-0${(i % 8) + 1}-15T09:00:00.000Z`,
    })),
  );
}

describe('backfill-products-promoted-at.sql', () => {
  it('stamps every pre-existing row, and the count matches the live product count', async () => {
    await seedLegacyProducts(5);
    expect((await t.db.select().from(products)).every((p) => p.promotedAt === null)).toBe(true);

    runBackfill();

    const rows = await t.db.select().from(products);
    expect(rows).toHaveLength(5);
    expect(rows.filter((p) => p.promotedAt !== null)).toHaveLength(5);
  });

  it('sets promoted_at to created_at exactly', async () => {
    await seedLegacyProducts(5);
    runBackfill();
    for (const p of await t.db.select().from(products)) {
      expect(p.promotedAt).toBe(p.createdAt);
    }
  });

  it('is idempotent, and a re-run cannot disturb a product promoted since', async () => {
    await seedLegacyProducts(2);
    runBackfill();

    // A product promoted after the first backfill: `promoted_at` is its real
    // first-promote instant and is deliberately NOT its `created_at`, which is
    // what the column exists to preserve.
    await t.db.insert(products).values({
      id: u(99),
      slug: 'later',
      name: 'Later',
      promotionStatus: 'promoted',
      createdAt: '2026-08-01T00:00:00.000Z',
      promotedAt: '2026-08-13T12:00:00.000Z',
    });

    runBackfill();

    const later = await t.db.query.products.findFirst({ where: eq(products.id, u(99)) });
    expect(later?.promotedAt).toBe('2026-08-13T12:00:00.000Z');
    expect((await t.db.select().from(products)).filter((p) => p.promotedAt === null)).toHaveLength(
      0,
    );
  });

  it('is a no-op on an empty table', () => {
    expect(() => runBackfill()).not.toThrow();
  });
});
