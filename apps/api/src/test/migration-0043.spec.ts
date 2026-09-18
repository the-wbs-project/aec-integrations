import { INTEGRATION_CONTEST_FIELDS } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { integrations, products, vendors } from '../db/schema';

import { makeTestDb, statementsForMigration } from './d1';

/**
 * AECI-1008 — `0043_needy_hobgoblin.sql`, the `integration_field_challenges`
 * table. Purely additive: one CREATE TABLE and four CREATE INDEXes, touching no
 * existing table. The tripwire is on that property, because the next edit to the
 * contest vocabulary is a CHECK change and therefore a recreate of THIS table.
 *
 * It also pins the CHECK to the wire list. The two are separate spellings of one
 * vocabulary (`INTEGRATION_CONTEST_FIELDS` in `@aeci/shared` and the D1 CHECK),
 * and nothing derives one from the other.
 */
const MIGRATION = '0043_needy_hobgoblin.sql';

describe(`${MIGRATION} — additive`, () => {
  it('only creates; it alters, drops and recreates nothing', () => {
    const statements = statementsForMigration(MIGRATION);
    expect(statements).toHaveLength(5);
    expect(statements[0]).toMatch(/^CREATE TABLE `integration_field_challenges`/);
    for (const s of statements.slice(1)) {
      expect(s).toMatch(/^CREATE (UNIQUE )?INDEX `integration_field_challenges_/);
    }
    for (const s of statements) {
      expect(s).not.toMatch(/DROP TABLE|ALTER TABLE|__new_|INSERT INTO/i);
    }
  });

  it('keeps the field CHECK in lockstep with INTEGRATION_CONTEST_FIELDS', async () => {
    const t = await makeTestDb();
    try {
      const ddl = (
        t.raw
          .prepare(
            `SELECT sql FROM sqlite_master WHERE type='table' AND name='integration_field_challenges'`,
          )
          .get() as { sql: string }
      ).sql;
      const check = /"field" IN \(([^)]*)\)/.exec(ddl)?.[1] ?? '';
      const inCheck = check
        .split(',')
        .map((v) => v.trim().replace(/^'|'$/g, ''))
        .sort();
      expect(inCheck).toEqual([...INTEGRATION_CONTEST_FIELDS].sort());
    } finally {
      t.dispose();
    }
  });

  it('enforces one OPEN contest per (integration, field, vendor) and nothing more', async () => {
    const t = await makeTestDb();
    try {
      await t.db.insert(vendors).values({ id: 'v1', slug: 'v', companyName: 'V' });
      await t.db.insert(products).values([
        { id: 'p1', slug: 'a', name: 'A' },
        { id: 'p2', slug: 'b', name: 'B' },
      ]);
      await t.db
        .insert(integrations)
        .values({ id: 'i1', sourceProductId: 'p1', targetProductId: 'p2' });
      const insert = (id: string, status: string) =>
        t.raw
          .prepare(
            `INSERT INTO integration_field_challenges
               (id, integration_id, field, reason, submitter_vendor_id, routed_to, status, created_at, updated_at)
             VALUES (?, 'i1', 'name', 'r', 'v1', 'aeci', ?, '2026-01-01', '2026-01-01')`,
          )
          .run(id, status);
      insert('c1', 'declined');
      insert('c2', 'withdrawn');
      insert('c3', 'open');
      expect(() => insert('c4', 'open')).toThrow(/UNIQUE constraint failed/);
      expect(() => insert('c5', 'pending')).toThrow(/CHECK constraint failed/);
    } finally {
      t.dispose();
    }
  });
});
