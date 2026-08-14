/**
 * The §2.4 entitlement-backfill builders (AECI-609), exercised against the in-memory
 * harness's RAW SQLite handle — real migrations, real unique index, so idempotency and
 * the `NOT EXISTS` guard are genuinely proven rather than string-matched.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';
import {
  BACKFILL_NOTES,
  buildBackfillStatements,
  buildForwardDriftSql,
  buildReverseDriftSql,
  formatBackfillReport,
  type DriftedVendorRow,
  type ReverseDriftRow,
} from './backfill-entitlements';

const NOW = '2026-08-14T12:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function seedVendor(id: string, slug: string, name: string, verified: 0 | 1) {
  t.raw
    .prepare(
      'INSERT INTO vendors (id, slug, company_name, verified, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(id, slug, name, verified, NOW, NOW);
}

function seedEntitlement(vendorId: string, status: string) {
  t.raw
    .prepare(
      'INSERT INTO vendor_entitlements (id, vendor_id, tier, status, granted_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(`e-${vendorId}`, vendorId, 'verified', status, NOW, NOW, NOW);
}

/** The builders emit one complete statement each, so `prepare().run()` applies them. */
const runSql = (sql: string) => t.raw.prepare(sql).run();

const forwardDrift = () => t.raw.prepare(buildForwardDriftSql()).all() as DriftedVendorRow[];
const reverseDrift = () => t.raw.prepare(buildReverseDriftSql()).all() as ReverseDriftRow[];

describe('buildForwardDriftSql', () => {
  it('finds verified vendors with no entitlement row, and only those', () => {
    seedVendor('v1', 'autodesk', 'Autodesk', 1); // drifted — needs a row
    seedVendor('v2', 'procore', 'Procore', 1);
    seedEntitlement('v2', 'active'); // already covered
    seedVendor('v3', 'bluebeam', 'Bluebeam', 0); // unclaimed baseline
    seedVendor('v4', 'trimble', 'Trimble', 1);
    seedEntitlement('v4', 'revoked'); // has a row, just not active — NOT this script's job

    expect(forwardDrift().map((r) => r.slug)).toEqual(['autodesk']);
  });
});

describe('buildReverseDriftSql', () => {
  it('finds active entitlements on unverified vendors', () => {
    seedVendor('v1', 'autodesk', 'Autodesk', 0);
    seedEntitlement('v1', 'active'); // reverse drift
    seedVendor('v2', 'bluebeam', 'Bluebeam', 0);
    seedEntitlement('v2', 'revoked'); // in sync — lapsed, mirror cleared
    seedVendor('v3', 'procore', 'Procore', 1);
    seedEntitlement('v3', 'active'); // in sync

    expect(reverseDrift().map((r) => r.slug)).toEqual(['autodesk']);
  });
});

describe('buildBackfillStatements', () => {
  it('inserts a perpetual, termless active row and clears the forward drift', () => {
    seedVendor('v1', 'autodesk', 'Autodesk', 1);
    seedVendor('v2', 'procore', 'Procore', 1);

    const rows = forwardDrift();
    expect(rows).toHaveLength(2);

    for (const sql of buildBackfillStatements(rows, { now: NOW, ids: ['e1', 'e2'] })) runSql(sql);

    expect(forwardDrift()).toEqual([]);

    const ents = t.raw
      .prepare('SELECT * FROM vendor_entitlements ORDER BY vendor_id')
      .all() as Array<Record<string, unknown>>;
    expect(ents).toHaveLength(2);
    for (const e of ents) {
      expect(e.status).toBe('active');
      expect(e.tier).toBe('verified');
      expect(e.notes).toBe(BACKFILL_NOTES);
      // Perpetual + termless, so the partial expiry index ignores them and the §7
      // cron never warns about a backfilled arrangement.
      expect(e.period_start).toBeNull();
      expect(e.period_end).toBeNull();
      expect(e.granted_by).toBeNull();
    }
  });

  it('never writes vendors.verified', () => {
    seedVendor('v1', 'autodesk', 'Autodesk', 1);
    const before = t.raw.prepare('SELECT verified, updated_at FROM vendors').get();

    for (const sql of buildBackfillStatements(forwardDrift(), { now: NOW, ids: ['e1'] })) {
      runSql(sql);
    }

    // Same row, untouched — the mirror is only ever moved by lib/vendor-entitlement.ts.
    expect(t.raw.prepare('SELECT verified, updated_at FROM vendors').get()).toEqual(before);
  });

  it('is idempotent: re-running the same statements is a no-op, not a unique-index error', () => {
    seedVendor('v1', 'autodesk', 'Autodesk', 1);
    const stmts = buildBackfillStatements(forwardDrift(), { now: NOW, ids: ['e1'] });

    for (const sql of stmts) runSql(sql);
    // Replay the SAME statements — the `WHERE NOT EXISTS` re-guard absorbs them, so a
    // half-finished run can simply be re-run rather than needing manual cleanup.
    for (const sql of stmts) expect(() => runSql(sql)).not.toThrow();

    expect(
      (t.raw.prepare('SELECT count(*) AS n FROM vendor_entitlements').get() as { n: number }).n,
    ).toBe(1);
  });

  it('escapes literals so a company name with an apostrophe cannot break the statement', () => {
    seedVendor("v'1", "o'brien", "O'Brien & Sons", 1);

    for (const sql of buildBackfillStatements(forwardDrift(), { now: NOW, ids: ["e'1"] })) {
      expect(() => runSql(sql)).not.toThrow();
    }
    expect(forwardDrift()).toEqual([]);
  });

  it('refuses a rows/ids length mismatch rather than silently skipping', () => {
    expect(() =>
      buildBackfillStatements([{ id: 'v1', slug: 's', company_name: 'C' }], {
        now: NOW,
        ids: [],
      }),
    ).toThrow(/one id per row/);
  });
});

describe('formatBackfillReport', () => {
  it('reports a clean tier', () => {
    const out = formatBackfillReport([], []);
    expect(out).toContain('Forward drift (verified = 1, no entitlement row): 0');
    expect(out).toContain('every verified vendor already has a row');
  });

  it('names reverse drift and states plainly that it is not repaired here', () => {
    const out = formatBackfillReport(
      [{ id: 'v1', slug: 'autodesk', company_name: 'Autodesk' }],
      [{ id: 'v2', slug: 'procore', company_name: 'Procore', status: 'active' }],
    );
    expect(out).toContain('+ Autodesk (autodesk)');
    expect(out).toContain("! Procore (procore) — entitlement 'active'");
    expect(out).toContain('never writes vendors.verified');
  });
});
