/**
 * The Google re-crawl buffer and its priority tiers (AECI-945 / §20.2).
 *
 * Four INVARIANTS, each guarding a failure that is silent in production:
 *
 *   1. **A conflict RAISES priority and never lowers it.** Under `DO NOTHING` a
 *      page that had a logo swap and was then renamed would keep tier 4 and stay
 *      buried in a list the operator never reaches. That is indistinguishable
 *      from never having queued it, and nothing would report it.
 *   2. **A conflict PRESERVES `queued_at`.** Ordering inside a tier is
 *      oldest-first, so refreshing the timestamp would let a page someone keeps
 *      editing starve an older one indefinitely.
 *   3. **Chunking is 20 rows, not 33.** D1 caps a query at 100 bound parameters
 *      and this table binds five columns. The in-memory harness binds 32,766
 *      happily, so only a parameter-count assertion catches a wrong constant —
 *      a behavioural test passes either way and fails in production.
 *   4. **The tier map is exhaustive over the reason union.** A reason with no
 *      tier would sort as `undefined`, which SQLite would reject on a NOT NULL
 *      column at the worst moment.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gscRecrawlQueue } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

import {
  dedupeByBestPriority,
  GSC_RECRAWL_MAX_PRIORITY,
  GSC_RECRAWL_MIN_PRIORITY,
  GSC_RECRAWL_PRIORITY,
  gscRecrawlPriority,
  type GscRecrawlReason,
} from './gsc-recrawl-priority';
import {
  countPendingGscRecrawl,
  enqueueGscRecrawl,
  GSC_RECRAWL_INSERT_ROWS_PER_STATEMENT,
  gscRecrawlInsertStatements,
  readPendingGscRecrawl,
} from './gsc-recrawl-queue';

const BASE = 'https://www.aecintegrations.com';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const rowFor = (url: string) =>
  t.db
    .select()
    .from(gscRecrawlQueue)
    .where(eq(gscRecrawlQueue.url, url))
    .then((rows) => rows[0]);

// ─── The tier map ────────────────────────────────────────────────────────────

describe('GSC_RECRAWL_PRIORITY — the tiers', () => {
  it('puts a new product page alone in tier 1', () => {
    expect(gscRecrawlPriority('product.created')).toBe(1);
    const tierOne = Object.entries(GSC_RECRAWL_PRIORITY).filter(([, p]) => p === 1);
    expect(tierOne.map(([reason]) => reason)).toEqual(['product.created']);
  });

  it('sits a vendor page exactly one tier below the same event on a product', () => {
    // This is the rule the four-tier scheme exists to express. A formula would
    // reproduce it, but `trade.published` is already an exception to the formula,
    // which is why the map is a map.
    expect(gscRecrawlPriority('vendor.created') - gscRecrawlPriority('product.created')).toBe(1);
    expect(gscRecrawlPriority('vendor.updated') - gscRecrawlPriority('product.updated')).toBe(1);
  });

  it('ranks every minor edit into the bottom tier', () => {
    expect(gscRecrawlPriority('product.minor')).toBe(GSC_RECRAWL_MAX_PRIORITY);
    expect(gscRecrawlPriority('vendor.minor')).toBe(GSC_RECRAWL_MAX_PRIORITY);
    expect(gscRecrawlPriority('pair.updated')).toBe(GSC_RECRAWL_MAX_PRIORITY);
  });

  it('assigns every reason a tier inside the declared bounds', () => {
    // Exhaustiveness is enforced at the type level by the `Record<GscRecrawlReason, number>`
    // annotation. This asserts the VALUES, which the type cannot.
    for (const [reason, priority] of Object.entries(GSC_RECRAWL_PRIORITY)) {
      expect(Number.isInteger(priority), `${reason} is not an integer tier`).toBe(true);
      expect(priority).toBeGreaterThanOrEqual(GSC_RECRAWL_MIN_PRIORITY);
      expect(priority).toBeLessThanOrEqual(GSC_RECRAWL_MAX_PRIORITY);
    }
  });

  it('uses every tier, so none is dead vocabulary', () => {
    const used = new Set(Object.values(GSC_RECRAWL_PRIORITY));
    expect([...used].sort()).toEqual([1, 2, 3, 4]);
  });
});

// ─── In-batch dedupe ─────────────────────────────────────────────────────────

describe('dedupeByBestPriority', () => {
  it('keeps the most important reason when one promote reaches a URL twice', () => {
    const out = dedupeByBestPriority([
      { url: `${BASE}/products/a`, reason: 'product.minor' },
      { url: `${BASE}/products/a`, reason: 'product.created' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.reason).toBe<GscRecrawlReason>('product.created');
  });

  it('leaves distinct URLs alone and preserves walk order', () => {
    const out = dedupeByBestPriority([
      { url: `${BASE}/products/a`, reason: 'product.created' },
      { url: `${BASE}/vendors/v`, reason: 'vendor.created' },
    ]);
    expect(out.map((e) => e.url)).toEqual([`${BASE}/products/a`, `${BASE}/vendors/v`]);
  });
});

// ─── The conflict rule ───────────────────────────────────────────────────────

describe('enqueueGscRecrawl — the conflict rule', () => {
  it('RAISES priority when a more important event arrives', async () => {
    const url = `${BASE}/products/procore`;
    await enqueueGscRecrawl(t.db, [{ url, reason: 'product.minor' }], 'vendor');
    expect((await rowFor(url))!.priority).toBe(4);

    await enqueueGscRecrawl(t.db, [{ url, reason: 'product.updated' }], 'vendor');
    const row = await rowFor(url);
    expect(row!.priority).toBe(2);
    // The reason follows the priority, so the screen's "why" column explains the
    // tier the row is actually sorted at.
    expect(row!.reason).toBe('product.updated');
  });

  it('never LOWERS priority when a less important event arrives', async () => {
    const url = `${BASE}/products/procore`;
    await enqueueGscRecrawl(t.db, [{ url, reason: 'product.created' }], 'promote');
    await enqueueGscRecrawl(t.db, [{ url, reason: 'product.minor' }], 'vendor');

    const row = await rowFor(url);
    expect(row!.priority).toBe(1);
    expect(row!.reason).toBe('product.created');
    expect(row!.source).toBe('promote');
  });

  it('PRESERVES the original queued_at, so a busy page cannot starve an old one', async () => {
    const url = `${BASE}/products/procore`;
    const first = new Date('2026-09-01T00:00:00.000Z');
    const later = new Date('2026-09-09T00:00:00.000Z');

    await enqueueGscRecrawl(t.db, [{ url, reason: 'product.minor' }], 'vendor', () => first);
    await enqueueGscRecrawl(t.db, [{ url, reason: 'product.updated' }], 'vendor', () => later);

    expect((await rowFor(url))!.queuedAt).toBe(first.toISOString());
  });

  it('keeps one row per URL however many times it is queued', async () => {
    const url = `${BASE}/products/procore`;
    for (const reason of ['product.minor', 'product.updated', 'product.minor'] as const) {
      await enqueueGscRecrawl(t.db, [{ url, reason }], 'vendor');
    }
    expect(await countPendingGscRecrawl(t.db)).toBe(1);
  });

  it('writes nothing at all for an empty entry list', async () => {
    expect(await enqueueGscRecrawl(t.db, [], 'promote')).toBe(0);
    expect(await countPendingGscRecrawl(t.db)).toBe(0);
  });
});

// ─── The D1 bound-parameter cap ──────────────────────────────────────────────

describe('gscRecrawlInsertStatements — the 100-bound-parameter cap', () => {
  it('chunks at 20 rows, because this table binds five columns', () => {
    // 100 / 5 = 20. NOT 33, which is `indexnow_queue`'s three-column figure —
    // copying that constant across would bind 165 parameters and be rejected by
    // D1 while passing every spec in this repo.
    expect(GSC_RECRAWL_INSERT_ROWS_PER_STATEMENT).toBe(20);
  });

  it('emits at most 100 bound parameters per statement', () => {
    const entries = Array.from({ length: 47 }, (_, i) => ({
      url: `${BASE}/products/p${i}`,
      reason: 'product.created' as const,
    }));
    const stmts = gscRecrawlInsertStatements(t.db, entries, '2026-09-01T00:00:00.000Z', 'promote');

    expect(stmts).toHaveLength(3);
    for (const stmt of stmts) {
      const { params } = stmt.toSQL();
      expect(params.length).toBeLessThanOrEqual(100);
    }
  });

  it('lands every row across the chunk boundary', async () => {
    const entries = Array.from({ length: 47 }, (_, i) => ({
      url: `${BASE}/products/p${i}`,
      reason: 'product.created' as const,
    }));
    await enqueueGscRecrawl(t.db, entries, 'promote');
    expect(await countPendingGscRecrawl(t.db)).toBe(47);
  });
});

// ─── The worklist read ───────────────────────────────────────────────────────

describe('readPendingGscRecrawl', () => {
  it('returns priority first, then oldest first', async () => {
    await enqueueGscRecrawl(
      t.db,
      [{ url: `${BASE}/products/late`, reason: 'pair.updated' }],
      'promote',
      () => new Date('2026-09-01T00:00:00.000Z'),
    );
    await enqueueGscRecrawl(
      t.db,
      [{ url: `${BASE}/products/first`, reason: 'product.created' }],
      'promote',
      () => new Date('2026-09-05T00:00:00.000Z'),
    );

    const rows = await readPendingGscRecrawl(t.db);
    expect(rows.map((r) => r.url)).toEqual([`${BASE}/products/first`, `${BASE}/products/late`]);
  });
});
