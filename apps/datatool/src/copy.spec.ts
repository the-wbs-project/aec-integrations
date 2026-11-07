import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { copyDryRun, copyExecute, isD1Overloaded, type Pacer } from './copy';
import { introspect } from './introspect';
import { makeShimDb, type ShimHandle } from './test/d1';
import { seedCatalog, seedProfileAndReview, seedSelfRefRequests } from './test/seed-fixture';

/** Wraps a shim so every D1 query is counted the way the platform counts them: one
 * per `all`/`first`/`run`, one per `batch()` whatever its length. */
function counted(db: D1Database): { db: D1Database; queries: () => number } {
  let n = 0;
  type Inner = D1PreparedStatement;
  const wrap = (stmt: Inner): Inner =>
    ({
      inner: stmt,
      bind: (...args: unknown[]) => wrap(stmt.bind(...args)),
      all: () => (n++, stmt.all()),
      first: (col?: string) => (n++, stmt.first(col as string)),
      run: () => (n++, stmt.run()),
    }) as unknown as Inner;
  const proxy = {
    prepare: (sql: string) => wrap(db.prepare(sql)),
    batch: (stmts: Inner[]) => (
      n++,
      db.batch(stmts.map((s) => (s as unknown as { inner: Inner }).inner))
    ),
  } as unknown as D1Database;
  return { db: proxy, queries: () => n };
}

/** A clock that only moves when the code sleeps, and records every sleep. */
function fakePacer(): Pacer & { sleeps: number[] } {
  let t = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

const OVERLOADED =
  'D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window';

/** Fails the first `failures` destination batches whose first statement matches
 * `match`, the way D1 refuses an overloaded batch: nothing is applied. */
function flakyBatches(
  db: D1Database,
  match: RegExp,
  failures: number,
  message = OVERLOADED,
): { db: D1Database; refused: () => number } {
  let refused = 0;
  const proxy = {
    prepare: (sql: string) => {
      const stmt = db.prepare(sql) as D1PreparedStatement & { __sql?: string };
      const tag = (s: D1PreparedStatement): D1PreparedStatement => {
        (s as D1PreparedStatement & { __sql?: string }).__sql = sql;
        const bind = s.bind.bind(s);
        s.bind = (...args: unknown[]) => tag(bind(...args));
        return s;
      };
      return tag(stmt);
    },
    batch: async (stmts: (D1PreparedStatement & { __sql?: string })[]) => {
      if (refused < failures && match.test(stmts[0]?.__sql ?? '')) {
        refused++;
        throw new Error(message);
      }
      return db.batch(stmts);
    },
  } as unknown as D1Database;
  return { db: proxy, refused: () => refused };
}

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
    const result = await copyExecute(src.db, dst.db, plan, fakePacer());

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
    await copyExecute(src.db, dst.db, plan, fakePacer());

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

  it('streams a table larger than one read page and spends exactly the estimated queries', async () => {
    seedSource();
    const insert = src.raw.prepare('INSERT INTO page_views (path, created_at) VALUES (?, ?)');
    src.raw.transaction(() => {
      for (let i = 0; i < 25_000; i++) insert.run(`/products/p-${i}`, '2026-10-01T00:00:00.000Z');
    })();
    const source = counted(src.db);
    const dest = counted(dst.db);

    const plan = await copyDryRun(source.db, dest.db);
    if (!plan.ok) throw new Error('unexpected schema mismatch');
    const pageViews = plan.tables.find((t) => t.table === 'page_views')!;
    expect(pageViews.readPage).toBeLessThan(25_000); // more than one page
    expect(pageViews.rowsPerStatement).toBeGreaterThan(1); // multi-row INSERTs

    const result = await copyExecute(source.db, dest.db, plan, fakePacer());
    expect(count(dst.raw, 'page_views')).toBe(25_000);
    expect(result.perTable['page_views']).toBe(25_000);
    expect(result.inserted).toBe(plan.totalSourceRows);
    expect(source.queries() + dest.queries()).toBe(plan.estimatedQueries);
    expect(plan.estimatedQueries).toBeLessThan(plan.queryBudget);
  }, 60_000);

  it('rests a full 10 s window after the destination clear, before the first INSERT', async () => {
    seedSource();
    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected schema mismatch');
    const pacer = fakePacer();
    await copyExecute(src.db, dst.db, plan, pacer);
    expect(pacer.sleeps[0]).toBe(10_000);
  });

  it('retries a batch D1 refuses as overloaded, and still mirrors every row', async () => {
    seedSource();
    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected schema mismatch');
    const dest = flakyBatches(dst.db, /^INSERT INTO "products"/, 2);
    const pacer = fakePacer();
    const result = await copyExecute(src.db, dest.db, plan, pacer);

    expect(dest.refused()).toBe(2);
    expect(pacer.sleeps).toContain(2_000);
    expect(pacer.sleeps).toContain(5_000);
    for (const t of plan.tables) {
      expect(count(dst.raw, t.table), t.table).toBe(t.sourceRows);
    }
    expect(result.inserted).toBe(plan.totalSourceRows);
  });

  it('retries an overloaded clear', async () => {
    seedSource();
    seedCatalog(dst.raw);
    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected schema mismatch');
    const dest = flakyBatches(dst.db, /^(UPDATE|DELETE)/, 1);
    await copyExecute(src.db, dest.db, plan, fakePacer());
    expect(dest.refused()).toBe(1);
    expect(count(dst.raw, 'products')).toBe(count(src.raw, 'products'));
  });

  it('gives up after five retries and surfaces the overload error', async () => {
    seedSource();
    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected schema mismatch');
    const dest = flakyBatches(dst.db, /^INSERT INTO "products"/, 99);
    await expect(copyExecute(src.db, dest.db, plan, fakePacer())).rejects.toThrow(
      /D1 DB is overloaded/,
    );
    expect(dest.refused()).toBe(6); // first try + five retries
  });

  it('does not retry an error that is not an overload', async () => {
    seedSource();
    const plan = await copyDryRun(src.db, dst.db);
    if (!plan.ok) throw new Error('unexpected schema mismatch');
    const dest = flakyBatches(
      dst.db,
      /^INSERT INTO "products"/,
      99,
      'D1_ERROR: UNIQUE constraint failed',
    );
    await expect(copyExecute(src.db, dest.db, plan, fakePacer())).rejects.toThrow(/UNIQUE/);
    expect(dest.refused()).toBe(1);
  });
});

describe('isD1Overloaded', () => {
  it('matches every D1 overload variant and nothing else', () => {
    expect(isD1Overloaded(new Error(OVERLOADED))).toBe(true);
    expect(isD1Overloaded(new Error('D1 DB is overloaded. Too many requests queued.'))).toBe(true);
    expect(isD1Overloaded(new Error('D1 DB is overloaded. Requests queued for too long.'))).toBe(
      true,
    );
    expect(
      isD1Overloaded(new Error("D1 DB's isolate exceeded its memory limit and was reset.")),
    ).toBe(false);
    expect(isD1Overloaded(new Error('UNIQUE constraint failed'))).toBe(false);
  });
});
