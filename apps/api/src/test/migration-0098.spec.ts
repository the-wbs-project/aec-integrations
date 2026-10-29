import { describe, expect, it } from 'vitest';

import { makeTestDb, statementsForMigration, type TestDb } from './d1';

/**
 * AECI-1534 — `0098_claim_threads.sql`, private row threads
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §15.5).
 *
 *   1. The file is CREATE TABLE / CREATE INDEX only. It touches no existing table, so
 *      it cannot fire a cascade on `claims` or `profiles` (`docs/migrations.md` §3.3a).
 *   2. The three hand-written COLUMN CHECKs on `claim_threads` are in the live DDL and
 *      enforced. drizzle-kit cannot see them, so a recreate generated from `schema.ts`
 *      would drop them silently. This assertion is what notices.
 *
 * The FK actions and the child lists are pinned at HEAD in `d1.spec.ts`.
 */
const MIGRATION = '0098_claim_threads.sql';
const AT = '2026-10-29T00:00:00.000Z';

const stripComments = (stmt: string) =>
  stmt
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim();

async function seeded(): Promise<TestDb> {
  const t = await makeTestDb();
  for (const id of ['va', 'vb'])
    t.raw
      .prepare(
        `INSERT INTO vendors (id, slug, company_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, id, id, AT, AT);
  return t;
}

const insertThread = (t: TestDb, cols: Record<string, string | null>) => {
  const row = { id: 't1', vendor_a_id: 'va', vendor_b_id: 'vb', created_at: AT, ...cols };
  const names = Object.keys(row);
  t.raw
    .prepare(
      `INSERT INTO claim_threads (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    )
    .run(...Object.values(row));
};

describe(`${MIGRATION}`, () => {
  it('is CREATE TABLE and CREATE INDEX only', () => {
    const stmts = statementsForMigration(MIGRATION).map(stripComments);
    expect(stmts).toHaveLength(8);
    for (const stmt of stmts) expect(stmt).toMatch(/^CREATE (UNIQUE )?(TABLE|INDEX) /);
    expect(stmts.join('\n')).not.toMatch(/\b(DROP|ALTER|INSERT|PRAGMA|__new_)/);
  });

  it('keeps the three hand-written column CHECKs in the live DDL', async () => {
    const t = await makeTestDb();
    const { sql } = t.raw
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'claim_threads'`)
      .get() as { sql: string };
    expect(sql).toContain('CONSTRAINT "claim_threads_distinct_vendors_check"');
    expect(sql).toContain('CONSTRAINT "claim_threads_closed_pair_check"');
    expect(sql).toContain(
      `CONSTRAINT "claim_threads_closed_reason_check" CHECK ("closed_reason" IN ('retired', 'withdrawn', 'claim_removed', 'not_attestable'))`,
    );
    t.dispose();
  });

  it('accepts every §15.10 close reason with a close time', async () => {
    for (const reason of ['retired', 'withdrawn', 'claim_removed', 'not_attestable']) {
      const t = await seeded();
      expect(() => insertThread(t, { closed_at: AT, closed_reason: reason })).not.toThrow();
      t.dispose();
    }
  });

  it('rejects an unknown reason, a half-closed thread and a single-company thread', async () => {
    const t = await seeded();
    expect(() => insertThread(t, { closed_at: AT, closed_reason: 'expired' })).toThrow(
      /closed_reason_check/,
    );
    expect(() => insertThread(t, { closed_at: AT })).toThrow(/closed_pair_check/);
    expect(() => insertThread(t, { closed_reason: 'retired' })).toThrow(/closed_pair_check/);
    expect(() => insertThread(t, { vendor_b_id: 'va' })).toThrow(/distinct_vendors_check/);
    expect(() => insertThread(t, {})).not.toThrow();
    t.dispose();
  });
});
