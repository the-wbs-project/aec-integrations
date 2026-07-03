import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { copyDryRun, copyExecute } from './copy';
import { introspect } from './introspect';
import { makeShimDb, type ShimHandle } from './test/d1';
import { seedCatalog, seedProfileAndReview, seedSelfRefRequests } from './test/seed-fixture';

function count(raw: Database.Database, table: string): number {
  return (raw.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

describe('introspect', () => {
  let h: ShimHandle;
  beforeEach(() => {
    h = makeShimDb();
  });
  afterEach(() => h.dispose());

  it('discovers user tables and excludes d1_migrations + internals', async () => {
    const { tablesByName } = await introspect(h.db);
    const names = [...tablesByName.keys()];
    expect(names).toContain('products');
    expect(names).toContain('vendor_requests');
    expect(names).not.toContain('d1_migrations');
    expect(names.some((n) => n.startsWith('sqlite_'))).toBe(false);
    expect(names.some((n) => n.startsWith('_cf_'))).toBe(false);
  });

  it('orders parents before children (topological insert order)', async () => {
    const { insertOrder } = await introspect(h.db);
    const at = (n: string) => insertOrder.indexOf(n);
    expect(at('products')).toBeLessThan(at('integrations'));
    expect(at('products')).toBeLessThan(at('reviews'));
    expect(at('vendors')).toBeLessThan(at('integrations'));
    expect(at('taxonomy_categories')).toBeLessThan(at('product_categories'));
    expect(at('workflow_instances')).toBeLessThan(at('workflow_transitions'));
    expect(at('vendors')).toBeLessThan(at('profiles')); // profiles -> vendors
  });

  it('detects the vendor_requests self-FK column', async () => {
    const { tablesByName } = await introspect(h.db);
    expect(tablesByName.get('vendor_requests')!.selfRefColumns).toContain(
      'duplicate_of_request_id',
    );
  });
});

describe('copy — full clone, replace/mirror', () => {
  let src: ShimHandle;
  let dst: ShimHandle;
  beforeEach(() => {
    src = makeShimDb();
    dst = makeShimDb();
  });
  afterEach(() => {
    src.dispose();
    dst.dispose();
  });

  function seedSource(): void {
    const ids = seedCatalog(src.raw);
    seedProfileAndReview(src.raw, ids.productA);
    seedSelfRefRequests(src.raw, ids.productA);
  }

  it('dry-run reports per-table counts and writes nothing', async () => {
    seedSource();
    const plan = await copyDryRun(src.db, dst.db);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const products = plan.tables.find((t) => t.table === 'products')!;
    expect(products.sourceRows).toBe(2);
    expect(products.destRows).toBe(0);
    expect(count(dst.raw, 'products')).toBe(0); // untouched by dry-run
  });

  it('mirrors every table into an empty destination, preserving the self-FK', async () => {
    seedSource();
    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected schema mismatch');
    const result = await copyExecute(src.db, dst.db, plan.schema);

    for (const t of plan.tables) {
      expect(count(dst.raw, t.table), t.table).toBe(t.sourceRows);
    }
    expect(result.inserted).toBe(plan.totalSourceRows);

    const reqB = dst.raw
      .prepare("SELECT duplicate_of_request_id AS d FROM vendor_requests WHERE id = 'req-B'")
      .get() as { d: string | null };
    expect(reqB.d).toBe('req-A'); // self-FK restored

    const orphans = dst.raw
      .prepare(
        'SELECT count(*) AS n FROM reviews WHERE product_id NOT IN (SELECT id FROM products)',
      )
      .get() as { n: number };
    expect(orphans.n).toBe(0); // FK integrity
  });

  it('replaces pre-existing destination data (mirror, not merge)', async () => {
    seedSource();
    seedCatalog(dst.raw); // different starting data on dest
    dst.raw
      .prepare(
        `INSERT INTO vendor_requests (id, kind, target_type, target_id, submitter_email, body, created_at)
         VALUES ('dest-only', 'correction', 'vendor', 'x', 'z@example.com', 'stale dest row', '2026-01-01T00:00:00.000Z')`,
      )
      .run();

    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected schema mismatch');
    await copyExecute(src.db, dst.db, plan.schema);

    expect(count(dst.raw, 'vendor_requests')).toBe(count(src.raw, 'vendor_requests'));
    const stale = dst.raw
      .prepare("SELECT count(*) AS n FROM vendor_requests WHERE id = 'dest-only'")
      .get() as { n: number };
    expect(stale.n).toBe(0); // replaced, not merged
  });

  it('aborts with SCHEMA_MISMATCH when columns differ', async () => {
    dst.raw.prepare('ALTER TABLE products ADD COLUMN __drift TEXT').run();
    const plan = await copyDryRun(src.db, dst.db);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe('SCHEMA_MISMATCH');
    expect(plan.messages.join(' ')).toContain('products');
  });
});
