import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { CopyFailedError, copyDryRun, copyExecute, LOG_CLASS_TABLES } from './copy';
import { introspect, referencesInto } from './introspect';
import { makeShimDb, type ShimHandle } from './test/d1';
import {
  seedCatalog,
  seedProducts,
  seedProfileAndReview,
  seedSelfRefRequests,
} from './test/seed-fixture';

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

  it('flags no table as WITHOUT ROWID (the copy pages every table by rowid)', async () => {
    const { tablesByName } = await introspect(h.db);
    expect([...tablesByName.values()].filter((t) => t.withoutRowid)).toEqual([]);
  });

  it('no included table references a log-class table in the real schema', async () => {
    const schema = await introspect(h.db);
    const excluded = LOG_CLASS_TABLES.filter((t) => schema.tablesByName.has(t));
    const included = schema.insertOrder.filter((t) => !excluded.includes(t as never));
    expect(referencesInto(schema, included, excluded)).toEqual([]);
  });

  it('every LOG_CLASS_TABLES entry exists in the schema (no stale names)', async () => {
    const { tablesByName } = await introspect(h.db);
    for (const t of LOG_CLASS_TABLES) expect(tablesByName.has(t), t).toBe(true);
  });

  it('referencesInto names an included child of an excluded parent', async () => {
    h.raw
      .prepare(
        'CREATE TABLE zz_child (id TEXT PRIMARY KEY, view_id INTEGER REFERENCES page_views(id))',
      )
      .run();
    const schema = await introspect(h.db);
    expect(referencesInto(schema, ['zz_child', 'products'], ['page_views'])).toEqual([
      { table: 'zz_child', references: ['page_views'] },
    ]);
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

  // ── AECI-1273: log-table exclusion, streaming, and failure reporting ──────────

  function seedPageView(raw: Database.Database, productId: string): void {
    raw
      .prepare(
        "INSERT INTO page_views (path, product_id, created_at) VALUES ('/products/:slug', ?, '2026-10-01T00:00:00.000Z')",
      )
      .run(productId);
  }
  function seedJobRun(raw: Database.Database): void {
    raw
      .prepare(
        "INSERT INTO job_runs (job, started_at) VALUES ('algolia-sync', '2026-10-01T00:00:00.000Z')",
      )
      .run();
  }

  it('clears log-class tables on the destination but does not reload them', async () => {
    seedSource();
    seedPageView(src.raw, 'prod-1');
    seedJobRun(src.raw);
    // The destination's own log rows must go too, or their FKs would block the clear.
    const destIds = seedCatalog(dst.raw);
    seedPageView(dst.raw, destIds.productA);
    seedJobRun(dst.raw);

    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected refusal');
    expect(plan.tables.map((t) => t.table)).not.toContain('page_views');
    expect(plan.excludedTables.find((t) => t.table === 'page_views')).toEqual({
      table: 'page_views',
      sourceRows: 1,
      destRows: 1,
    });
    expect(plan.excludedTables.map((t) => t.table).sort()).toEqual([...LOG_CLASS_TABLES].sort());
    // totalDestRows counts every row the clear deletes, excluded tables included.
    expect(plan.totalDestRows).toBe(
      [...plan.tables, ...plan.excludedTables].reduce((n, t) => n + t.destRows, 0),
    );

    const result = await copyExecute(src.db, dst.db, plan.schema);
    expect(count(dst.raw, 'page_views')).toBe(0);
    expect(count(dst.raw, 'job_runs')).toBe(0);
    expect(count(dst.raw, 'products')).toBe(2);
    expect(result.perTable).not.toHaveProperty('page_views');
    expect(result.excludedTables).toContain('page_views');
    expect(result.inserted).toBe(plan.totalSourceRows);
    expect(count(src.raw, 'page_views')).toBe(1); // the source is only read
  });

  it('reloads log-class tables too when includeLogTables is set', async () => {
    seedSource();
    seedPageView(src.raw, 'prod-1');
    seedJobRun(src.raw);

    const plan = await copyDryRun(src.db, dst.db, { includeLogTables: true });
    if (!plan.ok) throw new Error('unexpected refusal');
    expect(plan.excludedTables).toEqual([]);
    expect(plan.tables.map((t) => t.table)).toContain('page_views');

    const result = await copyExecute(src.db, dst.db, plan.schema, { includeLogTables: true });
    expect(count(dst.raw, 'page_views')).toBe(1);
    expect(count(dst.raw, 'job_runs')).toBe(1);
    expect(result.excludedTables).toEqual([]);
  });

  it('refuses when an included table references an excluded one', async () => {
    const ddl =
      'CREATE TABLE zz_child (id TEXT PRIMARY KEY, view_id INTEGER REFERENCES page_views(id))';
    src.raw.prepare(ddl).run();
    dst.raw.prepare(ddl).run();

    const plan = await copyDryRun(src.db, dst.db);
    expect(plan.ok).toBe(false);
    if (plan.ok || plan.code !== 'EXCLUDED_TABLE_REFERENCED') throw new Error('expected refusal');
    expect(plan.references).toEqual([{ table: 'zz_child', references: ['page_views'] }]);
    expect(plan.messages[0]).toContain('zz_child');

    // Opting in reloads the parent, so the same schema is fine.
    expect((await copyDryRun(src.db, dst.db, { includeLogTables: true })).ok).toBe(true);
  });

  it('streams a table across several pages, never reading more than one page', async () => {
    seedProducts(src.raw, 23);
    let largestRead = 0;
    // Wrap the source so every read reports its size.
    const spySource = {
      prepare: (sql: string) => {
        const wrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
          ({
            bind: (...args: unknown[]) => wrap(stmt.bind(...args)),
            first: (col?: string) => stmt.first(col as string),
            all: async () => {
              const out = await stmt.all();
              largestRead = Math.max(largestRead, out.results.length);
              return out;
            },
          }) as unknown as D1PreparedStatement;
        return wrap(src.db.prepare(sql));
      },
    } as unknown as D1Database;

    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected refusal');
    largestRead = 0; // introspection reads are not table pages
    const result = await copyExecute(spySource, dst.db, plan.schema, { readPage: 4 });

    expect(result.perTable.products).toBe(23);
    expect(count(dst.raw, 'products')).toBe(23);
    expect(largestRead).toBeLessThanOrEqual(4);
  });

  it('restores the self-FK when the table spans several pages', async () => {
    seedSource();
    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected refusal');
    await copyExecute(src.db, dst.db, plan.schema, { readPage: 1 });

    const reqB = dst.raw
      .prepare("SELECT duplicate_of_request_id AS d FROM vendor_requests WHERE id = 'req-B'")
      .get() as { d: string | null };
    expect(reqB.d).toBe('req-A');
  });

  it('reports a mid-reload D1 failure with the stage, table, and rows written', async () => {
    // Nine valid product_vendors rows, then an orphan the destination's FK rejects
    // (prod D1 can hold such rows; the source shim needs FKs off to create one).
    seedProducts(src.raw, 9);
    src.raw
      .prepare(
        "INSERT INTO vendors (id, slug, company_name, promotion_status, created_at, updated_at) VALUES ('ven-1', 'v', 'V', 'promoted', 'x', 'x')",
      )
      .run();
    const link = src.raw.prepare(
      "INSERT INTO product_vendors (product_id, vendor_id, is_primary, created_at) VALUES (?, ?, 1, 'x')",
    );
    for (let i = 1; i <= 9; i++) link.run(`prod-${i}`, 'ven-1');
    src.raw.pragma('foreign_keys = OFF');
    link.run('prod-1', 'ven-missing');
    src.raw.pragma('foreign_keys = ON');

    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected refusal');
    const err = await copyExecute(src.db, dst.db, plan.schema, { readPage: 3 }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(CopyFailedError);
    const f = err as CopyFailedError;
    expect(f.stage).toBe('reload');
    expect(f.table).toBe('product_vendors');
    expect(f.rowsWritten).toBe(9); // three full pages landed before the orphan's page
    expect(f.completedTables).toContain('products');
    expect(f.completedTables).toContain('vendors');
    expect(f.completedTables).not.toContain('product_vendors');
    expect(f.d1Message).toContain('FOREIGN KEY');
    // The partial state the error describes is real: earlier tables are loaded.
    expect(count(dst.raw, 'products')).toBe(9);
    expect(count(dst.raw, 'product_vendors')).toBe(9);
  });

  it('reports a failed clear as stage "clear"', async () => {
    seedSource();
    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected refusal');
    const failingDest = {
      prepare: (sql: string) => dst.db.prepare(sql),
      batch: async () => {
        throw new Error('D1_ERROR: simulated');
      },
    } as unknown as D1Database;

    const err = (await copyExecute(src.db, failingDest, plan.schema).catch(
      (e: unknown) => e,
    )) as CopyFailedError;
    expect(err).toBeInstanceOf(CopyFailedError);
    expect(err.stage).toBe('clear');
    expect(err.table).toBeNull();
    expect(err.completedTables).toEqual([]);
    expect(err.d1Message).toBe('D1_ERROR: simulated');
  });
});
